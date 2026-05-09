const { Router } = require('express');
const { requireAdmin } = require('../../../middleware/auth');
const { fetchLawsuits, fetchTransactions, fetchAllPosts } = require('../../../services/data');
const cache = require('../../../cache');
const { sendWhatsApp } = require('../../../services/chatguru-sender');

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────
function normFase(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}
function matchesAnyFase(stage, list) {
  const st = normFase(stage);
  return list.some(f => { const fn = normFase(f); return st === fn || st.includes(fn) || fn.includes(st); });
}
function pickClientName(customers) {
  if (!Array.isArray(customers) || !customers.length) return null;
  const real = customers.find(c => c.name && !/INSS|INSTITUTO NACIONAL|PREVIDENCIA|ESTADO|MUNICIPIO|UNIAO FEDERAL/i.test((c.name || '').toUpperCase())
    && !((c.identification || '').match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/)));
  if (real) return real.name;
  return (customers.find(c => c.name) || {}).name || null;
}
function dateInMes(s, mm, yyyy) {
  if (!s) return false;
  const str = String(s);
  let m, y;
  if (/^\d{4}-\d{2}-\d{2}/.test(str))      { y = +str.slice(0,4); m = +str.slice(5,7); }
  else if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) { const p = str.split('/'); m = +p[1]; y = +p[2]; }
  else return false;
  return m === mm && y === yyyy;
}
function buildLawsuitItem(l) {
  return {
    id: l.id,
    cliente: pickClientName(l.customers) || `#${l.id}`,
    tipo: l.type || '',
    responsavel: l.responsible || '',
    fase: l.stage || '',
    advboxUrl: `https://app.advbox.com.br/lawsuits/${l.id}`,
  };
}

// Fases pra Visão Geral
const FASE_ADM_AGUARDANDO     = ['EM ANALISE PERICIAS FEITAS'];
const FASE_JUD_ELABORAR       = ['ELABORAR PETICAO INICIAL'];
const FASE_JUD_SENTENCA       = ['SENTENCA PROCEDENTE VERIFICAR IMPLANTACAO'];
const FASES_COBRANCA          = ['Salario Maternidade Parcelado', 'Judicial Parcelado', 'Adm Parcelado', 'Rpv do Mês'];

