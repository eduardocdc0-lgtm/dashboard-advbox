const { Router } = require('express');
const { requireAdmin } = require('../../../middleware/auth');
const { fetchLawsuits, fetchTransactions } = require('../../../services/data');
const cache = require('../../../cache');
const { query: dbQuery } = require('../../../services/db');

const router = Router();

// ── Kanban Financeiro ────────────────────────────────────────────────────────

const FASES_COBRANCA = ['Salario Maternidade Parcelado', 'Judicial Parcelado', 'Adm Parcelado', 'Rpv do Mês'];
const FASES_MONITOR  = ['Rpv do Proximo Mês', 'Judicial Implantado a Receber', 'Adm Implantado a Receber', 'Salario Maternidade Concedido'];

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
      const txDoMes = transactions.filter(t => t.entry_type === 'income' && t.competence === mes);
      const txByLaw = {}, lastTx = {};

      txDoMes.forEach(t => { const lid = String(t.lawsuits_id || t.lawsuit_id || ''); if (!lid) return; if (!txByLaw[lid]) txByLaw[lid] = []; txByLaw[lid].push(t); });
      transactions.filter(t => t.entry_type === 'income').forEach(t => {
        const lid = String(t.lawsuits_id || t.lawsuit_id || ''); if (!lid) return;
        const ex = lastTx[lid]; const dt = t.date_payment || t.date_due || '';
        if (!ex || dt > (ex.date_payment || ex.date_due || '')) lastTx[lid] = t;
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
        const feesValue  = parseFloat(String(l.fees_money || '0').replace(/[^0-9.,]/g, '').replace(',', '.')) || 0;
        const lawId      = String(l.id || l.lawsuits_id || '');

        const entry = { lawsuitId: lawId, cliente, processo: l.process_number || `#${lawId}`, fase: stage, diasNaFase, valorFees: feesValue, responsavel: l.responsible || '', linkAdvBox: `https://app.advbox.com.br/lawsuits/${lawId}` };

        if (isCobranca) {
          const txMes = txByLaw[lawId] || []; const lTx = lastTx[lawId];
          if (!txMes.length) criticos.push({ ...entry, ultimoLancamento: lTx ? (lTx.date_payment || lTx.date_due || null) : null, ultimoValor: lTx ? Number(lTx.amount || 0) : null, motivo: `Em fase parcelada, sem lançamento em ${mes}` });
          else ok.push({ ...entry, lancamentosDoMes: txMes.length, totalDoMes: txMes.reduce((s, t) => s + Number(t.amount || 0), 0) });
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

// ── Auditoria de Responsável ─────────────────────────────────────────────────

const AUDR_SKIP_STAGES = ['IGNORAR ESSA ETAPA'];

const AUDR_ZONES = {
  MARILIA:          ['PROCESSOS SEM LAUDOS','PERICIA MARCADA SEM DATA DE AUDIENCIA','PARA DAR ENTRADA','PROTOCOLADO ADM','PROTOCOLADO','AUXILIO INCAPACIDADE','PROCESSO COM GUARDA BPC','PERICIAS MARCADAS','EM ANALISE PERICIAS FEITAS','SALARIO MATERNIDADE GUIA PAGA','SALARIO MATERNIDADE 5 7 MESES','SALARIO MATERNIDADE 3 5 MESES','SALARIO MATERNIDADE 1 A 3 MESES','SALARIO MATERNIDADE','CANCELADO REQUERIMENTO'],
  LETICIA_OU_ALICE: ['ELABORAR PETICAO INICIAL','PERICIA MEDICA MARCADA','SENTENCA PROCEDENTE VERIFICAR IMPLANTACAO','PERICIA SOCIAL MARCADA','COM PRAZO','SENTENCA IMPROCEDENTE','PROTOCOLADO JUDICIAL','AGUARDANDO EXPEDICAO DE RPV','FAZER ACAO DE GUARDA','PROCEDENTE EM PARTE FAZER RECURSO','IMPROCEDENTE CABE RECURSO','DESENVOLVENDO RECURSO AOS TRIBUNAIS','RECURSO PROTOCOLADO INICIADO','APRESENTADA RESPOSTA A RECURSO','AGUARDANDO JULGAMENTO DO RECURSO','RECURSO JULGADO ENTRE EM CONTATO','TRANSITO EM JULGADO NAO CABE RECURSO'],
  CAU:              ['SALARIO MATERNIDADE PARCELADO','JUDICIAL PARCELADO','ADM PARCELADO','RPV DO MES','RPV DO PROXIMO MES','JUDICIAL IMPLANTADO A RECEBER','ADM IMPLANTADO A RECEBER','SALARIO MATERNIDADE CONCEDIDO','ARQUIVADO IMPROCEDENTE','ARQUIVADO PROCEDENTE','ARQUIVADO POR DETERMINACAO JUDICIAL','BENEFICIO CONCEDIDO AGUARDAR','ARQUIVADO ENCERRADO'],
  TAMMYRES:         ['FALTA LAUDO FAZER PREVDOC','FALTA LAUDO','PREVDOC'],
  EDUARDO:          ['TRABALHISTA'],
};

const AUDR_ZONE_LABEL = { MARILIA: 'Ana Marília', LETICIA_OU_ALICE: 'Letícia ou Alice', CAU: 'Claudiana (Cau)', TAMMYRES: 'Tammyres', EDUARDO: 'Eduardo' };

function audrNorm(s) { return (s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }

const AUDR_STAGE_MAP = {};
for (const [zone, stages] of Object.entries(AUDR_ZONES)) stages.forEach(s => { AUDR_STAGE_MAP[audrNorm(s)] = zone; });

function audrZoneForStage(stage) {
  const n = audrNorm(stage);
  if (AUDR_STAGE_MAP[n]) return AUDR_STAGE_MAP[n];
  const nW4 = n.split(' ').slice(0, 4).join(' ');
  for (const [mapped, zone] of Object.entries(AUDR_STAGE_MAP)) {
    const mW4 = mapped.split(' ').slice(0, 4).join(' ');
    if (nW4 === mW4 && nW4.length > 5) return zone;
    if (n.startsWith(mapped) || mapped.startsWith(n)) return zone;
  }
  return null;
}

function audrZoneForResp(r) {
  const n = audrNorm(r);
  if (n.includes('MARILIA'))                        return 'MARILIA';
  if (n.includes('LETICIA') || n.includes('ALICE')) return 'LETICIA_OU_ALICE';
  if (n.includes('CLAUDIANA') || n.includes('CAU')) return 'CAU';
  if (n.includes('TAMMYRES'))                       return 'TAMMYRES';
  if (n.includes('EDUARDO'))                        return 'EDUARDO';
  return null;
}

cache.define('audit-responsible', 20 * 60 * 1000);

router.get('/audit-responsible', requireAdmin, async (req, res, next) => {
  try {
    const data = await cache.getOrFetch('audit-responsible', async () => {
      const rawData  = await fetchLawsuits(true);
      const lawsuits = Array.isArray(rawData) ? rawData : (rawData.data || []);
      const items = [], byPerson = {}, byStage = {};
      let totalAuditados = 0, totalCorretos = 0, totalErrados = 0, totalNaoMapeados = 0;

      const AUDR_SKIP_SET = new Set(AUDR_SKIP_STAGES.map(audrNorm));

      for (const l of lawsuits) {
        const stage        = l.stage || l.step || '';
        const responsible  = l.responsible || '';
        if (AUDR_SKIP_SET.has(audrNorm(stage))) continue;
        const expectedZone = audrZoneForStage(stage);
        const actualZone   = audrZoneForResp(responsible);
        const clienteNome  = (Array.isArray(l.customers) && l.customers[0]?.name) || '—';

        let status;
        if (!expectedZone) { status = 'NAO_MAPEADO'; totalNaoMapeados++; }
        else {
          totalAuditados++;
          const isCorrect = expectedZone === 'LETICIA_OU_ALICE' ? actualZone === 'LETICIA_OU_ALICE' : actualZone === expectedZone;
          status = isCorrect ? 'CORRETO' : 'ERRADO';
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
        items.push({ id: l.id, cliente: clienteNome, numero: l.code || l.process_number || '', tipo: l.type || '', stage, responsible, expectedZone: expectedZone || null, expectedRespLabel: expectedZone ? AUDR_ZONE_LABEL[expectedZone] : null, actualZone: actualZone || null, status, link: `https://app.advbox.com.br/lawsuit/${l.id}` });
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
