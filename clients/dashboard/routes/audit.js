const { Router } = require('express');
const { requireAdmin, requireAuth } = require('../../../middleware/auth');
const { fetchLawsuits, fetchTransactions } = require('../../../services/data');
const cache = require('../../../cache');
const { query: dbQuery } = require('../../../services/db');
const { sendWhatsApp } = require('../../../services/chatguru-sender');
const { runAudit } = require('../../../services/auditor');
const { advboxUserIdFromSession } = require('../../../services/team-users');
const { config } = require('../../../config');
const { dateInMes } = require('../../../services/date-utils');
const {
  normalizeStage:        audrNorm,           // mesma assinatura da função antiga
  getResponsavelZone:    audrZoneForStage,
  getResponsavelZonesMulti: audrMultiZonesForStage,
  isStageSkippedForResponsavel,
  getZoneForResp:        audrZoneForResp,
  ZONE_LABELS:           AUDR_ZONE_LABEL,
} = require('../../../services/audit-rules');

const router = Router();

// ── Auditoria de Uso (cadastro + workflow) ───────────────────────────────────
// GET /api/audit/usage
//   Admin: vê tudo
//   Team:  vê só problemas do próprio advboxUserId (filtrado server-side)
//
// Query params:
//   force=1   → ignora cache, re-busca da API AdvBox
//   tipo=     → filtra (cliente|processo|tarefa|workflow)
//   nivel=    → filtra (erro|aviso)

cache.define('audit_usage', 30 * 60 * 1000); // 30 min

router.get('/audit/usage', requireAuth, async (req, res, next) => {
  try {
    const force = req.query.force === '1';
    const tipo  = req.query.tipo  || null;
    const nivel = req.query.nivel || null;

    const data = await cache.getOrFetch('audit_usage', () => runAudit({ force }), force);

    const advboxUserId    = advboxUserIdFromSession(req.session.user);
    const advboxUserIdNum = advboxUserId ? Number(advboxUserId) : null;
    const isAdmin         = req.session.user.role === 'admin';

    // Filtra problemas
    let problemas = data.problemas;
    if (!isAdmin && advboxUserIdNum) {
      problemas = problemas.filter(p => Number(p.user_id) === advboxUserIdNum);
    }
    if (tipo)  problemas = problemas.filter(p => p.tipo === tipo);
    if (nivel) problemas = problemas.filter(p => p.nivel === nivel);

    // Filtra resumo por usuário
    let porUsuario = data.porUsuario;
    if (!isAdmin && advboxUserIdNum) {
      porUsuario = porUsuario.filter(u => Number(u.user_id) === advboxUserIdNum);
    }

    res.json({
      resumo:    { ...data.resumo, total_problemas_filtrados: problemas.length },
      problemas,
      porUsuario,
      geradoEm:  data.geradoEm,
      escopo:    isAdmin ? 'todos' : `apenas ${req.session.user.name || req.session.user.username}`,
    });
  } catch (err) {
    next(err);
  }
});

// ── Kanban Financeiro ────────────────────────────────────────────────────────

const FASES_COBRANCA = ['Salario Maternidade Parcelado', 'Judicial Parcelado', 'Adm Parcelado'];
const FASES_MONITOR  = ['Rpv do Mes', 'Judicial Implantado a Receber', 'Adm Implantado a Receber', 'Salario Maternidade Concedido'];

function normFase(s) { return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim(); }
function matchFase(stage, list) { const st = normFase(stage); return list.some(f => { const fn = normFase(f); return st === fn || st.includes(fn) || fn.includes(st); }); }

