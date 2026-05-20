/**
 * Webhook receptor pro Flowter (AdvBox).
 *
 * O Flowter é o webhook nativo do AdvBox. Configurável pra disparar quando:
 *   - Tarefa é concluída
 *   - Processo muda de fase
 *
 * V2: RECEBE + PERSISTE + REAGE.
 *   - Invalida caches afetados (lawsuits/flow/distribution/audit/transactions)
 *   - Em mudança de fase, dispara runCycle({ onlyLawsuitId }) em fire-and-forget
 *     (advisory lock interno do auto-workflow serializa contra o cron horário)
 *   - Marca processed_at/processed_ok na linha do evento depois das side effects
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
const cache = require('../../../cache');

const router = Router();

// Eventos que devem disparar runCycle. Heurística defensiva: além do match
// explícito por nome, qualquer payload com `stage` setado conta como mudança
// de fase. Eventos só de tarefa (sem stage) entram só nas invalidações.
const STAGE_EVENT_REGEX = /(stage|fase|phase|move|moved|changed)/i;

/**
 * Processa side effects de um evento Flowter já persistido.
 * Fire-and-forget: chamado SEM await pelo handler do webhook, com .catch()
 * pra não vazar unhandledRejection. Atualiza processed_at/processed_ok
 * na linha do evento ao final (sucesso ou erro).
 */
async function processFlowterEvent({ eventId, eventType, lawsuitId, postId, stage }) {
  const errors = [];

  // 1. Invalidações de cache (síncronas, baratas)
  try {
    if (lawsuitId) {
      cache.invalidate('lawsuits');
      cache.invalidate('flow');
      cache.invalidate('distribution');
      cache.invalidate('audit_usage');
      cache.invalidate('audit-responsible');
    }
    if (postId) {
      // Tarefa concluída pode afetar parcelas/transações
      cache.invalidate('transactions');
      cache.invalidate('inadimplentes_full');
    }
  } catch (e) {
    errors.push(`cache: ${e.message}`);
  }

  // 2. Trigger auto-workflow só se mudança de fase + lawsuit conhecido.
  // Lazy-require pra não criar dependência circular no boot — mesmo padrão
  // do audit-actions.js:207.
  const isStageChange = !!stage || STAGE_EVENT_REGEX.test(String(eventType || ''));
  if (lawsuitId && isStageChange) {
    try {
      const { runCycle } = require('../../../services/auto-workflow');
      const result = await runCycle({
        onlyLawsuitId: lawsuitId,
        forceRefresh: true,
        logger: console,
      });
      if (result?.skipped) {
        console.log(`[Flowter] runCycle ignorado (${result.reason}) — cron horário pega no próximo ciclo`);
      } else {
        console.log(`[Flowter] runCycle OK — criados=${result?.criados ?? 0}, novos=${result?.novos ?? 0}`);
      }
    } catch (e) {
      errors.push(`runCycle: ${e.message}`);
    }
  }

  // 3. Marca processado no banco
  const ok = errors.length === 0;
  try {
    await query(
      `UPDATE advbox_flowter_events
       SET processed_at = NOW(), processed_ok = $1, error_message = $2
       WHERE id = $3`,
      [ok, ok ? null : errors.join('; ').slice(0, 1000), eventId]
    );
  } catch (e) {
    console.error('[Flowter] Falha ao marcar processed_at:', e.message);
  }
}

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
    const insertRes = await query(
      `INSERT INTO advbox_flowter_events
       (event_type, lawsuit_id, post_id, stage, payload, source_ip, processed_ok)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)
       RETURNING id`,
      [
        String(eventType).slice(0, 200),
        lawsuitId,
        postId,
        stage ? String(stage).slice(0, 200) : null,
        JSON.stringify(payload),
        sourceIp,
      ]
    );
    const eventId = insertRes.rows[0].id;

    // Log estruturado pra debug
    console.log('[Flowter] OK', {
      id: eventId,
      event: eventType,
      lawsuit_id: lawsuitId,
      post_id: postId,
      stage,
    });

    // Fire-and-forget: side effects rodam após a resposta. .catch() obrigatório
    // pra não vazar unhandledRejection. Tudo dentro do helper é idempotente
    // (cache invalidate é no-op se a chave nem existe; runCycle tem advisory lock).
    processFlowterEvent({ eventId, eventType, lawsuitId, postId, stage })
      .catch(err => console.error('[Flowter] Side-effect falhou:', err.message));

    // 200 com body curto — Flowter normalmente não precisa de muito retorno
    return res.status(200).json({ ok: true, received: true, eventId });
  } catch (err) {
    console.error('[Flowter] Erro ao persistir:', err.message);
    // 200 mesmo em erro pra Flowter não ficar tentando reenviar — temos log
    return res.status(200).json({ ok: false, error: err.message });
  }
});

module.exports = router;
