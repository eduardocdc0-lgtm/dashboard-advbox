/**
 * Controller — endpoint do painel que mostra ações pendentes da esteira.
 */

'use strict';

const { Router } = require('express');
const { requireAuth } = require('../../../middleware/auth');
const { buildOverview } = require('../../../services/controller');

const router = Router();

// GET /api/controller/overview
// Query params:
//   force=1  → ignora cache de lawsuits
router.get('/controller/overview', requireAuth, async (req, res, next) => {
  try {
    const force = req.query.force === '1';
    const data = await buildOverview({ force });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
