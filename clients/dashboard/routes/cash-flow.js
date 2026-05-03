const { Router } = require('express');
const { fetchTransactions } = require('../../../services/data');

const router = Router();

// Fuso America/Recife (UTC-3)
function todayRecife() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Extrai info de parcela da descrição: "1/4", "1 DE 4", "30%+TAXA 1/4" → "Parcela 1/4"
function parseInstallment(desc) {
  if (!desc) return null;
  const m = desc.match(/(\d+)\s*(?:\/|DE)\s*(\d+)/i);
  if (m && m[2] !== '0' && m[2] !== m[1]) return `Parcela ${m[1]}/${m[2]}`;
  return null;
}

// ── GET /api/cash-flow/upcoming?days=7&responsible= ────────────────────────────
// Retorna lançamentos de receita ainda não pagos com vencimento até hoje+days.
// Inclui inadimplentes (date_due < hoje mas date_payment = null).
// Cache: reutiliza fetchTransactions (30 min TTL).
router.get('/cash-flow/upcoming', async (req, res, next) => {
  try {
    const days      = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
    const filterResp = (req.query.responsible || '').trim().toUpperCase();

    const today   = todayRecife();
    const endDate = addDays(today, days);

    const all = await fetchTransactions();
    const arr = Array.isArray(all) ? all : (all.data || []);

    // Receitas não pagas com vencimento até today+days (overdue incluído)
    const items = arr.filter(t => {
      if (t.entry_type !== 'income')    return false;
      if (t.date_payment)               return false;
      if (!t.date_due)                  return false;
      const due = t.date_due.slice(0, 10);
      if (due > endDate)                return false;
      if (filterResp && !(t.responsible || '').toUpperCase().includes(filterResp)) return false;
      return true;
    });

    items.sort((a, b) => a.date_due.localeCompare(b.date_due));

    const total = items.reduce((s, t) => s + Number(t.amount || 0), 0);

    // Agrupar por dia
    const byDayMap = {};
    for (const t of items) {
      const d = t.date_due.slice(0, 10);
      if (!byDayMap[d]) byDayMap[d] = { date: d, total: 0, items: [] };
      byDayMap[d].total += Number(t.amount || 0);
      byDayMap[d].items.push({
        id:          t.id,
        client:      t.name || '—',
        value:       Number(t.amount || 0),
        due:         d,
        type:        t.category || '—',
        installment: parseInstallment(t.description),
        responsible: t.responsible || '—',
        status:      d < today ? 'overdue' : (d === today ? 'today' : 'upcoming'),
        process:     t.process_number || null,
        lawsuit_id:  t.lawsuit_id || null,
        description: t.description || null,
      });
    }

    const byDay = Object.values(byDayMap).sort((a, b) => a.date.localeCompare(b.date));

    res.json({ days, today, end_date: endDate, total_expected: total, count: items.length, by_day: byDay });
  } catch (err) { next(err); }
});

module.exports = router;
