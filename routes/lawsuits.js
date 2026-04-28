const { Router } = require('express');
const { fetchLawsuits } = require('../services/data');

const router = Router();

router.get('/lawsuits', async (req, res, next) => {
  try {
    const data = await fetchLawsuits(req.query.force === '1');
    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
