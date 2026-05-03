/**
 * Rotas de fluxo: movimentações + posts + flow combinado.
 *
 * Bug fix: removida a chamada duplicada `cache.define('flow', ...)`.
 * O cache 'flow' já é definido em `services/data.js` no boot.
 */

'use strict';

const { Router } = require('express');
const { client, fetchAllPosts } = require('../../../services/data');
const cache = require('../../../cache');
const { asyncHandler } = require('../../../middleware/errorHandler');

const router = Router();

router.get('/last-movements', asyncHandler(async (req, res) => {
  res.json(await client.getLastMovements(500));
}));

router.get('/posts', asyncHandler(async (req, res) => {
  res.json(await client.request('/posts?limit=50'));
}));

router.get('/debug-posts', asyncHandler(async (req, res) => {
  const data  = await client.request('/posts?limit=20');
  const posts = Array.isArray(data) ? data : (data.data || []);
  res.json({
    total: posts.length,
    today: new Date().toISOString(),
    sample: posts.slice(0, 5).map(p => ({
      task:        p.task,
      lawsuits_id: p.lawsuits_id,
      users:       (p.users || []).slice(0, 3).map(u => ({ name: u.name, completed: u.completed })),
    })),
  });
}));

router.get('/flow', asyncHandler(async (req, res) => {
  const data = await cache.getOrFetch('flow', async () => {
    const [movData, posts] = await Promise.all([
      client.getLastMovements(500),
      fetchAllPosts(),
    ]);
    return {
      movements: Array.isArray(movData) ? movData : (movData.data || []),
      posts,
    };
  }, req.query.force === '1');
  res.json(data);
}));

module.exports = router;
