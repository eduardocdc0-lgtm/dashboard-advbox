/**
 * Webhooks externos.
 *
 * Refatorações:
 *  - Comparação timing-safe do CHATGURU_WEBHOOK_SECRET
 *  - Uso de asyncHandler em vez de try/catch manual
 */

'use strict';

const { Router } = require('express');
const { requireAdmin } = require('../../../middleware/auth');
const { asyncHandler, ValidationError, AuthenticationError, NotFoundError } = require('../../../middleware/errorHandler');
const { safeCompare } = require('../../../utils/safeCompare');
const { config } = require('../../../config');
const { logger } = require('../../../middleware/logger');
const {
  createLead, listLeads, getLead, updateStage, getStats, VALID_STAGES,
} = require('../../../services/leads');

const router = Router();

// ── POST /webhooks/chatguru ───────────────────────────────────────────────────
// Sem auth de sessão — valida pelo secret no header com timing-safe compare.
router.post('/webhooks/chatguru', asyncHandler(async (req, res) => {
  const expected = config.chatguru.webhookSecret;
  if (expected) {
    const received = String(req.headers['x-chatguru-secret'] || req.headers['x-webhook-secret'] || '');
    if (!safeCompare(received, expected)) {
      throw new AuthenticationError('Secret inválido.');
    }
  }

  const body = req.body || {};
  const { id, name, phone, email, message, campaign } = body;

  if (!phone && !name) {
    throw new ValidationError('Payload inválido: phone ou name obrigatório.');
  }

  const { lead, created } = await createLead({
    chatguru_id:   id      || null,
    name:          name    || 'Sem nome',
    phone:         phone   || '',
    email:         email   || null,
    message:       message || '',
    campaign_hint: campaign|| '',
  });

  logger.info({ leadId: lead.id, created }, '[Webhook] ChatGuru lead');
  res.status(created ? 201 : 200).json({ ok: true, lead_id: lead.id, created });
}));

// ── GET /api/leads ────────────────────────────────────────────────────────────
router.get('/leads', requireAdmin, asyncHandler(async (req, res) => {
  const { stage, zone, limit = 50, offset = 0 } = req.query;
  res.json(await listLeads({ stage, zone, limit: +limit, offset: +offset }));
}));

router.get('/leads/stats', requireAdmin, asyncHandler(async (req, res) => {
  res.json(await getStats());
}));

router.get('/leads/:id', requireAdmin, asyncHandler(async (req, res) => {
  const lead = await getLead(+req.params.id);
  if (!lead) throw new NotFoundError('Lead não encontrado.');
  res.json(lead);
}));

router.patch('/leads/:id/stage', requireAdmin, asyncHandler(async (req, res) => {
  const { stage, notes } = req.body || {};
  if (!stage) throw new ValidationError('Campo stage obrigatório.');
  const lead = await updateStage(+req.params.id, stage, notes || null);
  res.json({ ok: true, lead });
}));

router.get('/leads-stages', requireAdmin, (req, res) => {
  res.json({ stages: VALID_STAGES });
});

module.exports = router;
