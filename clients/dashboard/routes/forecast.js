/**
 * Rotas de forecast de caixa.
 *  GET /api/forecast            — buckets 30/60/90/180d + breakdown
 *  GET /api/forecast?force=1    — força refresh (admin)
 */

'use strict';

const { Router } = require('express');
const { requireAdmin } = require('../../../middleware/auth');
const { getForecast } = require('../../../services/forecast');

const router = Router();

router.get('/forecast', requireAdmin, async (req, res, next) => {
  try {
    const force = req.query.force === '1';
    const data = await getForecast({ force });
    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
