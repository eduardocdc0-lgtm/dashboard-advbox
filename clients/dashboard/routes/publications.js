/**
 * Rotas de publicações — janela de últimas N dias enriquecida.
 *
 * GET /api/publications/recent           → janela default (7 dias)
 * GET /api/publications/recent?days=14   → janela custom (7|14|30)
 * GET /api/publications/recent?force=1   → bypass cache
 */

'use strict';

const { Router } = require('express');
const { asyncHandler } = require('../../../middleware/errorHandler');
const { getRecentPublications } = require('../../../services/publications');

const router = Router();

router.get('/publications/recent', asyncHandler(async (req, res) => {
  const allowed = new Set([7, 14, 30]);
  const days = allowed.has(Number(req.query.days)) ? Number(req.query.days) : 7;
  const force = req.query.force === '1';
  const data = await getRecentPublications({ days, force });
  res.json(data);
}));

module.exports = router;
