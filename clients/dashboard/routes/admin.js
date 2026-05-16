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

// ── GET /api/admin/team-load ─────────────────────────────────────────────────
// Carga real do time NO ADVBOX, por pessoa. Pra cruzar com dados de chat
// (ChatGuru) e ver quem está sobrecarregado vs subutilizado.
//
//   GET /api/admin/team-load                     → janela 15 dias pra "concluídas"
//   GET /api/admin/team-load?recent_days=30      → janela maior pra concluídas
//
// Pra cada pessoa, conta tarefas em 3 buckets:
//   - active:   atribuídas + ainda NÃO concluídas (carga atual)
//   - overdue:  active + date_deadline < hoje (urgência)
//   - done_recent: concluídas nos últimos N dias
//
// IMPORTANTE: cada post pode ter MÚLTIPLOS users — cada um tem own .completed
// flag. Então uma tarefa "ativa pra Letícia" pode estar "concluída pra Marília".

router.get('/admin/team-load', requireAdmin, async (req, res, next) => {
  try {
    const recentDays = Math.min(60, Math.max(1, Number(req.query.recent_days) || 15));
    const recentCutoff = Date.now() - recentDays * 86400 * 1000;
    const todayISO = new Date().toISOString().slice(0, 10);

    const posts = await fetchAllPosts();

    // Heurística de "petição" (igual petitions.js)
    const PETITION_PREFIXES = [
      'AJUIZAR', 'PETICIONAR', 'ELABORAR PETICAO', 'ELABORAR RECURSO',
      'RECURSO DE', 'CONTESTACAO', 'MANIFESTACAO',
      'CUMPRIMENTO DE SENTENCA', 'IMPUGNACAO', 'EMBARGOS',
    ];
    const EXCLUDED_PREFIXES = ['PROTOCOLAR ADM', 'COMENTARIO', 'ANALISAR', 'LIGAR', 'ENVIAR'];
    const normTask = s => (s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const isPetition = task => {
      const t = normTask(task);
      if (EXCLUDED_PREFIXES.some(ex => t.startsWith(ex))) return false;
      return PETITION_PREFIXES.some(kw => t.startsWith(kw));
    };

    // Agrega por pessoa
    const byPerson = new Map();
    const getBucket = (name) => {
      if (!byPerson.has(name)) {
        byPerson.set(name, {
          name,
          active: 0,
          overdue: 0,
          done_recent: 0,
          breakdown_active: { peticoes: 0, outras: 0 },
          breakdown_overdue: { peticoes: 0, outras: 0 },
          tipos_mais_comuns: {},  // task name → count (só nas ativas)
        });
      }
      return byPerson.get(name);
    };

    for (const p of posts) {
      const users = Array.isArray(p.users) ? p.users : [];
      if (!users.length) continue;
      const taskName = p.task || '(sem nome)';
      const isPet = isPetition(taskName);

      for (const u of users) {
        if (!u.name) continue;
        const bucket = getBucket(u.name);
        const completed = u.completed === true || u.completed === 1;

        if (completed) {
          // Concluída — conta só se foi nos últimos N dias (precisa de data conclusão).
          // AdvBox às vezes traz date_payment, às vezes não. Best-effort.
          const doneAt = p.date_payment || p.completed_at || p.updated_at || p.date;
          const doneTs = doneAt ? Date.parse(String(doneAt).replace(' ', 'T')) : NaN;
          if (!Number.isNaN(doneTs) && doneTs >= recentCutoff) {
            bucket.done_recent++;
          }
        } else {
          // Ativa
          bucket.active++;
          if (isPet) bucket.breakdown_active.peticoes++;
          else bucket.breakdown_active.outras++;
          bucket.tipos_mais_comuns[taskName] = (bucket.tipos_mais_comuns[taskName] || 0) + 1;

          // Atrasada?
          const deadlineISO = p.date_deadline ? String(p.date_deadline).slice(0, 10) : null;
          if (deadlineISO && deadlineISO < todayISO) {
            bucket.overdue++;
            if (isPet) bucket.breakdown_overdue.peticoes++;
            else bucket.breakdown_overdue.outras++;
          }
        }
      }
    }

    // Top 5 tipos por pessoa (resto vira "outras")
    const result = [...byPerson.values()].map(b => {
      const sorted = Object.entries(b.tipos_mais_comuns).sort((a, b) => b[1] - a[1]).slice(0, 5);
      return {
        ...b,
        tipos_mais_comuns: sorted.map(([task, count]) => ({ task, count })),
      };
    }).sort((a, b) => b.active - a.active);

    res.json({
      generated_at: new Date().toISOString(),
      window_done_days: recentDays,
      total_posts_analyzed: posts.length,
      by_person: result,
      hint: 'active = tarefas atribuídas e NÃO concluídas | overdue = active + deadline passou | done_recent = concluídas nos últimos N dias | breakdown distingue petição judicial vs outras',
    });
  } catch (err) { next(err); }
});

// ── GET /api/admin/overdue-by-person ─────────────────────────────────────────
// Lista as tarefas ATRASADAS de uma pessoa específica, ordenadas por dias de
// atraso (mais atrasadas primeiro). Pra triagem urgente.
//
//   GET /api/admin/overdue-by-person?name=ANA%20MAR%C3%8DLIA
//   GET /api/admin/overdue-by-person?name=marilia      (case-insensitive,
//                                                       match parcial)
router.get('/admin/overdue-by-person', requireAdmin, async (req, res, next) => {
  try {
    const nameQuery = String(req.query.name || '').trim();
    if (!nameQuery) return res.status(400).json({ error: 'name obrigatório' });

    const nameNorm = nameQuery.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const todayISO = new Date().toISOString().slice(0, 10);

    const posts = await fetchAllPosts();
    const overdue = [];

    for (const p of posts) {
      const users = Array.isArray(p.users) ? p.users : [];
      if (!users.length) continue;

      // Acha o user com nome batendo (case + acento-insensitive, match parcial)
      const matchedUser = users.find(u => {
        if (!u.name) return false;
        const norm = u.name.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        return norm.includes(nameNorm) || nameNorm.includes(norm);
      });
      if (!matchedUser) continue;

      const completed = matchedUser.completed === true || matchedUser.completed === 1;
      if (completed) continue;  // só atrasadas ATIVAS

      const deadlineISO = p.date_deadline ? String(p.date_deadline).slice(0, 10) : null;
      if (!deadlineISO || deadlineISO >= todayISO) continue;

      const diasAtraso = Math.floor(
        (new Date(todayISO).getTime() - new Date(deadlineISO).getTime()) / 86400000
      );

      overdue.push({
        id: p.id,
        task: p.task || '(sem nome)',
        lawsuit_id: p.lawsuits_id || null,
        date_deadline: deadlineISO,
        dias_atraso: diasAtraso,
        created_at: p.created_at || null,
        notes_preview: (p.notes || '').slice(0, 80),
        outros_responsaveis: users.filter(u => u !== matchedUser).map(u => u.name).filter(Boolean),
        advboxTaskUrl: `https://app.advbox.com.br/0?t=${p.id}`,
        advboxLawsuitUrl: p.lawsuits_id ? `https://app.advbox.com.br/lawsuits/${p.lawsuits_id}` : null,
      });
    }

    // Mais atrasadas primeiro
    overdue.sort((a, b) => b.dias_atraso - a.dias_atraso);

    res.json({
      name_queried: nameQuery,
      total: overdue.length,
      generated_at: new Date().toISOString(),
      tasks: overdue,
    });
  } catch (err) { next(err); }
});

// ── GET /api/admin/justino-today ─────────────────────────────────────────────
// Detecta o que o Justino (IA do AdvBox) fez HOJE, separando do que foi
// auto-workflow nosso vs criação manual.
//
// Heurística de classificação (AdvBox não etiqueta quem criou):
//   - "JUSTINO_PROVAVEL": notes vazio + tipo intimacional (Avisar, Cumprimento,
//     Manifestar, Acompanhar)
//   - "AUTO_WORKFLOW_NOSSO": notes começa com "[Auto-workflow]"
//   - "MANUAL_PROVAVEL": notes preenchido com texto livre (sem prefixo bot)
//   - "INDETERMINADO": sem notes mas tipo não-intimacional
//
//   GET /api/admin/justino-today                   → tarefas criadas hoje
//   GET /api/admin/justino-today?days=3            → últimos 3 dias
router.get('/admin/justino-today', requireAdmin, async (req, res, next) => {
  try {
    const days = Math.min(30, Math.max(1, Number(req.query.days) || 1));
    // Recife = UTC-3
    const nowRecife = new Date(Date.now() - 3 * 3600 * 1000);
    const cutoffDate = new Date(nowRecife);
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoffISO = cutoffDate.toISOString().slice(0, 10);

    const posts = await fetchAllPosts();

    // Tipos típicos de tarefa que o Justino cria (a partir de intimações)
    const TIPOS_INTIMACIONAIS = [
      'AVISAR CLIENTE DA PERICIA',
      'CUMPRIMENTO DE EXIGENCIAS',
      'MANIFESTAR SOBRE LAUDO',
      'ACOMPANHAR ANDAMENTO PROCESSUAL',
      'PERICIA MEDICA MARCADA',
      'PERICIA SOCIAL JUDICIAL',
      'ANALISAR INTIMACAO',
    ];
    const normTask = s => (s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const isIntimacional = t => {
      const n = normTask(t);
      return TIPOS_INTIMACIONAIS.some(tipo => n.includes(tipo));
    };

    const classificar = p => {
      const notes = String(p.notes || '').trim();
      if (notes.startsWith('[Auto-workflow]')) return 'AUTO_WORKFLOW_NOSSO';
      if (notes.length > 0)                    return 'MANUAL_PROVAVEL';
      // Sem notes:
      if (isIntimacional(p.task))              return 'JUSTINO_PROVAVEL';
      return 'INDETERMINADO';
    };

    const stats = {
      JUSTINO_PROVAVEL:    { count: 0, exemplos: [], por_tipo: {} },
      AUTO_WORKFLOW_NOSSO: { count: 0, exemplos: [] },
      MANUAL_PROVAVEL:     { count: 0, exemplos: [] },
      INDETERMINADO:       { count: 0, exemplos: [] },
    };

    let totalAnalisados = 0;

    for (const p of posts) {
      const criadoStr = String(p.created_at || '').slice(0, 10);
      if (!criadoStr || criadoStr < cutoffISO) continue;
      totalAnalisados++;

      const cat = classificar(p);
      stats[cat].count++;

      // Pra Justino, agrupa por tipo de tarefa
      if (cat === 'JUSTINO_PROVAVEL') {
        const t = p.task || '(sem nome)';
        stats[cat].por_tipo[t] = (stats[cat].por_tipo[t] || 0) + 1;
      }

      // Sample dos 5 mais recentes de cada categoria
      if (stats[cat].exemplos.length < 5) {
        stats[cat].exemplos.push({
          id: p.id,
          task: p.task,
          created_at: p.created_at,
          date_deadline: p.date_deadline,
          lawsuit_id: p.lawsuits_id || null,
          users: (p.users || []).map(u => u.name).filter(Boolean),
          notes_preview: (p.notes || '').slice(0, 60),
          advboxTaskUrl: `https://app.advbox.com.br/0?t=${p.id}`,
        });
      }
    }

    // Top tipos do Justino
    const topTiposJustino = Object.entries(stats.JUSTINO_PROVAVEL.por_tipo)
      .sort((a, b) => b[1] - a[1])
      .map(([task, count]) => ({ task, count }));

    res.json({
      window_days: days,
      cutoff_date_recife: cutoffISO,
      total_posts_analyzed: totalAnalisados,
      classificacao: {
        JUSTINO_PROVAVEL: {
          count: stats.JUSTINO_PROVAVEL.count,
          top_tipos: topTiposJustino,
          exemplos: stats.JUSTINO_PROVAVEL.exemplos,
        },
        AUTO_WORKFLOW_NOSSO: {
          count: stats.AUTO_WORKFLOW_NOSSO.count,
          exemplos: stats.AUTO_WORKFLOW_NOSSO.exemplos,
        },
        MANUAL_PROVAVEL: {
          count: stats.MANUAL_PROVAVEL.count,
          exemplos: stats.MANUAL_PROVAVEL.exemplos,
        },
        INDETERMINADO: {
          count: stats.INDETERMINADO.count,
          exemplos: stats.INDETERMINADO.exemplos,
        },
      },
      hint: 'Heurística: notes vazio + tipo intimacional = JUSTINO. Pode haver falso positivo (tarefa criada manual sem notes). Pra precisão real, peça pra equipe escrever notes ao criar manualmente.',
    });
  } catch (err) { next(err); }
});

module.exports = router;
