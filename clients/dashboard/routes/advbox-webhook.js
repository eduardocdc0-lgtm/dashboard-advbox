/**
 * Webhook receptor pro Flowter (AdvBox).
 *
 * O Flowter é o webhook nativo do AdvBox. Configurável pra disparar quando:
 *   - Tarefa é concluída
 *   - Processo muda de fase
 *
 * V1 (este): só RECEBE e PERSISTE em advbox_flowter_events. Não reage.
 * V2 (depois de ver payload real): adiciona reações:
 *   - Invalidar caches (inadimplentes, audit, overview)
 *   - Disparar runCycle({ onlyLawsuitId }) sem polling
 *   - Notificar via WhatsApp/email se evento crítico
 *
 * SETUP:
 *   1. Gerar token: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   2. Replit Secrets: ADVBOX_FLOWTER_TOKEN=<valor>
 *   3. Republish
 *   4. No AdvBox > Flowter, configurar:
 *      URL:    https://advbox-dashboard.replit.app/api/advbox/webhook/flowter
 *      Header: x-flowter-token: <mesmo valor>
 *      Método: POST
 *      Triggers: tarefa concluída + fase mudada (separadamente)
 *   5. Triggerar 1 evento de teste e ver em /api/admin/flowter-events
 */

'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const { query } = require('../../../services/db');

const router = Router();

// ── POST /api/advbox/webhook/flowter ─────────────────────────────────────────
router.post('/advbox/webhook/flowter', async (req, res) => {
  const expectedToken = process.env.ADVBOX_FLOWTER_TOKEN;
  const sourceIp = req.ip;

  // Token obrigatório. Sem ele = recusa silenciosamente (204).
  if (!expectedToken) {
    console.error('[Flowter] ADVBOX_FLOWTER_TOKEN não configurado — recusando');
    return res.status(204).end();
  }

  // Comparação timing-safe + resposta SEMPRE igual em rejeição
  const received = String(req.headers['x-flowter-token'] || '');
  const tokensMatch =
    received.length === expectedToken.length &&
    crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expectedToken));

  if (!tokensMatch) {
    console.warn('[Flowter] Token inválido', { ip: sourceIp });
    return res.status(204).end();
  }

  const payload = req.body || {};

  // Extração defensiva — não sabemos schema exato ainda, pegamos o que dá
  const eventType =
    payload.event ||
    payload.event_type ||
    payload.type ||
    payload.action ||
    'unknown';

  const lawsuitId =
    Number(payload.lawsuit_id) ||
    Number(payload.lawsuits_id) ||
    Number(payload.lawsuit?.id) ||
    Number(payload.process_id) ||
    null;

  const postId =
    Number(payload.post_id) ||
    Number(payload.posts_id) ||
    Number(payload.post?.id) ||
    Number(payload.task?.id) ||
    null;

  const stage =
    payload.stage ||
    payload.new_stage ||
    payload.lawsuit?.stage ||
    payload.process_stage ||
    null;

  try {
    await query(
      `INSERT INTO advbox_flowter_events
       (event_type, lawsuit_id, post_id, stage, payload, source_ip, processed_ok)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
      [
        String(eventType).slice(0, 200),
        lawsuitId,
        postId,
        stage ? String(stage).slice(0, 200) : null,
        JSON.stringify(payload),
        sourceIp,
      ]
    );

    // Log estruturado pra debug
    console.log('[Flowter] OK', {
      event: eventType,
      lawsuit_id: lawsuitId,
      post_id: postId,
      stage,
    });

    // 200 com body curto — Flowter normalmente não precisa de muito retorno
    return res.status(200).json({ ok: true, received: true });
  } catch (err) {
    console.error('[Flowter] Erro ao persistir:', err.message);
    // 200 mesmo em erro pra Flowter não ficar tentando reenviar — temos log
    return res.status(200).json({ ok: false, error: err.message });
  }
});

module.exports = router;
