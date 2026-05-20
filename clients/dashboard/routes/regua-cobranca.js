/**
 * Rotas da régua de cobrança.
 *  GET  /api/regua-cobranca/metrics — KPIs (pra painel executivo)
 *  GET  /api/regua-cobranca/log     — histórico de execuções
 *  POST /api/regua-cobranca/run     — roda ciclo manual (admin) ?dryRun=1
 */

'use strict';

const { Router } = require('express');
const { requireAdmin } = require('../../../middleware/auth');
const { query } = require('../../../services/db');
const { runCycle, getMetrics, ensureTable } = require('../../../services/regua-cobranca');

const router = Router();

router.get('/regua-cobranca/metrics', requireAdmin, async (req, res, next) => {
  try {
    await ensureTable();
    const data = await getMetrics();
    res.json(data);
  } catch (err) { next(err); }
});

router.get('/regua-cobranca/log', requireAdmin, async (req, res, next) => {
  try {
    await ensureTable();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const r = await query(
      `SELECT id, cliente, etapa, channel, dias_atraso, valor_total, success, error_message, sent_at
       FROM cobranca_regua_log
       ORDER BY sent_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ count: r.rows.length, items: r.rows });
  } catch (err) { next(err); }
});

router.post('/regua-cobranca/run', requireAdmin, async (req, res, next) => {
  try {
    const dryRun = req.query.dryRun === '1';
    const result = await runCycle({ dryRun });
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