router.get('/audit/kanban-financeiro', async (req, res, next) => {
  const now    = Date.now();
  const today  = new Date();
  const defMes = String(today.getMonth() + 1).padStart(2, '0') + '/' + today.getFullYear();
  const mes    = req.query.mes || defMes;
  const key    = `kanban:${mes}`;
  cache.define(key, 30 * 60 * 1000);

  try {
    const data = await cache.getOrFetch(key, async () => {
      const [lawsuits, transactions] = await Promise.all([fetchLawsuits(), fetchTransactions()]);

      // Regime de caixa: considera "do mês" se houver date_payment OU date_due no mês.
      // (Antes filtrava por t.competence === mes, gerando falsos críticos quando
      // a parcela tinha competência de outro mês mas foi paga/vence no mês alvo.)
      const [mm, yyyy] = mes.split('/').map(Number);
      const matchesMes = (dateStr) => dateInMes(dateStr, mm, yyyy);
      const txDoMes = transactions.filter(t =>
        t.entry_type === 'income' && (matchesMes(t.date_payment) || matchesMes(t.date_due))
      );
      const txByLaw = {}, lastTx = {};

      txDoMes.forEach(t => { const lid = String(t.lawsuits_id || t.lawsuit_id || ''); if (!lid) return; if (!txByLaw[lid]) txByLaw[lid] = []; txByLaw[lid].push(t); });
      transactions.filter(t => t.entry_type === 'income').forEach(t => {
        const lid = String(t.lawsuits_id || t.lawsuit_id || ''); if (!lid) return;
        const ex = lastTx[lid]; const dt = t.date_payment || t.date_due || '';
        if (!ex || dt > (ex.date_payment || ex.date_due || '')) lastTx[lid] = t;
      });

      // ── Fallback por cliente (vincula transações "soltas" via nome) ──────────
      // Cau às vezes lança a parcela preenchendo só "Pessoa" no AdvBox sem
      // selecionar o lawsuit específico — lawsuits_id fica null. Match real é
      // por NOME (transação tem campo `name`, lawsuit.customers[].name).
      // Só atribui quando há um único lawsuit parcelado pra esse cliente.
      const normNome = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g,'')
        .toUpperCase().replace(/[^A-Z0-9 ]/g,' ').replace(/\s+/g,' ').trim();

      const clientesDoLawsuit = (l) => (l.customers || [])
        .filter(c => (c.origin || '').toUpperCase() !== 'PARTE CONTRÁRIA' &&
                     (c.origin || '').toUpperCase() !== 'PARTE CONTRARIA')
        .map(c => normNome(c.name));

      const lawsByCustomerName = new Map(); // nome -> [lawsuit_id]
      for (const l of lawsuits) {
        if (!matchFase(l.stage || l.step || '', FASES_COBRANCA)) continue;
        for (const cName of clientesDoLawsuit(l)) {
          if (!cName) continue;
          if (!lawsByCustomerName.has(cName)) lawsByCustomerName.set(cName, []);
          lawsByCustomerName.get(cName).push(String(l.id));
        }
      }

      const txDoMesByCustomerName = {}; // nome -> [transactions sem lawsuits_id]
      txDoMes.forEach(t => {
        if (t.lawsuits_id || t.lawsuit_id) return; // só "soltas"
        const txName = normNome(t.name || t.customer_name || '');
        if (!txName) return;
        if (!txDoMesByCustomerName[txName]) txDoMesByCustomerName[txName] = [];
        txDoMesByCustomerName[txName].push(t);
      });

      const criticos = [], monitoramento = [], ok = [];

      for (const l of lawsuits) {
        const stage      = l.stage || l.step || '';
        const isCobranca = matchFase(stage, FASES_COBRANCA);
        const isMonitor  = matchFase(stage, FASES_MONITOR);
        if (!isCobranca && !isMonitor) continue;

        const clientsArr = Array.isArray(l.customers) ? l.customers : [];
        const personal   = clientsArr.find(c => c.name && !/INSS|INSTITUTO NACIONAL|PREVIDENCIA|ESTADO|MUNICIPIO|UNIAO FEDERAL/i.test((c.name || '').toUpperCase()));
        const cliente    = (personal || clientsArr[0] || {}).name || `#${l.id}`;
        const stageAt    = l.stage_date || l.stage_at || l.updated_at || l.created_at || '';
        const diasNaFase = stageAt ? Math.max(0, Math.floor((now - new Date(stageAt).getTime()) / 86400000)) : null;
        const feesRaw    = parseFloat(String(l.fees_money || '0').replace(/[^0-9.,]/g, '').replace(',', '.')) || 0;
        // RPV do Mês usa valor uniforme (piso federal). Override via env RPV_VALOR_FIXO_MES.
        const feesValue  = normFase(stage) === 'RPV DO MES' ? config.rpv.valorFixoMes : feesRaw;
        const lawId      = String(l.id || l.lawsuits_id || '');
        const cpfCnpj    = String(personal?.identification || '').replace(/\D/g, '');

        const entry = { lawsuitId: lawId, cliente, processo: l.process_number || `#${lawId}`, fase: stage, diasNaFase, valorFees: feesValue, responsavel: l.responsible || '', linkAdvBox: `https://app.advbox.com.br/lawsuits/${lawId}`, cpfCnpj };

        if (isCobranca) {
          let txMes = txByLaw[lawId] || []; const lTx = lastTx[lawId];
          let viaFallback = null;

          // Fallback por NOME do cliente — só se o cliente tem APENAS este lawsuit
          // em fase parcelada (evita falso positivo quando há ambiguidade).
          // Ignora customers com origin "PARTE CONTRÁRIA".
          if (!txMes.length) {
            for (const cName of clientesDoLawsuit(l)) {
              if (!cName) continue;
              const lawsDoCliente = lawsByCustomerName.get(cName) || [];
              if (lawsDoCliente.length === 1 && lawsDoCliente[0] === lawId) {
                const soltos = txDoMesByCustomerName[cName] || [];
                if (soltos.length) {
                  txMes = soltos;
                  viaFallback = cName;
                  break;
                }
              }
            }
          }

          if (!txMes.length) {
            criticos.push({ ...entry, ultimoLancamento: lTx ? (lTx.date_payment || lTx.date_due || null) : null, ultimoValor: lTx ? Number(lTx.amount || 0) : null, motivo: `Em fase parcelada, sem lançamento em ${mes}` });
          } else {
            ok.push({
              ...entry,
              lancamentosDoMes: txMes.length,
              totalDoMes: txMes.reduce((s, t) => s + Number(t.amount || 0), 0),
              ...(viaFallback ? { aviso: `Lançamento vinculado via cliente (transação sem lawsuits_id). Recomendado vincular ao processo no AdvBox.` } : {}),
            });
          }
        } else { monitoramento.push(entry); }
      }

      criticos.sort((a, b) => (b.diasNaFase || 0) - (a.diasNaFase || 0));
      monitoramento.sort((a, b) => (b.diasNaFase || 0) - (a.diasNaFase || 0));

      const result = { mes, criticos, monitoramento, ok, resumo: { totalProcessosAuditados: criticos.length + monitoramento.length + ok.length, criticosCount: criticos.length, monitoramentoCount: monitoramento.length, okCount: ok.length, valorTotalCriticos: criticos.reduce((s, c) => s + (c.ultimoValor || 0), 0), valorTotalMonitoramento: monitoramento.reduce((s, c) => s + (c.valorFees || 0), 0) }, cachedAt: new Date().toISOString() };
      console.log(`[Kanban] ${mes}: ${criticos.length} críticos | ${monitoramento.length} monitor | ${ok.length} ok`);
      return result;
    }, req.query.force === '1');

    res.json(data);
  } catch (err) { next(err); }
});

