/**
 * Controller — endpoint do painel que mostra ações pendentes da esteira.
 */

'use strict';

const { Router } = require('express');
const { requireAuth } = require('../../../middleware/auth');
const { buildOverview, cobrarLote } = require('../../../services/controller');

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

module.exports = router;
