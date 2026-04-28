const { Router } = require('express');
const { fetchLawsuits } = require('../../../services/data');

const router = Router();

router.get('/lawsuits', async (req, res, next) => {
  try {
    res.json(await fetchLawsuits(req.query.force === '1'));
  } catch (err) { next(err); }
});

module.exports = router;
