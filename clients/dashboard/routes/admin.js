/**
 * Rotas administrativas — observabilidade de secrets, jobs e health.
 *
 * Todas exigem role admin.
 */

'use strict';

const { Router } = require('express');
const { requireAdmin } = require('../../../middleware/auth');
const jobsRegistry = require('../../../services/jobs-registry');
const { query } = require('../../../services/db');

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
    // Sessão: aceita SESSION_KEYS (preferido, suporta rotação) OU SESSION_SECRET (legacy)
    { name: 'SESSION_KEYS or SESSION_SECRET', required: true, set: !!(process.env.SESSION_KEYS || process.env.SESSION_SECRET) },
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

// ── GET /api/admin/route-usage ───────────────────────────────────────────────
// Telemetria de uso de rota (alimentada pelo middleware/access-log.js).
// Pra Eduardo decidir o que cortar do dashboard sem chutar:
//
//   GET /api/admin/route-usage          → últimos 7 dias (default)
//   GET /api/admin/route-usage?days=14  → janela custom (1..30)
//   GET /api/admin/route-usage?cleanup=1 → bonus: roda DELETE de >30 dias
//
// Retorna 3 listas:
//   - top: rotas mais usadas (= core do produto)
//   - bottom: rotas com 1-3 hits (= candidatas a poda)
//   - never_used: rotas registradas que NUNCA apareceram no log (= morto certo)
//
// CUIDADO: rotas POST não são logadas (só GET). Pra mapear cobertura completa
// olhe na sidebar do SPA e correlacione manualmente.
router.get('/admin/route-usage', requireAdmin, async (req, res, next) => {
  try {
    const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));

    // Cleanup opcional (retenção 30 dias)
    if (req.query.cleanup === '1') {
      const del = await query(
        `DELETE FROM route_access_log WHERE accessed_at < NOW() - INTERVAL '30 days'`
      );
      return res.json({ cleanup: true, deleted: del.rowCount });
    }

    const stats = await query(
      `SELECT route,
              COUNT(*)::int        AS hits,
              COUNT(DISTINCT user_id)::int AS users,
              MAX(accessed_at)     AS last_use,
              MIN(accessed_at)     AS first_use
         FROM route_access_log
        WHERE accessed_at > NOW() - ($1::int || ' days')::interval
        GROUP BY route
        ORDER BY hits DESC`,
      [days]
    );

    const all = stats.rows;
    const top = all.slice(0, 20);
    const bottom = all.filter(r => r.hits <= 3).slice(-20);

    // Rotas registradas que NUNCA apareceram (poda segura)
    // Fonte: routes registradas + algumas GETs que conheço — mantém lista
    // simples; pode ser expandido se a auditoria virar recorrente.
    const REGISTERED_GET_ROUTES = [
      '/api/lawsuits', '/api/customers', '/api/transactions', '/api/settings',
      '/api/flow', '/api/posts', '/api/last-movements',
      '/api/distribution', '/api/evolucao',
      '/api/meta/campaign-roi',
      '/api/incomplete-registrations',
      '/api/audit-debug-stages', '/api/audit-responsible',
      '/api/audit/usage', '/api/audit/kanban-financeiro',
      '/api/controller/overview', '/api/controller/snapshot', '/api/controller/tendencia',
      '/api/birthday/hoje', '/api/birthday/mes', '/api/birthday/historico', '/api/birthday/config',
      '/api/inss-conference/history',
      '/api/petitions/by-person',
      '/api/cash-flow/upcoming',
      '/api/esteira',
      '/api/finance/entries', '/api/finance/inadimplentes', '/api/finance/calendar',
      '/api/overview',
      '/api/admin/discord', '/api/admin/team-status',
      '/api/sentencas/placar',
      '/api/asaas/charges', '/api/asaas/payer-overrides', '/api/asaas/payments-received',
      '/api/publications/recent',
      '/api/leads', '/api/leads/stats',
      '/api/birthdays',
    ];
    const usedSet = new Set(all.map(r => r.route));
    const never_used = REGISTERED_GET_ROUTES.filter(r => !usedSet.has(r));

    res.json({
      window_days: days,
      total_requests: all.reduce((s, r) => s + r.hits, 0),
      distinct_routes: all.length,
      top,
      bottom,
      never_used,
      hint: 'top = core | bottom (≤3 hits) = candidatos a poda | never_used = morto seguro',
    });
  } catch (err) { next(err); }
});

module.exports = router;
