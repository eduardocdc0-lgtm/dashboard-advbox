/**
 * Audit trail genérico de mutações do dashboard.
 *
 * Reusa a tabela audit_actions (originalmente do auditor de 1-clique). O campo
 * action_type é text livre — usamos namespacing por feature (ex:
 * 'finance.parcela.delete', 'asaas.payer-overrides.create') pra diferenciar
 * mutações novas das do auditor original (ex: 'cobrar-responsavel').
 *
 * Convenção de action namespace:
 *   <feature>.<entity>.<verb>
 *   finance.parcela.delete         (DELETE /api/finance/parcela/:id)
 *   asaas.payer-overrides.create   (POST   /api/asaas/payer-overrides)
 *   birthday.config.update         (POST   /api/birthday/config)
 *   audit-responsible.resolve      (POST   /api/audit-responsible/resolve)
 *
 * Falha-aberta: se o INSERT falhar (DB down etc), só loga no console e segue.
 * Mutação principal não pode ser bloqueada por falha do auditor. Trade-off
 * conhecido: outage de DB = perda da linha de auditoria, mas a mutação
 * original ou também falhou (caminho normal) ou já se persistiu noutro
 * sistema (AdvBox/ASAAS) cuja própria timeline guarda o fato.
 *
 * ENDPOINTS NÃO COBERTOS aqui (têm tabelas dedicadas próprias):
 *   - asaas charge-batch     → asaas_payment_history
 *   - asaas webhook          → asaas_payment_history
 *   - audit cobrar-cau-whats → audit_cobranca_log
 *   - audit ignorar-tarefa   → audit_ignored
 *   - birthday send/send-all → birthday_messages_log
 *   - advbox flowter webhook → advbox_flowter_events
 */

'use strict';

const { query } = require('./db');

/**
 * @param {object} opts
 * @param {object} opts.actor          req.session.user (precisa .username e opcionalmente .advboxUserId)
 * @param {string} opts.action         namespace.entidade.verbo — ver convenção acima
 * @param {object} [opts.payload]      o que foi enviado/configurado (sanitize secrets antes)
 * @param {object} [opts.response]     resposta da chamada externa (AdvBox/ASAAS) se houve
 * @param {number} [opts.lawsuitId]    target_lawsuit_id (opcional)
 * @param {number} [opts.targetUserId] target_user_id    (opcional)
 * @param {boolean} opts.success
 * @param {string} [opts.error]        mensagem de erro (truncada a 500 chars)
 * @returns {Promise<void>}
 */
async function logMutation({
  actor, action, payload, response, lawsuitId, targetUserId, success, error,
}) {
  try {
    await query(
      `INSERT INTO audit_actions
         (actor_username, actor_advbox_id, action_type, target_lawsuit_id, target_user_id,
          problema_payload, advbox_response, success, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        actor?.username || 'unknown',
        actor?.advboxUserId || null,
        String(action || 'unknown').slice(0, 200),
        lawsuitId    ? Number(lawsuitId)    : null,
        targetUserId ? Number(targetUserId) : null,
        JSON.stringify(payload || {}),
        response ? JSON.stringify(response) : null,
        !!success,
        error ? String(error).slice(0, 500) : null,
      ]
    );
  } catch (e) {
    // Fail-open — log no console mas não propaga
    console.error(`[mutation-log] insert falhou para action=${action}: ${e.message}`);
  }
}

module.exports = { logMutation };