// ── Cobrar Cau via WhatsApp (ChatGuru) ───────────────────────────────────────
// POST /api/audit/cobrar-cau-whatsapp?mes=MM/YYYY
// Pega críticos do mês, monta mensagem e envia via ChatGuru pra CAU_PHONE
router.post('/audit/cobrar-cau-whatsapp', requireAdmin, async (req, res, next) => {
  try {
    const cauPhone = process.env.CAU_PHONE || '';
    if (!cauPhone) {
      return res.status(400).json({
        error: 'CAU_PHONE não configurado',
        hint:  'Adicione CAU_PHONE nos Secrets do Replit (formato: 5581999999999 ou 81999999999)',
      });
    }

    const today  = new Date();
    const defMes = String(today.getMonth() + 1).padStart(2, '0') + '/' + today.getFullYear();
    const mes    = req.query.mes || req.body?.mes || defMes;

    // Reusa a lógica do kanban-financeiro (cache 30 min) pra obter os críticos
    const cacheKey = `kanban:${mes}`;
    cache.define(cacheKey, 30 * 60 * 1000);

    const data = await cache.getOrFetch(cacheKey, async () => {
      const [lawsuits, transactions] = await Promise.all([fetchLawsuits(), fetchTransactions()]);
      const [mm, yyyy] = mes.split('/').map(Number);
      const matchesMes = (s) => dateInMes(s, mm, yyyy);
      const txDoMes = transactions.filter(t =>
        t.entry_type === 'income' && (matchesMes(t.date_payment) || matchesMes(t.date_due))
      );
      const txByLaw = {}, lastTx = {};
      txDoMes.forEach(t => { const lid = String(t.lawsuits_id || t.lawsuit_id || ''); if (!lid) return; if (!txByLaw[lid]) txByLaw[lid] = []; txByLaw[lid].push(t); });
      transactions.filter(t => t.entry_type === 'income').forEach(t => {
        const lid = String(t.lawsuits_id || t.lawsuit_id || ''); if (!lid) return;
        const ex = lastTx[lid]; const dt = t.date_payment || t.date_due || '';
        if (!ex || dt > (ex.date_payment || ex.date_due || '')) lastTx[lid] = t;
      });
      const criticos = [];
      for (const l of lawsuits) {
        const stage = l.stage || l.step || '';
        if (!matchFase(stage, FASES_COBRANCA)) continue;
        const lawId = String(l.id || l.lawsuits_id || '');
        const txMes = txByLaw[lawId] || [];
        if (txMes.length) continue;
        const clientsArr = Array.isArray(l.customers) ? l.customers : [];
        const personal = clientsArr.find(c => c.name && !/INSS|INSTITUTO NACIONAL|PREVIDENCIA|ESTADO|MUNICIPIO|UNIAO FEDERAL/i.test((c.name || '').toUpperCase()));
        const cliente = (personal || clientsArr[0] || {}).name || `#${l.id}`;
        const lTx = lastTx[lawId];
        criticos.push({
          fase: stage,
          cliente,
          ultimoLancamento: lTx ? (lTx.date_payment || lTx.date_due || null) : null,
          ultimoValor: lTx ? Number(lTx.amount || 0) : null,
        });
      }
      return { criticos };
    }, false);

    const criticos = data.criticos || [];
    if (!criticos.length) return res.json({ ok: true, sent: false, reason: 'Sem críticos para cobrar' });

    // Monta mensagem agrupada por fase
    const byFase = {};
    criticos.forEach(c => { (byFase[c.fase] = byFase[c.fase] || []).push(c); });

    const fmtBR = (s) => {
      if (!s) return null;
      if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) return s.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        const [y, m, d] = s.slice(0, 10).split('-');
        return `${d}/${m}/${y}`;
      }
      return s;
    };
    const fmtBRL = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    let msg = `Oi Cau!\n\n${criticos.length} processo${criticos.length > 1 ? 's' : ''} no seu CRM mas sem lançamento em ${mes}.\nPode dar uma olhada?\n`;
    Object.entries(byFase).forEach(([fase, lista]) => {
      msg += `\n*${fase}* (${lista.length})\n`;
      lista.forEach((c, i) => {
        const ult = c.ultimoLancamento
          ? ` (último: ${fmtBR(c.ultimoLancamento)}${c.ultimoValor ? ' — ' + fmtBRL(c.ultimoValor) : ''})`
          : ' (sem lançamentos anteriores)';
        msg += `${i + 1}. ${c.cliente}${ult}\n`;
      });
    });

    const result = await sendWhatsApp(cauPhone, msg);
    res.json({ ok: true, sent: true, count: criticos.length, mes, messageId: result.messageId });
  } catch (err) {
    console.error('[cobrar-cau-whatsapp] erro:', err.message);
    res.status(500).json({ error: err.message, body: err.body });
  }
});

