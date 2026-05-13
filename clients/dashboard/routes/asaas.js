/**
 * Rotas ASAAS — geração de cobranças em lote + webhook de pagamento.
 *
 * - POST /api/asaas/charge-batch  → cria cobranças pra lista de devedores
 * - GET  /api/asaas/charges       → lista cobranças já geradas no ASAAS
 * - GET  /api/asaas/pix-qr/:id    → proxy do QR PIX (base64) sem expor token
 * - POST /api/asaas/webhook       → endpoint público pra ASAAS notificar pagamento
 * - GET  /api/asaas/status        → diagnóstico: token configurado? sandbox/prod?
 */

'use strict';

const { Router } = require('express');
const { AsaasClient } = require('../../../services/asaas-client');
const { createBatch } = require('../../../services/asaas-batch');
const { requireAdmin } = require('../../../middleware/auth');

const router = Router();

// Cliente singleton (carrega no boot; cai pra null se token ausente)
let asaasClient = null;
function getClient() {
  if (asaasClient) return asaasClient;
  const token = process.env.ASAAS_TOKEN;
  if (!token) return null;
  asaasClient = new AsaasClient(token, {
    baseURL: process.env.ASAAS_BASE_URL || undefined,
  });
  return asaasClient;
}

// ── GET /api/asaas/status ─────────────────────────────────────────────────
// Diagnóstico rápido — usado pela aba Diagnóstico do dashboard.
router.get('/asaas/status', requireAdmin, (req, res) => {
  const client = getClient();
  if (!client) {
    return res.json({
      configured: false,
      message: 'ASAAS_TOKEN não configurado nos Secrets',
    });
  }
  res.json({
    configured: true,
    sandbox:    client.isSandbox,
    base_url:   client.baseURL,
  });
});

// ── POST /api/asaas/charge-batch ──────────────────────────────────────────
// Body: {
//   items: [{ name, cpfCnpj, email?, phone?, value, dueDate, description?, externalReference? }],
//   billingType?: 'BOLETO'|'PIX'|'UNDEFINED',
//   interestPercent?: number, finePercent?: number,
// }
router.post('/asaas/charge-batch', requireAdmin, async (req, res, next) => {
  try {
    const client = getClient();
    if (!client) {
      return res.status(503).json({ error: 'ASAAS_TOKEN não configurado' });
    }
    const { items, billingType, interestPercent, finePercent } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items: array não vazio obrigatório' });
    }
    if (items.length > 50) {
      return res.status(400).json({ error: 'máx. 50 cobranças por lote' });
    }

    const result = await createBatch(client, items, {
      billingType, interestPercent, finePercent,
    });

    res.json(result);
  } catch (err) { next(err); }
});

// ── GET /api/asaas/charges ────────────────────────────────────────────────
// Lista cobranças no ASAAS (passthrough simples)
router.get('/asaas/charges', requireAdmin, async (req, res, next) => {
  try {
    const client = getClient();
    if (!client) return res.status(503).json({ error: 'ASAAS_TOKEN não configurado' });
    const data = await client.listPayments({
      status:   req.query.status,
      customer: req.query.customer,
      limit:    Math.min(100, Number(req.query.limit) || 50),
      offset:   Math.max(0, Number(req.query.offset) || 0),
    });
    res.json(data);
  } catch (err) { next(err); }
});

// ── GET /api/asaas/pix-qr/:id ─────────────────────────────────────────────
// Proxy pro QR PIX (base64 + copia-cola). Evita expor token no frontend.
router.get('/asaas/pix-qr/:id', requireAdmin, async (req, res, next) => {
  try {
    const client = getClient();
    if (!client) return res.status(503).json({ error: 'ASAAS_TOKEN não configurado' });
    const data = await client.getPaymentPixQrCode(req.params.id);
    res.json(data);
  } catch (err) { next(err); }
});

// ── POST /api/asaas/webhook ───────────────────────────────────────────────
// Endpoint PÚBLICO — ASAAS chama aqui quando o status do payment muda.
// Eventos relevantes: PAYMENT_RECEIVED, PAYMENT_CONFIRMED, PAYMENT_OVERDUE, PAYMENT_DELETED.
// V1: só LOGA. V2: atualiza transaction no AdvBox via /transactions API.
router.post('/asaas/webhook', async (req, res) => {
  try {
    const body = req.body || {};
    const event = body.event;
    const payment = body.payment || {};
    console.log('[ASAAS webhook]', {
      event,
      payment_id:       payment.id,
      status:           payment.status,
      external_ref:     payment.externalReference,
      value:            payment.value,
      net_value:        payment.netValue,
      customer:         payment.customer,
      paid_at:          payment.confirmedDate || payment.paymentDate,
    });
    // TODO V2: se event === 'PAYMENT_RECEIVED' || 'PAYMENT_CONFIRMED',
    //   procurar transaction com externalReference == payment.externalReference
    //   e marcar como paga no AdvBox /transactions.
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[ASAAS webhook] erro:', err);
    res.status(200).json({ ok: false });   // sempre 200 pra ASAAS não reenviar
  }
});

module.exports = router;
