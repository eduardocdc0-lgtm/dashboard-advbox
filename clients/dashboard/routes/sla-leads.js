/**
 * Rotas de SLA de leads.
 *  GET  /api/sla-leads/metrics   — KPIs (pra painel executivo)
 *  GET  /api/sla-leads/parados   — lista detalhada
 *  POST /api/sla-leads/run       — roda ciclo manual (admin) ?dryRun=1
 */

'use strict';

const { Router } = require('express');
const { requireAdmin } = require('../../../middleware/auth');
const { getMetrics, leadsParados, runCycle, ensureTable } = require('../../../services/sla-leads');

const router = Router();

router.get('/sla-leads/metrics', requireAdmin, async (req, res, next) => {
  try {
    await ensureTable();
    const data = await getMetrics();
    res.json(data);
  } catch (err) { next(err); }
});

router.get('/sla-leads/parados', requireAdmin, async (req, res, next) => {
  try {
    await ensureTable();
    const items = await leadsParados();
    res.json({ count: items.length, items });
  } catch (err) { next(err); }
});

router.post('/sla-leads/run', requireAdmin, async (req, res, next) => {
  try {
    const dryRun = req.query.dryRun === '1';
    const result = await runCycle({ dryRun });
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
