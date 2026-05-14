/**
 * Controller — endpoint do painel que mostra ações pendentes da esteira.
 */

'use strict';

const { Router } = require('express');
const { requireAuth, requireAdmin } = require('../../../middleware/auth');
const { buildOverview, cobrarLote, saveSnapshot, getTendencia } = require('../../../services/controller');
const { client } = require('../../../services/data');
const cache = require('../../../cache');

const router = Router();

// GET /api/controller/overview
router.get('/controller/overview', requireAuth, async (req, res, next) => {
  try {
    const force = req.query.force === '1';
    const data = await buildOverview({ force });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /api/controller/cobrar-lote
// Body: { items: [{ lawsuit_id, user_id, descricao, problema_id, categoriaId }] }
// Restrição: team users só cobram a si mesmos. Admin cobra qualquer.
router.post('/controller/cobrar-lote', requireAuth, async (req, res, next) => {
  try {
    const session = req.session.user;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'items vazio' });
    if (items.length > 100) return res.status(400).json({ error: 'máximo 100 por lote' });

    const isAdmin = session.role === 'admin';
    if (!isAdmin) {
      const ownId = session.advboxUserId;
      const invalid = items.find(it => Number(it.user_id) !== Number(ownId));
      if (invalid) return res.status(403).json({ error: 'team só cobra a si mesmo' });
    }

    const result = await cobrarLote({
      actor: { username: session.username, advboxUserId: session.advboxUserId, role: session.role },
      items,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/controller/move-stage
// Body: { lawsuit_id, from_cat, to_cat, target_stage }
// Apenas admin — mover processo muda dado real no AdvBox.
router.post('/controller/move-stage', requireAdmin, async (req, res, next) => {
  try {
    const { lawsuit_id, target_stage } = req.body || {};
    if (!lawsuit_id || !target_stage) {
      return res.status(400).json({ error: 'lawsuit_id e target_stage obrigatórios' });
    }
    await client.updateLawsuit(Number(lawsuit_id), { stage: target_stage });
    cache.invalidate('lawsuits');
    res.json({ ok: true, lawsuit_id, target_stage });
  } catch (err) {
    next(err);
  }
});

// GET /api/controller/tendencia?dias=7
// Retorna série temporal dos últimos N dias + deltas vs ontem.
router.get('/controller/tendencia', requireAuth, async (req, res, next) => {
  try {
    const dias = Math.min(90, Math.max(1, parseInt(req.query.dias, 10) || 7));
    const data = await getTendencia({ dias });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /api/controller/snapshot
// Roda o snapshot manualmente (admin). Útil pra popular o histórico hoje
// sem esperar o cron das 23h.
router.post('/controller/snapshot', requireAdmin, async (req, res, next) => {
  try {
    const r = await saveSnapshot({ force: true });
    res.json({ ok: true, ...r });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
