const { Router } = require('express');

const router = Router();

router.use(require('./settings'));
router.use(require('./lawsuits'));
router.use(require('./customers'));
router.use(require('./transactions'));
router.use(require('./flow'));
router.use(require('./distribution'));
router.use(require('./evolucao'));
router.use(require('./meta'));
router.use(require('./registrations'));
router.use(require('./audit'));
router.use(require('./webhook'));
router.use(require('./birthday'));
router.use(require('./inss-conference'));
router.use(require('./petitions'));
router.use(require('./cash-flow'));
router.use(require('./campaign-roi'));

module.exports = router;
