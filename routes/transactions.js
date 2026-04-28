const { Router } = require('express');
const { fetchTransactions } = require('../services/data');

const router = Router();

router.get('/transactions', async (req, res, next) => {
  try {
    res.json(await fetchTransactions(req.query.force === '1'));
  } catch (err) { next(err); }
});

module.exports = router;
