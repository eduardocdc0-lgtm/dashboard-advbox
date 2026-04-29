const { Router } = require('express');
const { fetchLawsuits } = require('../../../services/data');

const router = Router();

router.get('/lawsuits', async (req, res, next) => {
  try {
    const lawsuits = await fetchLawsuits(req.query.force === '1');
    const arr = Array.isArray(lawsuits) ? lawsuits : (lawsuits.data || []);
    res.json({
      data:       arr,
      total:      arr.length,
      totalCount: arr.length,
    });
  } catch (err) { next(err); }
});

module.exports = router;
