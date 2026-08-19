const { Router } = require('express');
const crypto = require('crypto');
const { query } = require('../../../services/db');
const { requireFinance } = require('../../../middleware/auth');
const { fetchTransactions } = require('../../../services/data');
const { getInadimplentes } = require('../../../services/inadimplentes');
const { parseAdvboxDate, toISODate } = require('../../../services/date-utils');
const { isParcelaValida, validateEntryInput } = require('../../../services/finance-helpers');
const { logMutation } = require('../../../services/mutation-log');
const { validate } = require('../../../utils/validate');
const cache = require('../../../cache');

const router = Router();

cache.define('inadimplencia', 30 * 60 * 1000); // 30 min
cache.define('inadimplentes_full', 30 * 60 * 1000); // 30 min

// isParcelaValida agora vem de services/finance-helpers.js (fonte única).
// matchMes mantido aqui (lógica de filtro de mês com regex bruto, ok).

function matchMes(dateStr, mm, yyyy) {
  if (!dateStr) return false;
  const s = String(dateStr);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return +s.slice(0,4) === yyyy && +s.slice(5,7) === mm;
  if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) { const p = s.split('/'); return +p[1] === mm && +p[2] === yyyy; }
  return false;
}

function calcInadimplenciaMes(transactions, mm, yyyy) {
  const doMes = transactions
    .filter(isParcelaValida)
    .filter(t => matchMes(t.date_due, mm, yyyy));

  let totalDevido = 0, totalPago = 0;
  const devedoresMap = new Map(); // nome -> { valor, count, oldestDue }

  for (const t of doMes) {
    const amt = Number(t.amount || 0);
    totalDevido += amt;
    if (t.date_payment) {
      totalPago += amt;
    } else {
      // Inadimplente — agrega no devedor
      const nome = String(t.name || t.customer_name || '').trim().toUpperCase() || '(sem nome)';
      // Normaliza date_due pra ISO antes de comparar (BR quebra string compare)
      const dueISO = toISODate(t.date_due);
      const cur = devedoresMap.get(nome) || { nome: t.name || t.customer_name || '(sem nome)', valor: 0, count: 0, oldestDue: dueISO };
      cur.valor += amt;
      cur.count += 1;
      if (dueISO && (!cur.oldestDue || dueISO < cur.oldestDue)) cur.oldestDue = dueISO;
      devedoresMap.set(nome, cur);
    }
  }

  const totalInadimplente = totalDevido - totalPago;
  const taxa = totalDevido > 0 ? (totalInadimplente / totalDevido) * 100 : 0;

  const hoje = new Date();
  const topDevedores = [...devedoresMap.values()]
    .sort((a,b) => b.valor - a.valor)
    .slice(0, 5)
    .map(d => {
      const diasAtraso = d.oldestDue
        ? Math.max(0, Math.floor((hoje - new Date(d.oldestDue)) / 86400000))
        : null;
      return {
        cliente: d.nome,
        valor: Number(d.valor.toFixed(2)),
        parcelas: d.count,
        dias_atraso: diasAtraso,
      };
    });

  return {
    total_devido:       Number(totalDevido.toFixed(2)),
    total_pago:         Number(totalPago.toFixed(2)),
    total_inadimplente: Number(totalInadimplente.toFixed(2)),
    taxa_inadimplencia: Number(taxa.toFixed(2)),
    top_devedores:      topDevedores,
    parcelas_total:     doMes.length,
    parcelas_pagas:     doMes.filter(t => t.date_payment).length,
  };
}

