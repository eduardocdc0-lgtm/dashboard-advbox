const { Router } = require('express');
const { fetchTransactions } = require('../../../services/data');

const router = Router();

router.get('/transactions', async (req, res, next) => {
  try {
    const result = await fetchTransactions(req.query.force === '1');
    const arr = Array.isArray(result) ? result : (result.data || []);
    res.json({
      data:       arr,
      total:      arr.length,
      totalCount: arr.length,
    });
  } catch (err) { next(err); }
});

module.exports = router;
