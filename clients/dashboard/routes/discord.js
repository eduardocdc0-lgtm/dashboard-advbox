/**
 * Rotas admin pra agendar/listar/cancelar mensagens no Discord.
 *
 * Todas exigem role admin (controla agenda do escritório).
 */

'use strict';

const { Router } = require('express');
const { requireAuth } = require('../../../middleware/auth');
const {
  scheduleMessage,
  listScheduled,
  cancelMessage,
  sendWebhook,
  runDueMessages,
} = require('../../../services/discord-scheduler');

const router = Router();

function adminOnly(req, res, next) {
  if (req.session.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Só admin acessa rotas de Discord.' });
  }
  next();
}

// POST /api/admin/discord/schedule
// body: { content, sendAt, repeats?, username?, channelUrl? }
router.post('/admin/discord/schedule', requireAuth, adminOnly, async (req, res) => {
  try {
    const result = await scheduleMessage({
      ...req.body,
      createdBy: req.session.user.username,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/admin/discord/list?includeSent=1
router.get('/admin/discord/list', requireAuth, adminOnly, async (req, res) => {
  try {
    const items = await listScheduled({ includeSent: req.query.includeSent === '1' });
    res.json({ ok: true, total: items.length, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/discord/cancel
// body: { id }
router.post('/admin/discord/cancel', requireAuth, adminOnly, async (req, res) => {
  try {
    if (!req.body?.id) return res.status(400).json({ error: 'id obrigatório' });
    await cancelMessage(Number(req.body.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/discord/send-now
// body: { content, username?, channelUrl? }  — envia imediatamente (teste)
router.post('/admin/discord/send-now', requireAuth, adminOnly, async (req, res) => {
  try {
    const { content, username, channelUrl } = req.body || {};
    if (!content) return res.status(400).json({ error: 'content obrigatório' });
    const result = await sendWebhook(content, { username, url: channelUrl });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/discord/run-now — força um ciclo (debug)
router.post('/admin/discord/run-now', requireAuth, adminOnly, async (req, res) => {
  try {
    const result = await runDueMessages();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/discord/test — disparo simples pra confirmar webhook
router.get('/discord/test', requireAuth, adminOnly, async (req, res) => {
  try {
    const result = await sendWebhook(`✅ Webhook OK — disparado por ${req.session.user?.name || req.session.user?.username || 'admin'} em ${new Date().toLocaleString('pt-BR')}`, {});
    res.json({ ok: true, ...result, hint: 'Confere o canal do Discord.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
