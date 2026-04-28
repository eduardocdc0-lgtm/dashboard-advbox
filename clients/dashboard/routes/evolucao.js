const { Router } = require('express');
const { fetchLawsuits } = require('../../../services/data');
const cache = require('../../../cache');

cache.define('evolucao', 30 * 60 * 1000);

const router = Router();

router.get('/evolucao', async (req, res, next) => {
  try {
    const data = await cache.getOrFetch('evolucao', async () => {
      const all = await fetchLawsuits();
      const byMonth = {}, faturMonth = {}, expecMonth = {};

      all.forEach(l => {
        const dt = (l.created_at || l.process_date || '').slice(0, 7);
        if (!dt || dt < '2025-01' || dt > '2030-12') return;
        byMonth[dt]    = (byMonth[dt]    || 0) + 1;
        if (l.fees_money) faturMonth[dt] = (faturMonth[dt] || 0) + parseFloat(l.fees_money);
        if (l.fees_expec) expecMonth[dt] = (expecMonth[dt] || 0) + parseFloat(l.fees_expec);
      });

      const curYM = new Date().toISOString().slice(0, 7);
      const months = [];
      let ym = '2025-01';
      while (ym <= curYM) {
        months.push(ym);
        const [y, m] = ym.split('-').map(Number);
        ym = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      }

      return {
        months,
        contratos:   months.map(m => byMonth[m]    || 0),
        faturamento: months.map(m => Math.round(faturMonth[m] || 0)),
        expec:       months.map(m => Math.round(expecMonth[m] || 0)),
        fetchedAt:   new Date().toISOString(),
      };
    }, req.query.force === '1');

    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
