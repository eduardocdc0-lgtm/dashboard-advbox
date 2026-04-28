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

module.exports = router;
