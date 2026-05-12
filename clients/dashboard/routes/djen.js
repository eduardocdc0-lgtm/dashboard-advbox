/**
 * Rotas admin do DJEN sync.
 */

'use strict';

const { Router } = require('express');
const { requireAuth } = require('../../../middleware/auth');
const { syncCycle } = require('../../../services/djen-sync');
const { query } = require('../../../services/db');

const router = Router();

function adminOnly(req, res, next) {
  if (req.session.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Só admin acessa DJEN.' });
  }
  next();
}

// GET /api/admin/djen/run?days=7&dryRun=1
router.get('/admin/djen/run', requireAuth, adminOnly, async (req, res) => {
  try {
    const days   = Number(req.query.days) || 3;
    const dryRun = req.query.dryRun === '1';
    const result = await syncCycle({ days, dryRun });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/djen/unmatched — publicações sem match no AdvBox
router.get('/admin/djen/unmatched', requireAuth, adminOnly, async (req, res) => {
  try {
    const r = await query(`
      SELECT * FROM djen_unmatched ORDER BY data_disponibilizacao DESC, id DESC LIMIT 100
    `);
    res.json({ ok: true, total: r.rows.length, items: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/djen/recent — últimas processadas
router.get('/admin/djen/recent', requireAuth, adminOnly, async (req, res) => {
  try {
    const r = await query(`
      SELECT * FROM djen_seen ORDER BY processed_at DESC LIMIT 50
    `);
    res.json({ ok: true, total: r.rows.length, items: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