// ── GET /api/finance/inadimplencia?mes=MM/YYYY ───────────────────────────────
// Calcula índice de inadimplência do mês + trend 6 meses + top devedores.
router.get('/finance/inadimplencia', requireFinance, async (req, res, next) => {
  try {
    const today = new Date();
    const defMes = String(today.getMonth() + 1).padStart(2, '0') + '/' + today.getFullYear();
    const mes = (req.query.mes || defMes).toString();
    const [mm, yyyy] = mes.split('/').map(Number);
    if (!mm || !yyyy) return res.status(400).json({ error: 'mes inválido (use MM/YYYY)' });

    const cacheKey = `inadimplencia:${mes}`;
    cache.define(cacheKey, 30 * 60 * 1000);

    const data = await cache.getOrFetch(cacheKey, async () => {
      const transactions = await fetchTransactions();
      const atual = calcInadimplenciaMes(transactions, mm, yyyy);

      // Trend 6 meses (do mês alvo + 5 anteriores)
      const trend = [];
      for (let i = 5; i >= 0; i--) {
        let m = mm - i, y = yyyy;
        while (m < 1) { m += 12; y -= 1; }
        const r = calcInadimplenciaMes(transactions, m, y);
        trend.push({
          mes: String(m).padStart(2,'0') + '/' + y,
          taxa: r.taxa_inadimplencia,
          devido: r.total_devido,
          pago:   r.total_pago,
          atraso: r.total_inadimplente,
        });
      }

      return {
        mes,
        ...atual,
        trend_6m: trend,
        cached_at: new Date().toISOString(),
      };
    }, req.query.force === '1');

    res.json(data);
  } catch (err) { next(err); }
});