// ── Auditoria de Responsável ─────────────────────────────────────────────────

// ── Regras de zona/responsável ────────────────────────────────────────────────
// FONTE ÚNICA: services/audit-rules.js (importado no topo do arquivo).
// Quando precisar mudar zona ou skip de fase, editar APENAS lá.
// As constantes locais abaixo foram REMOVIDAS — agora vêm via require alias.

cache.define('audit-responsible', 20 * 60 * 1000);

router.get('/audit-responsible', requireAdmin, async (req, res, next) => {
  try {
    const data = await cache.getOrFetch('audit-responsible', async () => {
      const rawData  = await fetchLawsuits(true);
      const lawsuits = Array.isArray(rawData) ? rawData : (rawData.data || []);
      const items = [], byPerson = {}, byStage = {};
      let totalAuditados = 0, totalCorretos = 0, totalErrados = 0, totalNaoMapeados = 0;

      for (const l of lawsuits) {
        const stage        = l.stage || l.step || '';
        const responsible  = l.responsible || '';
        if (isStageSkippedForResponsavel(stage)) continue;
        const expectedZone = audrZoneForStage(stage);
        const actualZone   = audrZoneForResp(responsible);
        const clienteNome  = (Array.isArray(l.customers) && l.customers[0]?.name) || '—';

        const multiZones = audrMultiZonesForStage(stage);
        let status, expectedZoneDisplay, expectedRespLabelDisplay;

        if (multiZones) {
          // Fase válida para múltiplas zonas
          totalAuditados++;
          const isCorrect = actualZone && multiZones.includes(actualZone);
          status = isCorrect ? 'CORRETO' : 'ERRADO';
          expectedZoneDisplay    = multiZones[0]; // zona principal para exibição
          expectedRespLabelDisplay = multiZones.map(z => AUDR_ZONE_LABEL[z]).join(' ou ');
          if (isCorrect) { totalCorretos++; }
          else {
            totalErrados++;
            const rk = responsible || '(sem responsável)';
            if (!byPerson[rk]) byPerson[rk] = { responsible: rk, total: 0, correto: 0, errado: 0, errosPorZona: {} };
            byPerson[rk].total++; byPerson[rk].errado++;
            byPerson[rk].errosPorZona[expectedZoneDisplay] = (byPerson[rk].errosPorZona[expectedZoneDisplay] || 0) + 1;
            const sk = audrNorm(stage);
            if (!byStage[sk]) byStage[sk] = { stage, expectedZone: expectedZoneDisplay, total: 0, errado: 0, respAtualMap: {} };
            byStage[sk].total++; byStage[sk].errado++;
            byStage[sk].respAtualMap[responsible] = (byStage[sk].respAtualMap[responsible] || 0) + 1;
          }
        } else if (!expectedZone) {
          status = 'NAO_MAPEADO'; totalNaoMapeados++;
          expectedZoneDisplay = null; expectedRespLabelDisplay = null;
        } else {
          totalAuditados++;
          const isCorrect = expectedZone === 'LETICIA_OU_ALICE' ? actualZone === 'LETICIA_OU_ALICE' : actualZone === expectedZone;
          status = isCorrect ? 'CORRETO' : 'ERRADO';
          expectedZoneDisplay = expectedZone;
          expectedRespLabelDisplay = AUDR_ZONE_LABEL[expectedZone];
          if (isCorrect) { totalCorretos++; }
          else {
            totalErrados++;
            const rk = responsible || '(sem responsável)';
            if (!byPerson[rk]) byPerson[rk] = { responsible: rk, total: 0, correto: 0, errado: 0, errosPorZona: {} };
            byPerson[rk].total++; byPerson[rk].errado++;
            byPerson[rk].errosPorZona[expectedZone] = (byPerson[rk].errosPorZona[expectedZone] || 0) + 1;
            const sk = audrNorm(stage);
            if (!byStage[sk]) byStage[sk] = { stage, expectedZone, total: 0, errado: 0, respAtualMap: {} };
            byStage[sk].total++; byStage[sk].errado++;
            byStage[sk].respAtualMap[responsible] = (byStage[sk].respAtualMap[responsible] || 0) + 1;
          }
        }
        items.push({ id: l.id, cliente: clienteNome, numero: l.code || l.process_number || '', tipo: l.type || '', stage, responsible, expectedZone: expectedZoneDisplay, expectedRespLabel: expectedRespLabelDisplay, actualZone: actualZone || null, status, link: `https://app.advbox.com.br/lawsuit/${l.id}` });
      }

      const byPersonArr = Object.values(byPerson).sort((a, b) => b.errado - a.errado);
      const byStageArr  = Object.values(byStage).map(s => ({ stage: s.stage, expectedZone: s.expectedZone, errado: s.errado, respMaisComum: Object.entries(s.respAtualMap).sort((a, b) => b[1] - a[1])[0]?.[0] || '—', responsavelEsperado: AUDR_ZONE_LABEL[s.expectedZone] || s.expectedZone })).sort((a, b) => b.errado - a.errado);
      const taxaAcerto  = totalAuditados > 0 ? Math.round(totalCorretos / totalAuditados * 100) : 100;

      console.log(`[Audit-Resp] ${totalAuditados} auditados | ${totalErrados} erros | ${taxaAcerto}%`);
      return { items, summary: { totalAuditados, totalCorretos, totalErrados, totalNaoMapeados, taxaAcerto }, byPerson: byPersonArr, byStage: byStageArr, computedAt: new Date().toISOString() };
    }, req.query.force === '1');

    res.json(data);
  } catch (err) { next(err); }
});

