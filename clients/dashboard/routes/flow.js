const { Router } = require('express');
const { client, fetchAllPosts } = require('../../../services/data');
const cache = require('../../../cache');

cache.define('flow', 20 * 60 * 1000);

const router = Router();

router.get('/last-movements', async (req, res, next) => {
  try { res.json(await client.getLastMovements(500)); } catch (err) { next(err); }
});

router.get('/posts', async (req, res, next) => {
  try { res.json(await client.request('/posts?limit=50')); } catch (err) { next(err); }
});

router.get('/debug-posts', async (req, res, next) => {
  try {
    const data  = await client.request('/posts?limit=20');
    const posts = Array.isArray(data) ? data : (data.data || []);
    res.json({
      total: posts.length,
      today: new Date().toISOString(),
      sample: posts.slice(0, 5).map(p => ({
        task: p.task,
        lawsuits_id: p.lawsuits_id,
        users: (p.users || []).slice(0, 3).map(u => ({ name: u.name, completed: u.completed })),
      })),
    });
  } catch (err) { next(err); }
});

router.get('/flow', async (req, res, next) => {
  try {
    const data = await cache.getOrFetch('flow', async () => {
      const [movData, posts] = await Promise.all([client.getLastMovements(500), fetchAllPosts()]);
      return {
        movements: Array.isArray(movData) ? movData : (movData.data || []),
        posts,
      };
    }, req.query.force === '1');
    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
