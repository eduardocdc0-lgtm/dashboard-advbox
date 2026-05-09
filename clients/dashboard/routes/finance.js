const { Router } = require('express');
const crypto = require('crypto');
const { query } = require('../../../services/db');
const { requireAdmin } = require('../../../middleware/auth');

const router = Router();

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
router.post('/finance/entries', requireAdmin, async (req, res, next) => {
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
    const pv = Number(parcela_value);
    if (!pv || pv <= 0) return res.status(400).json({ error: 'parcela_value inválido' });
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
router.get('/finance/calendar', requireAdmin, async (req, res, next) => {
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
router.patch('/finance/parcela/:id', requireAdmin, async (req, res, next) => {
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
router.delete('/finance/parcela/:id', requireAdmin, async (req, res, next) => {
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
router.delete('/finance/group/:groupId', requireAdmin, async (req, res, next) => {
  try {
    const r = await query(`DELETE FROM financial_parcelas WHERE group_id = $1 RETURNING id`, [req.params.groupId]);
    res.json({ ok: true, removed: r.rows.length });
  } catch (err) { next(err); }
});

// ── PATCH /api/finance/group/:groupId/end-after ──────────────────────────────
// "Encerra" um lançamento parcelado a partir de uma parcela específica:
// remove todas as parcelas com num > X.
router.patch('/finance/group/:groupId/end-after', requireAdmin, async (req, res, next) => {
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
