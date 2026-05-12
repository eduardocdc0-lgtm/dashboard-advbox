/**
 * Registry simples de jobs (crons) — cada cron registra seu estado no boot.
 *
 * Permite que /api/healthz/jobs reporte se cada cron realmente subiu, foi
 * desabilitado por env, ou abortou por falta de secret.
 *
 * Status:
 *   running   — cron agendado e ativo
 *   disabled  — desligado intencionalmente via env
 *   skipped   — não subiu por dependência ausente (ex: webhook não configurado)
 */

'use strict';

const jobs = new Map();

function register(name, info) {
  jobs.set(name, {
    name,
    status: info.status || 'unknown',
    cronExpr: info.cronExpr || null,
    timezone: info.timezone || null,
    reason: info.reason || null,
    registered_at: new Date().toISOString(),
  });
}

function snapshot() {
  return [...jobs.values()];
}

module.exports = { register, snapshot };