// ── Marcar processo como passado ─────────────────────────────────────────────
router.post('/audit-responsible/resolve', requireAdmin, async (req, res, next) => {
  try {
    const { lawsuitId, cliente, fase, responsible, destinoZone, destinoLabel } = req.body || {};
    if (!lawsuitId) return res.status(400).json({ error: 'lawsuitId obrigatório' });
    await dbQuery(
      `INSERT INTO audit_resolved (lawsuit_id, cliente, fase, responsible, destino_zone, destino_label)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [String(lawsuitId), cliente || '', fase || '', responsible || '', destinoZone || '', destinoLabel || '']
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Registrar geração de lista de cobrança ───────────────────────────────────
router.post('/audit-responsible/cobranca-log', requireAdmin, async (req, res, next) => {
  try {
    const { personName, quantidade, detalhes } = req.body || {};
    if (!personName) return res.status(400).json({ error: 'personName obrigatório' });
    await dbQuery(
      `INSERT INTO audit_cobranca_log (person_name, quantidade, detalhes) VALUES ($1, $2, $3)`,
      [personName, Number(quantidade) || 0, detalhes || '']
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Histórico (resolvidos + cobranças) ───────────────────────────────────────
router.get('/audit-responsible/history', requireAdmin, async (req, res, next) => {
  try {
    const [resolved, cobrancas] = await Promise.all([
      dbQuery(`SELECT * FROM audit_resolved ORDER BY resolved_at DESC LIMIT 200`),
      dbQuery(`SELECT * FROM audit_cobranca_log ORDER BY logged_at DESC LIMIT 100`)
    ]);
    res.json({ resolved: resolved.rows, cobrancas: cobrancas.rows });
  } catch (err) { next(err); }
});

router.get('/audit-debug-stages', requireAdmin, async (req, res, next) => {
  try {
    const rawData  = await fetchLawsuits();
    const lawsuits = Array.isArray(rawData) ? rawData : (rawData.data || []);
    const counts   = {};
    for (const l of lawsuits) {
      if (l.status_closure) continue;
      const stage = (l.stage || l.step || '').trim();
      counts[stage] = (counts[stage] || 0) + 1;
    }
    const stages = Object.entries(counts).map(([stage, count]) => ({ stage, count })).sort((a, b) => b.count - a.count);
    res.json({ total: lawsuits.filter(l => !l.status_closure).length, stages });
  } catch (err) { next(err); }
});

module.exports = router;