// Heurística pra petições (mesma da rota /api/petitions)
const PETITION_PREFIXES = ['AJUIZAR','PETICIONAR','ELABORAR PETICAO','ELABORAR RECURSO','RECURSO DE','CONTESTACAO','MANIFESTACAO','CUMPRIMENTO DE SENTENCA','IMPUGNACAO','EMBARGOS'];
const EXCLUDED_PREFIXES = ['PROTOCOLAR ADM','COMENTARIO','ANALISAR','LIGAR','ENVIAR'];
function isPetition(task) {
  const t = (task || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (EXCLUDED_PREFIXES.some(ex => t.startsWith(ex))) return false;
  return PETITION_PREFIXES.some(kw => t.startsWith(kw));
}

// ── GET /api/overview?mes=MM/YYYY ────────────────────────────────────────────
router.get('/overview', requireAdmin, async (req, res, next) => {
  try {
    const today  = new Date();
    const defMes = String(today.getMonth() + 1).padStart(2, '0') + '/' + today.getFullYear();
    const mes    = req.query.mes || defMes;
    const [mm, yyyy] = mes.split('/').map(Number);

    const cacheKey = `overview:${mes}`;
    cache.define(cacheKey, 10 * 60 * 1000);

    const data = await cache.getOrFetch(cacheKey, async () => {
      const [lawsuits, transactions] = await Promise.all([fetchLawsuits(), fetchTransactions()]);

      // ADM: aguardando conclusão
      const admAguardando = lawsuits
        .filter(l => matchesAnyFase(l.stage, FASE_ADM_AGUARDANDO))
        .map(buildLawsuitItem);

      // Judicial: elaborar petição inicial
      const judElaborar = lawsuits
        .filter(l => matchesAnyFase(l.stage, FASE_JUD_ELABORAR))
        .map(buildLawsuitItem);

      // Judicial: sentença procedente
      const judSentenca = lawsuits
        .filter(l => matchesAnyFase(l.stage, FASE_JUD_SENTENCA))
        .map(buildLawsuitItem);

      // Judicial: peticionados no mês (via posts/tasks que sejam petição com data no mês)
      let peticionadosCount = 0;
      const peticionadosItems = [];
      try {
        const posts = await fetchAllPosts(500, 4, 600);
        const seen = new Set();
        for (const p of posts) {
          const dt = p.date_created || p.date || p.created_at || '';
          if (!dateInMes(dt, mm, yyyy)) continue;
          if (!isPetition(p.task || p.title)) continue;
          const lid = String(p.lawsuits_id || p.lawsuit_id || '');
          if (!lid || seen.has(lid)) continue; seen.add(lid);
          const law = lawsuits.find(l => String(l.id) === lid);
          peticionadosCount++;
          peticionadosItems.push({
            id: lid,
            cliente: law ? pickClientName(law.customers) || `#${lid}` : `#${lid}`,
            tipo: law ? (law.type || '') : '',
            responsavel: p.responsible || (law && law.responsible) || '',
            fase: law ? (law.stage || '') : '',
            data: dt,
            advboxUrl: `https://app.advbox.com.br/lawsuits/${lid}`,
          });
        }
      } catch (e) {
        console.warn('[overview] erro buscando posts:', e.message);
      }

      // Financeiro: críticos (regime de caixa, igual audit)
      const txByLaw = {};
      transactions.filter(t => t.entry_type === 'income' && (dateInMes(t.date_payment, mm, yyyy) || dateInMes(t.date_due, mm, yyyy)))
        .forEach(t => { const lid = String(t.lawsuits_id || t.lawsuit_id || ''); if (lid) (txByLaw[lid] = txByLaw[lid] || []).push(t); });
      const finCriticos = lawsuits
        .filter(l => matchesAnyFase(l.stage, FASES_COBRANCA))
        .filter(l => !(txByLaw[String(l.id)] || []).length)
        .map(buildLawsuitItem);

      // Receitas pagas e previstas no mês (regime de caixa)
      const incomes = transactions.filter(t => t.entry_type === 'income');
      const recPagas = incomes.filter(t => dateInMes(t.date_payment, mm, yyyy)).reduce((s, t) => s + Number(t.amount || 0), 0);
      const recPrevistas = incomes
        .filter(t => !t.date_payment && dateInMes(t.date_due, mm, yyyy))
        .reduce((s, t) => s + Number(t.amount || 0), 0);

      // Despesas pagas no mês
      const expenses = transactions.filter(t => t.entry_type === 'expense');
      const despPagas = expenses.filter(t => dateInMes(t.date_payment, mm, yyyy)).reduce((s, t) => s + Number(t.amount || 0), 0);

      return {
        mes,
        adm: {
          aguardandoConclusao: { count: admAguardando.length, items: admAguardando, label: 'Aguardando conclusão' },
        },
        judicial: {
          peticionados:     { count: peticionadosCount, items: peticionadosItems, label: 'Peticionados' },
          elaborarPeticao:  { count: judElaborar.length, items: judElaborar, label: 'Elaborar petição' },
          sentencaProcedente:{ count: judSentenca.length, items: judSentenca, label: 'Sentença — verificar' },
        },
        financeiro: {
          criticos: { count: finCriticos.length, items: finCriticos, label: 'Sem lançamento' },
        },
        receitas: {
          pagas: recPagas,
          previstas: recPrevistas,
          total: recPagas + recPrevistas,
          label: 'Faturado em caixa',
        },
        despesas: {
          pagas: despPagas,
          label: 'Despesas pagas',
        },
        generated_at: new Date().toISOString(),
      };
    }, req.query.force === '1');

    res.json(data);
  } catch (err) { next(err); }
});

// ── POST /api/overview/notify-group?setor=adm|jud|fin ────────────────────────
// Envia resumo do setor pro celular da Cau via CAU_PHONE
router.post('/overview/notify-group', requireAdmin, async (req, res, next) => {
  try {
    const phone = process.env.CAU_PHONE || '';
    if (!phone) {
      return res.status(400).json({
        error: 'CAU_PHONE não configurado',
        hint:  'Adicione CAU_PHONE nos Secrets do Replit (formato 5581999999999, com 55+DDD+número, só dígitos)',
      });
    }

    const setor = (req.query.setor || req.body?.setor || '').toLowerCase();
    const mes   = req.query.mes   || req.body?.mes   || (() => {
      const t = new Date();
      return String(t.getMonth() + 1).padStart(2, '0') + '/' + t.getFullYear();
    })();

    // Reusa /overview cacheado pra montar resumo
    const cacheKey = `overview:${mes}`;
    const data = cache.getData(cacheKey);
    if (!data) return res.status(409).json({ error: 'Carregue a Visão Geral primeiro (cache vazio).' });

    const fmtBR = (s) => {
      if (!s) return '';
      if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) return s.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) { const [y,m,d] = s.slice(0,10).split('-'); return `${d}/${m}/${y}`; }
      return s;
    };
    const fmtBRL = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const blockItems = (items, max = 30) => items.slice(0, max).map((it, i) => `${i + 1}. ${it.cliente}${it.responsavel ? ' — ' + it.responsavel : ''}`).join('\n')
      + (items.length > max ? `\n…e mais ${items.length - max}` : '');

    let msg = '';
    if (setor === 'adm') {
      const adm = data.adm.aguardandoConclusao;
      msg = `*Cau — Processos ADM (${mes})*\n${adm.label}: ${adm.count}\n\n${blockItems(adm.items)}`;
    } else if (setor === 'jud') {
      const j = data.judicial;
      msg = `*Cau — Judicial (${mes})*\n` +
            `• Peticionados: ${j.peticionados.count}\n` +
            `• Elaborar petição inicial: ${j.elaborarPeticao.count}\n` +
            `• Sentença procedente — verificar: ${j.sentencaProcedente.count}\n\n` +
            (j.elaborarPeticao.count ? `*Elaborar petição:*\n${blockItems(j.elaborarPeticao.items, 20)}\n\n` : '') +
            (j.sentencaProcedente.count ? `*Sentença procedente:*\n${blockItems(j.sentencaProcedente.items, 20)}` : '');
    } else if (setor === 'fin') {
      const c = data.financeiro.criticos;
      msg = `*Cau — Financeiro (${mes})*\n${c.count} processo${c.count > 1 ? 's' : ''} no CRM mas sem lançamento.\n\n${blockItems(c.items, 30)}`;
    } else if (setor === 'receitas') {
      const r = data.receitas, d = data.despesas;
      msg = `*Cau — Caixa (${mes})*\n` +
            `Recebido: ${fmtBRL(r.pagas)}\n` +
            `Previsto (não pago): ${fmtBRL(r.previstas)}\n` +
            `Despesas pagas: ${fmtBRL(d.pagas)}\n` +
            `Resultado: ${fmtBRL(r.pagas - d.pagas)}`;
    } else {
      return res.status(400).json({ error: 'setor inválido (adm | jud | fin | receitas)' });
    }

    const result = await sendWhatsApp(phone, msg);
    res.json({ ok: true, sent: true, setor, mes, messageId: result.messageId });
  } catch (err) {
    console.error('[overview/notify-group] erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
