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
const { query } = require('../../../services/db');

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

// ── Helpers de override ──────────────────────────────────────────────────
// Override é indexado preferencialmente por lawsuit_id (parcelas do mesmo
// processo herdam o pagador). Fallback pra transaction_id quando não há lawsuit.

// ── GET /api/asaas/payer-overrides ───────────────────────────────────────
// Retorna mapa indexado por chaves "law_<id>" e "tx_<id>", pra o front
// resolver na hora de hidratar o modal sem fazer N requests.
router.get('/asaas/payer-overrides', requireAdmin, async (req, res, next) => {
  try {
    const r = await query(
      `SELECT lawsuit_id, transaction_id, payer_name, payer_cpf_cnpj, payer_email, payer_phone
       FROM asaas_payer_overrides`
    );
    const map = {};
    for (const row of r.rows) {
      const data = {
        name:    row.payer_name,
        cpfCnpj: row.payer_cpf_cnpj,
        email:   row.payer_email,
        phone:   row.payer_phone,
      };
      if (row.lawsuit_id) map[`law_${row.lawsuit_id}`] = data;
      if (row.transaction_id) map[`tx_${row.transaction_id}`] = data;
    }
    res.json({ overrides: map, count: r.rows.length });
  } catch (err) { next(err); }
});

// ── POST /api/asaas/payer-overrides ──────────────────────────────────────
// Body: { lawsuit_id?, transaction_id?, payer_name, payer_cpf_cnpj, payer_email?, payer_phone? }
// Upsert: usa lawsuit_id se presente, senão transaction_id. Exige pelo menos 1.
router.post('/asaas/payer-overrides', requireAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const lawsuit_id     = b.lawsuit_id ? Number(b.lawsuit_id) : null;
    const transaction_id = b.transaction_id ? Number(b.transaction_id) : null;
    const payer_name     = (b.payer_name || '').trim();
    const payer_cpf_cnpj = String(b.payer_cpf_cnpj || '').replace(/\D/g, '');
    const payer_email    = b.payer_email || null;
    const payer_phone    = b.payer_phone || null;

    if (!lawsuit_id && !transaction_id) {
      return res.status(400).json({ error: 'lawsuit_id ou transaction_id obrigatório' });
    }
    if (!payer_name || !payer_cpf_cnpj) {
      return res.status(400).json({ error: 'payer_name e payer_cpf_cnpj obrigatórios' });
    }
    if (payer_cpf_cnpj.length !== 11 && payer_cpf_cnpj.length !== 14) {
      return res.status(400).json({ error: 'CPF (11) ou CNPJ (14) dígitos' });
    }

    // Upsert manual — UNIQUE parcial não bate em ON CONFLICT direto com NULL.
    if (lawsuit_id) {
      await query(`
        INSERT INTO asaas_payer_overrides (lawsuit_id, payer_name, payer_cpf_cnpj, payer_email, payer_phone)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (lawsuit_id) WHERE lawsuit_id IS NOT NULL
        DO UPDATE SET payer_name=$2, payer_cpf_cnpj=$3, payer_email=$4, payer_phone=$5
      `, [lawsuit_id, payer_name, payer_cpf_cnpj, payer_email, payer_phone]);
    } else {
      await query(`
        INSERT INTO asaas_payer_overrides (transaction_id, payer_name, payer_cpf_cnpj, payer_email, payer_phone)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (transaction_id) WHERE lawsuit_id IS NULL AND transaction_id IS NOT NULL
        DO UPDATE SET payer_name=$2, payer_cpf_cnpj=$3, payer_email=$4, payer_phone=$5
      `, [transaction_id, payer_name, payer_cpf_cnpj, payer_email, payer_phone]);
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── DELETE /api/asaas/payer-overrides/:key ───────────────────────────────
// key formato: "law_123" ou "tx_456"
router.delete('/asaas/payer-overrides/:key', requireAdmin, async (req, res, next) => {
  try {
    const key = String(req.params.key);
    const [kind, idStr] = key.split('_');
    const id = Number(idStr);
    if (!id) return res.status(400).json({ error: 'key inválida' });
    if (kind === 'law') await query('DELETE FROM asaas_payer_overrides WHERE lawsuit_id = $1', [id]);
    else if (kind === 'tx') await query('DELETE FROM asaas_payer_overrides WHERE transaction_id = $1', [id]);
    else return res.status(400).json({ error: 'kind inválido (use law_ ou tx_)' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── GET /api/asaas/payments-received ─────────────────────────────────────
// Lista pagamentos que o webhook ASAAS já processou — usado pelo front pra
// marcar cards com "✅ PAGO via ASAAS" sem precisar bater na API do ASAAS.
router.get('/asaas/payments-received', requireAdmin, async (req, res, next) => {
  try {
    const r = await query(`
      SELECT asaas_payment_id, external_reference, status, value, net_value, paid_at, event, advbox_synced
      FROM asaas_payment_history
      WHERE status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
      ORDER BY paid_at DESC NULLS LAST
      LIMIT 200
    `);
    const byRef = {};
    for (const row of r.rows) {
      if (!row.external_reference) continue;
      // Última atualização ganha (mais recente primeiro pela ORDER BY)
      if (!byRef[row.external_reference]) byRef[row.external_reference] = row;
    }
    res.json({ payments: byRef, count: r.rows.length });
  } catch (err) { next(err); }
});

// ── POST /api/asaas/webhook ───────────────────────────────────────────────
// Endpoint PÚBLICO — ASAAS bate aqui quando o status do payment muda.
// Eventos relevantes: PAYMENT_RECEIVED, PAYMENT_CONFIRMED, PAYMENT_OVERDUE,
// PAYMENT_DELETED, PAYMENT_REFUNDED, PAYMENT_RECEIVED_IN_CASH.
//
// V2 (este): persiste tudo em asaas_payment_history. Pra PAYMENT_RECEIVED/
// CONFIRMED, tenta marcar como paga no AdvBox via /transactions; se a API
// não permitir, mantém o registro local pro front exibir badge "PAGO".
router.post('/asaas/webhook', async (req, res) => {
  try {
    const body    = req.body || {};
    const event   = body.event;
    const payment = body.payment || {};

    console.log('[ASAAS webhook]', {
      event,
      payment_id:   payment.id,
      status:       payment.status,
      external_ref: payment.externalReference,
      value:        payment.value,
      paid_at:      payment.confirmedDate || payment.paymentDate,
    });

    if (!payment.id) {
      // Eventos sem payment (raro) — só ack
      return res.status(200).json({ ok: true, note: 'no payment id' });
    }

    // Persiste / atualiza histórico
    let synced = false;
    let syncErr = null;

    // Tentativa V2 (best-effort): marcar transaction como paga no AdvBox quando
    // recebido. Como o endpoint PATCH /transactions/:id pode não estar exposto
    // no plano atual, captura erro silenciosamente e segue.
    if ((event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED' || event === 'PAYMENT_RECEIVED_IN_CASH')
        && payment.externalReference && payment.externalReference.startsWith('tx_')) {
      const txId = Number(payment.externalReference.slice(3));
      if (txId && process.env.ADVBOX_TOKEN) {
        try {
          const fetch = require('node-fetch');
          const r = await fetch(`https://app.advbox.com.br/api/v1/transactions/${txId}`, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${process.env.ADVBOX_TOKEN}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: JSON.stringify({
              date_payment: (payment.confirmedDate || payment.paymentDate || new Date().toISOString().slice(0, 10)),
            }),
          });
          if (r.ok) synced = true;
          else syncErr = `AdvBox HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`;
        } catch (e) {
          syncErr = e.message || String(e);
        }
      }
    }

    await query(`
      INSERT INTO asaas_payment_history (
        asaas_payment_id, external_reference, event, status,
        value, net_value, customer_id, paid_at, raw_payload, advbox_synced, advbox_sync_error
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (asaas_payment_id)
      DO UPDATE SET
        event             = EXCLUDED.event,
        status            = EXCLUDED.status,
        value             = EXCLUDED.value,
        net_value         = EXCLUDED.net_value,
        paid_at           = EXCLUDED.paid_at,
        raw_payload       = EXCLUDED.raw_payload,
        advbox_synced     = asaas_payment_history.advbox_synced OR EXCLUDED.advbox_synced,
        advbox_sync_error = COALESCE(EXCLUDED.advbox_sync_error, asaas_payment_history.advbox_sync_error)
    `, [
      payment.id,
      payment.externalReference || null,
      event || 'UNKNOWN',
      payment.status || 'UNKNOWN',
      payment.value || null,
      payment.netValue || null,
      payment.customer || null,
      (payment.confirmedDate || payment.paymentDate) || null,
      JSON.stringify(body),
      synced,
      syncErr,
    ]);

    res.status(200).json({ ok: true, synced });
  } catch (err) {
    console.error('[ASAAS webhook] erro:', err);
    // Sempre 200 pra ASAAS não ficar reenviando (a fila do ASAAS é rude)
    res.status(200).json({ ok: false, error: err.message });
  }
});

module.exports = router;
