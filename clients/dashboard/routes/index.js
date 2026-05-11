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
router.use(require('./audit-actions'));
router.use(require('./webhook'));
router.use(require('./birthday'));
router.use(require('./inss-conference'));
router.use(require('./petitions'));
router.use(require('./cash-flow'));
router.use(require('./campaign-roi'));
router.use(require('./esteira'));
router.use(require('./finance'));
router.use(require('./overview'));

module.exports = router;
