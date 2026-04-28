const { Router } = require('express');
const { client }  = require('../services/data');

const router = Router();

router.get('/settings', async (req, res, next) => {
  try {
    res.json(await client.getSettings());
  } catch (err) { next(err); }
});

module.exports = router;
