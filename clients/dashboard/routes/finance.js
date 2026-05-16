const { Router } = require('express');
const crypto = require('crypto');
const { query } = require('../../../services/db');
const { requireFinance } = require('../../../middleware/auth');
const { fetchTransactions } = require('../../../services/data');
const { getInadimplentes } = require('../../../services/inadimplentes');
const { parseAdvboxDate, toISODate } = require('../../../services/date-utils');
const { isParcelaValida, validateEntryInput } = require('../../../services/finance-helpers');
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
    const {
      client_name, lawsuit_id, category,
      kind = 'parcelado',
      parcela_value, total_parcelas, total_value,
      first_due_date, day_of_month,
      notes,
    } = req.body || {};

    // Validação básica
    if (!client_name || !String(client_name).trim()) {
      return res.status(400).json({ error: 'client_name é obrigatório' });
    }
    if (!['a_vista', 'parcelado'].includes(kind)) {
      return res.status(400).json({ error: 'kind deve ser a_vista ou parcelado' });
    }
    // Sanity checks centralizados (anti-typo)
    const validationErrs = validateEntryInput(req.body || {});
    if (validationErrs.length) {
      return res.status(400).json({ error: validationErrs.join(' · '), errors: validationErrs });
    }
    const pv = Number(parcela_value);
    const tp = kind === 'a_vista' ? 1 : Math.max(1, parseInt(total_parcelas, 10) || 1);
    if (!isValidDate(first_due_date)) {
      return res.status(400).json({ error: 'first_due_date inválido (esperado YYYY-MM-DD)' });
    }

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
  } catch (err) { next(err); }
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
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'id inválido' });

    const { status, paid_date, paid_value, due_date, value, notes } = req.body || {};
    const fields = [];
    const values = [];
    let i = 1;

    if (status !== undefined) {
      if (!['pendente', 'paga', 'cancelada'].includes(status)) {
        return res.status(400).json({ error: 'status inválido' });
      }
      fields.push(`status = $${i++}`); values.push(status);
      if (status === 'paga') {
        fields.push(`paid_date = COALESCE($${i++}, CURRENT_DATE)`);
        values.push(isValidDate(paid_date) ? paid_date : null);
        fields.push(`paid_value = COALESCE($${i++}, value)`);
        values.push(paid_value != null ? Number(paid_value) : null);
      } else {
        fields.push(`paid_date = NULL`);
        fields.push(`paid_value = NULL`);
      }
    }
    if (due_date !== undefined) {
      if (!isValidDate(due_date)) return res.status(400).json({ error: 'due_date inválido' });
      fields.push(`due_date = $${i++}`); values.push(due_date);
    }
    if (value !== undefined) {
      const v = Number(value);
      if (!v || v <= 0) return res.status(400).json({ error: 'value inválido' });
      fields.push(`value = $${i++}`); values.push(v);
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
  } catch (err) { next(err); }
});

// ── DELETE /api/finance/parcela/:id ──────────────────────────────────────────
// Remove uma parcela específica (não desfaz o lançamento inteiro).
router.delete('/finance/parcela/:id', requireFinance, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    const r = await query(`DELETE FROM financial_parcelas WHERE id = $1 RETURNING id`, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'não encontrado' });
    res.json({ ok: true, id });
  } catch (err) { next(err); }
});

// ── DELETE /api/finance/group/:groupId ───────────────────────────────────────
// Remove TODAS as parcelas de um lançamento (undo).
router.delete('/finance/group/:groupId', requireFinance, async (req, res, next) => {
  try {
    const r = await query(`DELETE FROM financial_parcelas WHERE group_id = $1 RETURNING id`, [req.params.groupId]);
    res.json({ ok: true, removed: r.rows.length });
  } catch (err) { next(err); }
});

// ── PATCH /api/finance/group/:groupId/end-after ──────────────────────────────
// "Encerra" um lançamento parcelado a partir de uma parcela específica:
// remove todas as parcelas com num > X.
router.patch('/finance/group/:groupId/end-after', requireFinance, async (req, res, next) => {
  try {
    const { parcela_num } = req.body || {};
    const n = parseInt(parcela_num, 10);
    if (!n) return res.status(400).json({ error: 'parcela_num obrigatório' });
    const r = await query(
      `DELETE FROM financial_parcelas
       WHERE group_id = $1 AND parcela_num > $2
       RETURNING id`,
      [req.params.groupId, n]
    );
    // Atualiza total_parcelas das remanescentes pra refletir o novo encerramento
    await query(
      `UPDATE financial_parcelas SET total_parcelas = $2
       WHERE group_id = $1`,
      [req.params.groupId, n]
    );
    res.json({ ok: true, removed: r.rows.length, new_total: n });
  } catch (err) { next(err); }
});

module.exports = router;