// ── GET /api/finance/inadimplentes ───────────────────────────────────────────
// Relatório agregado de TODOS os inadimplentes (todas as parcelas atrasadas,
// não filtra por mês). Classifica em "crítico recente" vs "acumulado" pela
// regra acordada (≤60d e 1 parcela = crítico; >60d OU ≥2 parcelas com soma
// ≥ R$1.000 = acumulado).
router.get('/finance/inadimplentes', requireFinance, async (req, res, next) => {
  try {
    const force = req.query.force === '1';
    // Quando o user explicitamente clicou "Atualizar", força refetch das
    // transactions também (sem isso, cache stale de 30min faz Cau/Letícia
    // cobrarem dívidas JÁ pagas no AdvBox).
    const data = await cache.getOrFetch('inadimplentes_full',
      () => getInadimplentes({ force: true }), force);
    res.json(data);
  } catch (err) { next(err); }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function addDays(dateStr, n) {
  // dateStr: 'YYYY-MM-DD'
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T12:00:00Z'));
}

function lastDayOfMonth(yyyy, mm /* 1-12 */) {
  const d = new Date(Date.UTC(yyyy, mm, 0));
  return d.toISOString().slice(0, 10);
}

// ── POST /api/finance/entries ────────────────────────────────────────────────
// Cria 1 lançamento, gerando N parcelas (à vista = 1, parcelado = N).
// Body: {
//   client_name, lawsuit_id?, category?, kind: 'a_vista'|'parcelado',
//   total_value?, parcela_value, total_parcelas, first_due_date, day_of_month?, notes?
// }
router.post('/finance/entries', requireFinance, async (req, res, next) => {
  try {
    // Estrutura: tipos, presença, formato (validate() — joga 400 + details[]).
    // Limites de negócio (teto valor, max parcelas) ficam em validateEntryInput
    // — separação intencional: structural vs policy.
    const data = validate(req.body)
      .string('client_name',    { maxLength: 500 })
      .number('lawsuit_id',     { integer: true, min: 1, optional: true })
      .string('category',       { maxLength: 100, optional: true })
      .enum  ('kind',           ['a_vista', 'parcelado'])
      .number('parcela_value',  { min: 0.01 })
      .number('total_parcelas', { integer: true, min: 1, optional: true })
      .number('total_value',    { min: 0,    optional: true })
      .dateYMD('first_due_date')
      .number('day_of_month',   { integer: true, min: 1, max: 99, optional: true })
      .string('notes',          { maxLength: 1000, optional: true })
      .done();

    // Policy checks (tetos R$ / parcelas) — usa o b cru pra manter API antiga.
    const validationErrs = validateEntryInput(req.body || {});
    if (validationErrs.length) {
      return res.status(400).json({ error: validationErrs.join(' · '), errors: validationErrs });
    }

    const { client_name, lawsuit_id, category, kind,
            parcela_value: pv, total_value, first_due_date, day_of_month, notes } = data;
    const tp = kind === 'a_vista' ? 1 : Math.max(1, data.total_parcelas || 1);

    // Cascade: cada parcela +30 dias, opcionalmente forçando dia do mês fixo
    const parcelasDates = [];
    for (let i = 0; i < tp; i++) {
      let d = addDays(first_due_date, i * 30);
      if (day_of_month) {
        const [y, m] = d.split('-').map(Number);
        const dom = parseInt(day_of_month, 10);
        const target = dom === 99 // 99 = "fim do mês"
          ? lastDayOfMonth(y, m)
          : `${y}-${String(m).padStart(2, '0')}-${String(Math.min(dom, 28)).padStart(2, '0')}`;
        d = target;
      }
      parcelasDates.push(d);
    }

    const groupId = crypto.randomUUID();
    const inserted = [];

    for (let i = 0; i < tp; i++) {
      const r = await query(
        `INSERT INTO financial_parcelas
         (group_id, lawsuit_id, client_name, category, kind,
          parcela_num, total_parcelas, due_date, value, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          groupId,
          lawsuit_id ? Number(lawsuit_id) : null,
          String(client_name).trim(),
          category || null,
          kind,
          i + 1,
          tp,
          parcelasDates[i],
          pv,
          notes || null,
        ]
      );
      inserted.push(r.rows[0]);
    }

    res.json({
      group_id: groupId,
      total_parcelas: tp,
      total_value: total_value || pv * tp,
      parcelas: inserted,
    });
    logMutation({
      actor:     req.session?.user,
      action:    'finance.entries.create',
      lawsuitId: lawsuit_id ? Number(lawsuit_id) : null,
      payload:   { group_id: groupId, client_name, category, kind, total_parcelas: tp, parcela_value: pv, first_due_date, day_of_month },
      success:   true,
    });
  } catch (err) {
    logMutation({
      actor:   req.session?.user,
      action:  'finance.entries.create',
      payload: { body: req.body },
      success: false,
      error:   err.message,
    });
    next(err);
  }
});

// ── GET /api/finance/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD ──────────────────
// Lista parcelas no período, agrupadas por mês.
router.get('/finance/calendar', requireFinance, async (req, res, next) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    let { from, to } = req.query;
    if (!isValidDate(from)) from = today.slice(0, 7) + '-01';
    if (!isValidDate(to)) {
      const [y, m] = from.split('-').map(Number);
      // Default: 8 meses pra frente
      const endY = y + Math.floor((m + 7) / 12);
      const endM = ((m + 7) % 12) || 12;
      to = lastDayOfMonth(endY, endM);
    }

    const r = await query(
      `SELECT * FROM financial_parcelas
       WHERE due_date >= $1 AND due_date <= $2
       ORDER BY due_date ASC, id ASC`,
      [from, to]
    );

    // Agrupa por YYYY-MM
    const byMonth = {};
    for (const p of r.rows) {
      const key = String(p.due_date).slice(0, 7);
      (byMonth[key] = byMonth[key] || { month: key, parcelas: [], total: 0, paid: 0, pending: 0 }).parcelas.push(p);
      byMonth[key].total += Number(p.value);
      if (p.status === 'paga')     byMonth[key].paid    += Number(p.paid_value || p.value);
      if (p.status === 'pendente') byMonth[key].pending += Number(p.value);
    }
    const months = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));

    res.json({ from, to, months, total_count: r.rows.length });
  } catch (err) { next(err); }
});

// ── PATCH /api/finance/parcela/:id ───────────────────────────────────────────
// Atualiza status (paga/cancelada), data de pagamento, valor pago, etc.
router.patch('/finance/parcela/:id', requireFinance, async (req, res, next) => {
  try {
    // id vem da URL — checagem direta. validate() é só pro body.
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'id inválido' });

    // Todos os campos são opcionais aqui (PATCH = update parcial), mas SE
    // vierem precisam estar no formato certo. validate() coerce.
    const data = validate(req.body)
      .enum  ('status',     ['pendente', 'paga', 'cancelada'], { optional: true })
      .dateYMD('paid_date', { optional: true })
      .number('paid_value', { min: 0,    optional: true })
      .dateYMD('due_date',  { optional: true })
      .number('value',      { min: 0.01, optional: true })
      .string('notes',      { maxLength: 1000, optional: true })
      .done();

    const { status, paid_date, paid_value, due_date, value, notes } = data;
    const fields = [];
    const values = [];
    let i = 1;

    if (status !== undefined) {
      fields.push(`status = $${i++}`); values.push(status);
      if (status === 'paga') {
        fields.push(`paid_date = COALESCE($${i++}, CURRENT_DATE)`);
        values.push(paid_date || null);
        fields.push(`paid_value = COALESCE($${i++}, value)`);
        values.push(paid_value != null ? paid_value : null);
      } else {
        fields.push(`paid_date = NULL`);
        fields.push(`paid_value = NULL`);
      }
    }
    if (due_date !== undefined) {
      fields.push(`due_date = $${i++}`); values.push(due_date);
    }
    if (value !== undefined) {
      fields.push(`value = $${i++}`); values.push(value);
    }
    if (notes !== undefined) {
      fields.push(`notes = $${i++}`); values.push(notes);
    }

    if (!fields.length) return res.status(400).json({ error: 'nada para atualizar' });

    values.push(id);
    const r = await query(
      `UPDATE financial_parcelas SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (!r.rows.length) return res.status(404).json({ error: 'não encontrado' });

    res.json(r.rows[0]);
    logMutation({
      actor:  req.session?.user,
      action: 'finance.parcela.update',
      payload: { id, changes: { status, paid_date, paid_value, due_date, value, notes }, result: r.rows[0] },
      success: true,
    });
  } catch (err) {
    logMutation({
      actor:  req.session?.user,
      action: 'finance.parcela.update',
      payload: { id: parseInt(req.params.id, 10), body: req.body },
      success: false,
      error:   err.message,
    });
    next(err);
  }
});

// ── DELETE /api/finance/parcela/:id ──────────────────────────────────────────
// Remove uma parcela específica (não desfaz o lançamento inteiro).
router.delete('/finance/parcela/:id', requireFinance, async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  try {
    if (!id) return res.status(400).json({ error: 'id inválido' });
    const r = await query(`DELETE FROM financial_parcelas WHERE id = $1 RETURNING id`, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'não encontrado' });
    res.json({ ok: true, id });
    logMutation({ actor: req.session?.user, action: 'finance.parcela.delete', payload: { id }, success: true });
  } catch (err) {
    logMutation({ actor: req.session?.user, action: 'finance.parcela.delete', payload: { id }, success: false, error: err.message });
    next(err);
  }
});

// ── DELETE /api/finance/group/:groupId ───────────────────────────────────────
// Remove TODAS as parcelas de um lançamento (undo).
router.delete('/finance/group/:groupId', requireFinance, async (req, res, next) => {
  const groupId = req.params.groupId;
  try {
    const r = await query(`DELETE FROM financial_parcelas WHERE group_id = $1 RETURNING id`, [groupId]);
    res.json({ ok: true, removed: r.rows.length });
    logMutation({ actor: req.session?.user, action: 'finance.group.delete', payload: { groupId, removed: r.rows.length }, success: true });
  } catch (err) {
    logMutation({ actor: req.session?.user, action: 'finance.group.delete', payload: { groupId }, success: false, error: err.message });
    next(err);
  }
});

// ── PATCH /api/finance/group/:groupId/end-after ──────────────────────────────
// "Encerra" um lançamento parcelado a partir de uma parcela específica:
// remove todas as parcelas com num > X.
router.patch('/finance/group/:groupId/end-after', requireFinance, async (req, res, next) => {
  const groupId = req.params.groupId;
  try {
    const { parcela_num: n } = validate(req.body)
      .number('parcela_num', { integer: true, min: 1, max: 60 })
      .done();
    const r = await query(
      `DELETE FROM financial_parcelas
       WHERE group_id = $1 AND parcela_num > $2
       RETURNING id`,
      [groupId, n]
    );
    // Atualiza total_parcelas das remanescentes pra refletir o novo encerramento
    await query(
      `UPDATE financial_parcelas SET total_parcelas = $2
       WHERE group_id = $1`,
      [groupId, n]
    );
    res.json({ ok: true, removed: r.rows.length, new_total: n });
    logMutation({ actor: req.session?.user, action: 'finance.group.end-after', payload: { groupId, after_parcela_num: n, removed: r.rows.length }, success: true });
  } catch (err) {
    logMutation({ actor: req.session?.user, action: 'finance.group.end-after', payload: { groupId, body: req.body }, success: false, error: err.message });
    next(err);
  }
});

module.exports = router;
