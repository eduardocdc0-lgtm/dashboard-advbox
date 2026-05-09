const { Router } = require('express');
const { fetchLawsuits, fetchTransactions } = require('../../../services/data');

const router = Router();

// Stages financeiros (vir AdvBox CRM Financeiro)
const ESTEIRA_STAGES = [
  'SALARIO MATERNIDADE PARCELADO',
  'JUDICIAL PARCELADO',
  'ADM PARCELADO',
  'RPV DO MÊS',
  'RPV DO PROXIMO MÊS',
  'JUDICIAL IMPLANTADO A RECEBER',
  'ADM IMPLANTADO A RECEBER',
];

// Regras por stage (default da parcela / formato esperado)
const ESTEIRA_RULES = {
  'SALARIO MATERNIDADE PARCELADO': { mode: 'parcelas_iguais', count: 4 },
  'JUDICIAL PARCELADO':            { mode: 'parcela_fixa', valor: 486.30 },
  'ADM PARCELADO':                 { mode: 'parcela_fixa', valor: 500 },
  'RPV DO MÊS':                    { mode: 'lancamento_unico', valor: 6000 },
  'RPV DO PROXIMO MÊS':            { mode: 'sem_calculo' },
  'JUDICIAL IMPLANTADO A RECEBER': { mode: 'em_aberto' },
  'ADM IMPLANTADO A RECEBER':      { mode: 'em_aberto' },
};

// Cliente real (não o INSS / parceria)
function pickClientName(customers) {
  if (!Array.isArray(customers) || !customers.length) return null;
  const real = customers.find(c => c.origin !== 'PARCERIA');
  return (real || customers[customers.length - 1]).name || null;
}

// Parse DD/MM/YYYY ou YYYY-MM-DD pra Date
function toDate(str) {
  if (!str) return null;
  let d;
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) d = new Date(str.substring(0, 10) + 'T00:00:00');
  else if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) {
    const [day, mon, yr] = str.split('/');
    d = new Date(`${yr}-${mon}-${day}T00:00:00`);
  } else d = new Date(str);
  return isNaN(d) ? null : d;
}

// Calcula expected number de parcelas baseado na regra + contratado
function expectedParcelas(rule, contracted) {
  if (!contracted || contracted <= 0) return null;
  if (rule.mode === 'parcelas_iguais') return rule.count;
  if (rule.mode === 'parcela_fixa')    return Math.max(1, Math.round(contracted / rule.valor));
  if (rule.mode === 'lancamento_unico') return 1;
  return null;
}

function expectedParcelaValor(rule, contracted, expectedCount) {
  if (rule.mode === 'parcelas_iguais' && expectedCount) return contracted / expectedCount;
  if (rule.mode === 'parcela_fixa')    return rule.valor;
  if (rule.mode === 'lancamento_unico') return rule.valor;
  return null;
}

// Status visual de um card
function computeStatus(rule, lancado, contracted, nextDue, hoje) {
  if (rule.mode === 'sem_calculo')  return 'info';      // só lista
  if (rule.mode === 'em_aberto') {
    return nextDue ? 'agendado' : 'sem-data';
  }
  if (!contracted || contracted <= 0) return 'sem-contrato';
  if (lancado >= contracted - 0.01)   return 'completo';   // cobre tudo
  if (lancado <= 0.01)                return 'critico';    // 0 lançado
  // tem parcial
  if (nextDue && nextDue < hoje)      return 'atrasado';
  return 'parcial';
}

