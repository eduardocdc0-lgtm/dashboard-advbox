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
const { fetchAllPosts } = require('../../../services/data');

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

// Parser de data robusto — AdvBox mistura ISO e BR (dd/mm/yyyy).
// Date.parse() puro retorna NaN pra formato BR — bug que zerou a 1ª versão.
function parseAdvboxDate(s) {
  if (!s) return null;
  const m1 = /^(\d{4})-(\d{2})-(\d{2})[ T]?(\d{2})?:?(\d{2})?:?(\d{2})?/.exec(s);
  if (m1) return new Date(Number(m1[1]), Number(m1[2]) - 1, Number(m1[3]),
                          Number(m1[4] || 0), Number(m1[5] || 0), Number(m1[6] || 0));
  const m2 = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);  // dd/mm/yyyy (BR)
  if (m2) return new Date(Number(m2[3]), Number(m2[2]) - 1, Number(m2[1]));
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

// Normaliza task pra agrupar mesmo se houver diferença sutil de acentuação/espaço
function normTaskName(s) {
  return (s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── GET /api/admin/duplicate-tasks ───────────────────────────────────────────
// Detecta tarefas duplicadas históricas no AdvBox: mesmo (lawsuit_id, tasks_id)
// criadas em janela curta entre si. Útil pra LIMPEZA RETROATIVA — todas as
// dups criadas antes do commit 17197d8 (que ligou o dedup automático) seguem
// vivas no AdvBox enchendo o saco da equipe.
//
//   GET /api/admin/duplicate-tasks               → últimos 30 dias (default)
//   GET /api/admin/duplicate-tasks?days=15       → janela menor (foco recente)
//   GET /api/admin/duplicate-tasks?days=60       → janela maior (mais histórico)
//   GET /api/admin/duplicate-tasks?onlyOpen=1    → só posts ainda abertos
//                                                  (ignora os já concluídos)
//
// Retorno: lista de "grupos" (cada grupo = N posts duplicados pro mesmo
// lawsuit+task), com links diretos pro AdvBox pra você/Letícia deletar a mão.
router.get('/admin/duplicate-tasks', requireAdmin, async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const onlyOpen = req.query.onlyOpen === '1';
    const debug    = req.query.debug === '1';
    const cutoffMs = Date.now() - days * 86400 * 1000;

    const posts = await fetchAllPosts();

    // Stats pra debug
    const stats = {
      total_posts_fetched: posts.length,
      passed_lid_tid: 0,
      passed_date: 0,
      passed_onlyOpen: 0,
      sample_dates: [],
      sample_tasks_id: { nulls: 0, zeros: 0, valid: 0 },
      date_parse_failures: 0,
    };

    // Agrupa por (lawsuit_id, task_normalized) — mais tolerante que tasks_id
    // porque o AdvBox às vezes devolve tasks_id null/0 mas task (string) sempre vem.
    const groups = new Map();
    for (const p of posts) {
      const lid = Number(p.lawsuits_id || p.lawsuit_id || 0);
      const taskName = normTaskName(p.task || p.title || '');
      if (!lid || !taskName) continue;
      stats.passed_lid_tid++;

      // Stats: distribuição de tasks_id
      const rawTid = p.tasks_id;
      if (rawTid == null) stats.sample_tasks_id.nulls++;
      else if (Number(rawTid) === 0) stats.sample_tasks_id.zeros++;
      else stats.sample_tasks_id.valid++;

      // Parse robusto (ISO + BR + fallback Date())
      const dateStr = p.created_at || p.date_created || p.date || p.start_date || '';
      const d = parseAdvboxDate(dateStr);
      if (!d) {
        stats.date_parse_failures++;
        if (stats.sample_dates.length < 5) stats.sample_dates.push({ raw: dateStr, parsed: 'FALHA' });
        continue;
      }
      const criadaTs = d.getTime();
      if (stats.sample_dates.length < 5) {
        stats.sample_dates.push({ raw: dateStr, parsed: d.toISOString() });
      }
      if (criadaTs < cutoffMs) continue;
      stats.passed_date++;

      if (onlyOpen) {
        const usrs = Array.isArray(p.users) ? p.users : [];
        const allDone = usrs.length > 0 && usrs.every(u => u.completed === true || u.completed === 1);
        if (allDone) continue;
      }
      stats.passed_onlyOpen++;

      const key = `${lid}::${taskName}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }

    const dupGroups = [];
    let totalExtra = 0;

    for (const [, postsArr] of groups) {
      if (postsArr.length < 2) continue;
      postsArr.sort((a, b) => {
        const ta = parseAdvboxDate(a.created_at || a.date_created)?.getTime() || 0;
        const tb = parseAdvboxDate(b.created_at || b.date_created)?.getTime() || 0;
        return ta - tb;
      });

      const first = postsArr[0];
      const lid = Number(first.lawsuits_id || first.lawsuit_id);
      totalExtra += postsArr.length - 1;

      dupGroups.push({
        lawsuit_id: lid,
        tasks_id: Number(first.tasks_id) || null,
        task: first.task || first.title || '(sem nome)',
        count: postsArr.length,
        extra_count: postsArr.length - 1,
        advboxLawsuitUrl: `https://app.advbox.com.br/lawsuits/${lid}`,
        posts: postsArr.map(p => ({
          id: p.id,
          created_at: p.created_at || p.date_created || null,
          start_date: p.start_date || null,
          date_deadline: p.date_deadline || null,
          notes_preview: (p.notes || '').slice(0, 80),
          users: (Array.isArray(p.users) ? p.users : []).map(u => ({
            name: u.name || null,
            completed: !!(u.completed === true || u.completed === 1),
          })),
          advboxTaskUrl: `https://app.advbox.com.br/0?t=${p.id}`,
          is_likely_original: p === first,
        })),
      });
    }

    dupGroups.sort((a, b) => b.count - a.count);

    const response = {
      window_days: days,
      onlyOpen,
      total_groups: dupGroups.length,
      total_extra_posts: totalExtra,
      hint: 'Grupos = mesmo lawsuit+task. O mais antigo (is_likely_original=true) é provavelmente o legítimo. Deletar os demais via advboxTaskUrl.',
      groups: dupGroups,
    };

    if (debug) {
      response.debug = {
        ...stats,
        sample_raw_post: posts[0] ? {
          id: posts[0].id,
          keys: Object.keys(posts[0]),
          tasks_id: posts[0].tasks_id,
          task: posts[0].task,
          lawsuits_id: posts[0].lawsuits_id,
          created_at: posts[0].created_at,
          date_created: posts[0].date_created,
          start_date: posts[0].start_date,
        } : null,
      };
    }

    res.json(response);
  } catch (err) { next(err); }
});

module.exports = router;
