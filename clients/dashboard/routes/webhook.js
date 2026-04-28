const { Router } = require('express');
const { requireAdmin } = require('../../../middleware/auth');
const { createLead, listLeads, getLead, updateStage, getStats, VALID_STAGES } = require('../../../services/leads');

const router = Router();

// ── POST /webhooks/chatguru ───────────────────────────────────────────────────
// Sem autenticação de sessão — valida pelo secret no header
router.post('/webhooks/chatguru', async (req, res, next) => {
  try {
    const secret = process.env.CHATGURU_WEBHOOK_SECRET;
    if (secret) {
      const received = req.headers['x-chatguru-secret'] || req.headers['x-webhook-secret'] || '';
      if (received !== secret) {
        return res.status(401).json({ error: 'Secret inválido.' });
      }
    }

    const body = req.body || {};
    const { id, name, phone, email, message, campaign } = body;

    if (!phone && !name) {
      return res.status(400).json({ error: 'Payload inválido: phone ou name obrigatório.' });
    }

    const { lead, created } = await createLead({
      chatguru_id:   id   || null,
      name:          name || 'Sem nome',
      phone:         phone || '',
      email:         email || null,
      message:       message || '',
      campaign_hint: campaign || '',
    });

    console.log(`[Webhook] ChatGuru → lead #${lead.id} ${created ? 'CRIADO' : 'já existia'}`);
    res.status(created ? 201 : 200).json({ ok: true, lead_id: lead.id, created });
  } catch (err) { next(err); }
});

// ── GET /api/leads ────────────────────────────────────────────────────────────
router.get('/leads', requireAdmin, async (req, res, next) => {
  try {
    const { stage, zone, limit = 50, offset = 0 } = req.query;
    const result = await listLeads({ stage, zone, limit: +limit, offset: +offset });
    res.json(result);
  } catch (err) { next(err); }
});

// ── GET /api/leads/stats ──────────────────────────────────────────────────────
router.get('/leads/stats', requireAdmin, async (req, res, next) => {
  try {
    res.json(await getStats());
  } catch (err) { next(err); }
});

// ── GET /api/leads/:id ────────────────────────────────────────────────────────
router.get('/leads/:id', requireAdmin, async (req, res, next) => {
  try {
    const lead = await getLead(+req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado.' });
    res.json(lead);
  } catch (err) { next(err); }
});

// ── PATCH /api/leads/:id/stage ────────────────────────────────────────────────
router.patch('/leads/:id/stage', requireAdmin, async (req, res, next) => {
  try {
    const { stage, notes } = req.body || {};
    if (!stage) return res.status(400).json({ error: 'Campo stage obrigatório.' });
    const lead = await updateStage(+req.params.id, stage, notes || null);
    res.json({ ok: true, lead });
  } catch (err) { next(err); }
});

// ── GET /api/leads/stages ─────────────────────────────────────────────────────
router.get('/leads-stages', requireAdmin, (req, res) => {
  res.json({ stages: VALID_STAGES });
});

module.exports = router;