// ── GET /api/esteira ───────────────────────────────────────────────────────────
// Cruza lawsuits + transactions, retorna estrutura por coluna do Kanban
router.get('/esteira', async (req, res, next) => {
  try {
    const force = req.query.force === '1';
    const [lawsuits, transactions] = await Promise.all([
      fetchLawsuits(force),
      fetchTransactions(force),
    ]);
    const lArr = Array.isArray(lawsuits) ? lawsuits : (lawsuits.data || []);
    const tArr = Array.isArray(transactions) ? transactions : (transactions.data || []);

    // Index transactions por lawsuit_id
    const txByLawsuit = {};
    for (const t of tArr) {
      if (!t.lawsuit_id) continue;
      if (t.entry_type !== 'income') continue;
      (txByLawsuit[t.lawsuit_id] = txByLawsuit[t.lawsuit_id] || []).push(t);
    }

    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);

    // Filtra lawsuits com stage da esteira
    const filtered = lArr.filter(l => ESTEIRA_STAGES.includes((l.stage || '').toUpperCase()));

    // Inicializa estrutura
    const stages = {};
    ESTEIRA_STAGES.forEach(s => {
      stages[s] = { stage: s, rule: ESTEIRA_RULES[s], items: [], total: 0 };
    });

    let summary = {
      totalContracted: 0,
      totalLancado: 0,
      totalGap: 0,
      cardsTotal: 0,
      cardsCriticos: 0,
      cardsAtrasados: 0,
      cardsParciais: 0,
      cardsCompletos: 0,
      cardsSemData: 0,
    };

    for (const l of filtered) {
      const stageKey  = (l.stage || '').toUpperCase();
      const rule      = ESTEIRA_RULES[stageKey] || { mode: 'em_aberto' };
      const contracted = Number(l.fees_expec || 0);
      const txs = (txByLawsuit[l.id] || []).slice().sort((a, b) => {
        const da = toDate(a.date_due) || toDate(a.date_payment) || new Date(0);
        const db = toDate(b.date_due) || toDate(b.date_payment) || new Date(0);
        return da - db;
      });
      const lancado = txs.reduce((s, t) => s + Number(t.amount || 0), 0);
      const pago    = txs.filter(t => t.date_payment).reduce((s, t) => s + Number(t.amount || 0), 0);
      const gap     = Math.max(0, contracted - lancado);

      const expCount = expectedParcelas(rule, contracted);
      const expValor = expectedParcelaValor(rule, contracted, expCount);

      // Próxima parcela: primeira não-paga ordenada por venc
      const nextTx = txs.find(t => !t.date_payment);
      const nextDue = nextTx ? toDate(nextTx.date_due) : null;

      const status = computeStatus(rule, lancado, contracted, nextDue, hoje);

      const card = {
        id: l.id,
        process_number: l.process_number || l.protocol_number || null,
        folder: l.folder,
        client: pickClientName(l.customers),
        type: l.type || null,
        group: l.group || null,
        responsible: l.responsible || null,
        contracted,
        lancado,
        pago,
        gap,
        existingParcelas: txs.length,
        expectedParcelas: expCount,
        expectedParcelaValor: expValor,
        nextDue: nextTx ? nextTx.date_due : null,
        nextValue: nextTx ? Number(nextTx.amount || 0) : null,
        status,
        advboxUrl: `https://app.advbox.com.br/lawsuits/${l.id}`,
        transactions: txs.map(t => ({
          id: t.id,
          date_due: t.date_due,
          date_payment: t.date_payment,
          competence: t.competence,
          amount: Number(t.amount || 0),
          description: t.description || t.name || null,
          paid: !!t.date_payment,
        })),
      };

      stages[stageKey].items.push(card);
      stages[stageKey].total += contracted;

      summary.totalContracted += contracted;
      summary.totalLancado    += lancado;
      summary.totalGap        += gap;
      summary.cardsTotal      += 1;
      if (status === 'critico')  summary.cardsCriticos += 1;
      if (status === 'atrasado') summary.cardsAtrasados += 1;
      if (status === 'parcial')  summary.cardsParciais  += 1;
      if (status === 'completo') summary.cardsCompletos += 1;
      if (status === 'sem-data') summary.cardsSemData   += 1;
    }

    // Ordena cards de cada stage: critico/atrasado primeiro, depois maior contracted
    const STATUS_PRIORITY = { critico: 0, atrasado: 1, parcial: 2, completo: 3, agendado: 4, 'sem-data': 5, info: 6, 'sem-contrato': 7 };
    Object.values(stages).forEach(col => {
      col.items.sort((a, b) => {
        const pa = STATUS_PRIORITY[a.status] ?? 99;
        const pb = STATUS_PRIORITY[b.status] ?? 99;
        if (pa !== pb) return pa - pb;
        return b.contracted - a.contracted;
      });
      col.count = col.items.length;
    });

    res.json({
      stages: ESTEIRA_STAGES.map(s => stages[s]),
      summary,
      generated_at: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

module.exports = router;
