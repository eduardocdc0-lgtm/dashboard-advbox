/**
 * Rotas administrativas — observabilidade de secrets, jobs e health.
 *
 * Todas exigem role admin.
 */

'use strict';

const { Router } = require('express');
const { requireAdmin } = require('../../../middleware/auth');
const jobsRegistry = require('../../../services/jobs-registry');

const router = Router();

// ── GET /api/admin/team-status ───────────────────────────────────────────────
// Mostra quais ADV_USER_* estão configurados. NÃO expõe valores das senhas.
router.get('/admin/team-status', requireAdmin, (req, res) => {
  const { TEAM_USERS } = require('../../../services/team-users');
  const status = TEAM_USERS.map(u => {
    const envName = `ADV_USER_${u.username.toUpperCase()}`;
    const v = process.env[envName];
    return {
      username: u.username,
      name: u.name,
      role: u.role,
      advboxUserId: u.advboxUserId,
      env_var: envName,
      secret_setado: !!(v && v.length > 0),
      senha_len: v ? v.length : 0,
    };
  });
  const total = status.length;
  const setados = status.filter(s => s.secret_setado).length;
  res.json({
    total_usuarios: total,
    com_senha: setados,
    sem_senha: total - setados,
    detalhes: status,
    hint: setados < total
      ? `Faltam ${total - setados} Secret(s). Criar com os nomes 'env_var' marcados como secret_setado:false.`
      : 'Todos os usuários têm senha configurada.',
  });
});

// ── GET /api/healthz/jobs ────────────────────────────────────────────────────
// Status real dos crons + secrets críticos. Resposta orientada a "tá no ar?".
router.get('/healthz/jobs', requireAdmin, (req, res) => {
  const jobs = jobsRegistry.snapshot();
  const secrets = [
    { name: 'DATABASE_URL',        required: true,  set: !!process.env.DATABASE_URL },
    { name: 'SESSION_SECRET',      required: true,  set: !!process.env.SESSION_SECRET },
    { name: 'ADVBOX_TOKEN',        required: true,  set: !!process.env.ADVBOX_TOKEN },
    { name: 'DISCORD_WEBHOOK_URL', required: false, set: !!process.env.DISCORD_WEBHOOK_URL },
    { name: 'CHATGURU_API_KEY',    required: false, set: !!process.env.CHATGURU_API_KEY },
    { name: 'META_TOKEN',          required: false, set: !!process.env.META_TOKEN },
  ];

  const jobsOk     = jobs.every(j => j.status === 'running' || j.status === 'disabled');
  const requiredOk = secrets.filter(s => s.required).every(s => s.set);

  res.json({
    overall: jobsOk && requiredOk ? 'ok' : 'attention',
    checked_at: new Date().toISOString(),
    jobs,
    secrets,
    hint: !requiredOk
      ? 'Falta(m) secret(s) obrigatório(s) — checar lista acima.'
      : !jobsOk
        ? 'Um ou mais crons não iniciaram — checar status individual.'
        : 'Tudo no ar.',
  });
});

module.exports = router;
