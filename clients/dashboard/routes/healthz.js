/**
 * Healthcheck PÚBLICO pra UptimeRobot / monitores externos.
 *
 * GET /api/healthz
 *   200 OK             → tudo saudável (DB up, jobs running)
 *   503 Service Unavailable → algo degradado (DB down OU job parado)
 *
 * IMPORTANTE: rota é PÚBLICA (não exige auth) pra UptimeRobot grátis
 * conseguir pingar. Por isso NÃO retorna dado sensível — só status agregado.
 *
 * Pra ver detalhes (lista de jobs, secrets faltando, etc) use o endpoint
 * autenticado /api/healthz/jobs (em routes/admin.js).
 *
 * Configurar UptimeRobot:
 *   1. https://uptimerobot.com (free: 50 monitors, ping 5min)
 *   2. New Monitor → HTTP(s)
 *   3. URL: https://advbox-dashboard.replit.app/api/healthz
 *   4. Interval: 5 minutes
 *   5. Alert Contacts: e-mail + SMS do Eduardo
 *   6. (opcional) Configurar Alert After: 2 falhas (= 10min real down)
 */

'use strict';

const { Router } = require('express');
const { query } = require('../../../services/db');
const jobsRegistry = require('../../../services/jobs-registry');

const router = Router();

// Versão lida do package.json no boot (não no request — evita IO)
let APP_VERSION = 'unknown';
try {
  APP_VERSION = require('../../../package.json').version || 'unknown';
} catch (_) { /* ignora */ }

// Timeout do DB ping pra não travar o monitor se Postgres ficar lento
const DB_TIMEOUT_MS = 3000;

function timedDbPing() {
  return Promise.race([
    query('SELECT 1 AS ok').then(() => ({ status: 'up' })),
    new Promise(resolve => setTimeout(
      () => resolve({ status: 'slow', error: `timeout >${DB_TIMEOUT_MS}ms` }),
      DB_TIMEOUT_MS
    )),
  ]).catch(err => ({ status: 'down', error: err.message }));
}

router.get('/healthz', async (req, res) => {
  const checks = {
    db: await timedDbPing(),
    jobs: { status: 'unknown', total: 0, problems: 0 },
  };

  // Snapshot dos jobs registrados (running | disabled | skipped | unknown)
  try {
    const all = jobsRegistry.snapshot();
    const problems = all.filter(j =>
      j.status !== 'running' && j.status !== 'disabled'
    ).length;
    checks.jobs = {
      status: problems === 0 ? 'ok' : 'attention',
      total: all.length,
      problems,
    };
  } catch (e) {
    checks.jobs = { status: 'error', error: e.message };
  }

  const dbOk   = checks.db.status === 'up';
  const jobsOk = checks.jobs.status === 'ok';
  const overall = dbOk && jobsOk ? 'ok' : 'degraded';

  const payload = {
    status: overall,
    version: APP_VERSION,
    uptime_s: Math.floor(process.uptime()),
    checked_at: new Date().toISOString(),
    checks,
  };

  // 200 quando ok, 503 quando degraded — UptimeRobot lê o status code
  res.status(overall === 'ok' ? 200 : 503).json(payload);
});

module.exports = router;
