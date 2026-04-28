const { Router } = require('express');
const { client }  = require('../services/data');

const router = Router();

router.get('/customers', async (req, res, next) => {
  try { res.json(await client.getCustomers()); } catch (err) { next(err); }
});

router.get('/birthdays', async (req, res, next) => {
  try { res.json(await client.getBirthdays()); } catch (err) { next(err); }
});

module.exports = router;
