/**
 * Engine de auto-workflow.
 *
 * Detecta mudanças de fase nos lawsuits (via polling /lawsuits) e dispara
 * automaticamente os templates definidos em auto-workflow-templates.js,
 * criando as tarefas via POST /posts no AdvBox.
 *
 * Estado é persistido em 2 tabelas Postgres:
 *   - lawsuit_stage_snapshot: última fase conhecida de cada processo
 *   - workflow_dispatched:   workflows já criados (evita duplicar)
 */

'use strict';

const r = require('./audit-rules');
const { TEMPLATES, daysFromNow } = require('./auto-workflow-templates');
const { fetchLawsuits, fetchAllPosts, client } = require('./data');
const { query } = require('./db');

function normStr(s) {
  if (!s) return '';
  // NFD pra separar acentos, remove combinings, upper, depois normaliza pontuação
  // (hífens, traços, múltiplos espaços) — o AdvBox tem fases tipo
  // "PROCEDENTE EM PARTE - FAZER RECURSO" e queremos bater no template
  // mesmo se alguém digitou "PROCEDENTE EM PARTE FAZER RECURSO".
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[-–—]/g, ' ')   // hífens viram espaço
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Migrations ───────────────────────────────────────────────────────────────

async function ensureTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS lawsuit_stage_snapshot (
      lawsuit_id INT PRIMARY KEY,
      stage TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS workflow_dispatched (
      id SERIAL PRIMARY KEY,
      lawsuit_id INT NOT NULL,
      workflow_name TEXT NOT NULL,
      stage TEXT NOT NULL,
      dispatched_at TIMESTAMP DEFAULT NOW(),
      posts_created JSONB,
      error_message TEXT,
      UNIQUE(lawsuit_id, workflow_name)
    );
    CREATE INDEX IF NOT EXISTS idx_wf_disp_recent ON workflow_dispatched(dispatched_at DESC);
  `);
}

// ── Acesso ao snapshot ──────────────────────────────────────────────────────

async function getPreviousStage(lawsuitId) {
  const res = await query('SELECT stage FROM lawsuit_stage_snapshot WHERE lawsuit_id = $1', [lawsuitId]);
  return res.rows[0]?.stage || null;
}

async function updateSnapshot(lawsuitId, stage) {
  await query(`
    INSERT INTO lawsuit_stage_snapshot (lawsuit_id, stage, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (lawsuit_id) DO UPDATE SET stage = EXCLUDED.stage, updated_at = NOW();
  `, [lawsuitId, stage]);
}

async function alreadyDispatched(lawsuitId, workflowName) {
  // Considera "já feito" só quando NÃO houve erro. Tentativas falhadas
  // permitem retry no próximo ciclo.
  const res = await query(`
    SELECT 1 FROM workflow_dispatched
    WHERE lawsuit_id = $1 AND workflow_name = $2 AND error_message IS NULL
  `, [lawsuitId, workflowName]);
  return res.rows.length > 0;
}

/**
 * Pra retry de workflow que falhou no meio: retorna Set<tasks_id> das tarefas
 * que JÁ foram criadas com sucesso em tentativa anterior. Permite o retry
 * pular essas e só tentar as que faltaram. Sem isso, retry recria tudo e
 * gera duplicação na cabeça da equipe (queixa real da Letícia).
 */
async function getAlreadyCreatedTaskIds(lawsuitId, workflowName) {
  const res = await query(`
    SELECT posts_created FROM workflow_dispatched
    WHERE lawsuit_id = $1 AND workflow_name = $2
    LIMIT 1
  `, [lawsuitId, workflowName]);
  if (!res.rows.length) return new Set();
  const pc = res.rows[0].posts_created;
  if (!pc) return new Set();
  // Formato novo: { created: [...], skipped: [...] }
  // Formato antigo (legado): array direto [...]
  const arr = Array.isArray(pc) ? pc : (Array.isArray(pc.created) ? pc.created : []);
  const ids = new Set();
  for (const item of arr) {
    const tid = Number(item?.tasks_id);
    // O formato antigo não salvava tasks_id — só task name + post_id. Não tem
    // como inferir. O formato novo (introduzido nesta onda) salva tasks_id.
    if (tid) ids.add(tid);
  }
  return ids;
}

async function markDispatched(lawsuitId, workflowName, stage, postsCreated, errorMessage) {
  // Se já tem registro de tentativa anterior COM erro, atualiza (retry). Se
  // tem registro de sucesso, mantém como está (idempotente).
  await query(`
    INSERT INTO workflow_dispatched (lawsuit_id, workflow_name, stage, posts_created, error_message)
    VALUES ($1, $2, $3, $4::jsonb, $5)
    ON CONFLICT (lawsuit_id, workflow_name) DO UPDATE
      SET dispatched_at = NOW(),
          stage = EXCLUDED.stage,
          posts_created = EXCLUDED.posts_created,
          error_message = EXCLUDED.error_message
      WHERE workflow_dispatched.error_message IS NOT NULL;
  `, [lawsuitId, workflowName, stage, JSON.stringify(postsCreated || []), errorMessage || null]);
}

// ── Resolve tasks_id a partir do nome (texto livre nos templates) ───────────
// AdvBox exige ID numérico de settings.tasks no POST /posts. Cacheia 1h.

const TASK_LOOKUP_TTL_MS = 60 * 60 * 1000;
const TASK_FALLBACK_ID = 8894482; // ACOMPANHAR ANDAMENTO PROCESSUAL
let _taskMap = null;
let _taskMapAt = 0;

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function getTaskMap() {
  if (_taskMap && (Date.now() - _taskMapAt) < TASK_LOOKUP_TTL_MS) return _taskMap;
  const settings = await client.request('/settings');
  const tasks = (settings && settings.tasks) || [];
  _taskMap = tasks.map(t => ({ id: t.id, normTask: norm(t.task), original: t.task }));
  _taskMapAt = Date.now();
  return _taskMap;
}

async function resolveTaskId(taskName) {
  const map = await getTaskMap();
  const n = norm(taskName);
  if (!n) return TASK_FALLBACK_ID;
  let hit = map.find(t => t.normTask === n);
  if (hit) return hit.id;
  hit = map.find(t => t.normTask.startsWith(n) || n.startsWith(t.normTask));
  if (hit) return hit.id;
  hit = map.find(t => t.normTask.includes(n) || n.includes(t.normTask));
  if (hit) return hit.id;
  return TASK_FALLBACK_ID;
}

// ── Cria tarefa no AdvBox ───────────────────────────────────────────────────
// Schema real do POST /posts validado em produção (11/05/2026):
//   tasks_id, notes, start_date, date_deadline, from, lawsuits_id, guests[]

const ADVBOX_BASE = 'https://app.advbox.com.br/api/v1';
const ADVBOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const fetchNF = require('node-fetch');
const FROM_USER_ID = 198347; // Eduardo (admin/dono do token)

async function createPost({ lawsuitId, task, userId, deadline, workflowName = '', stage = '' }) {
  const tasksId = await resolveTaskId(task);
  const hoje = new Date().toISOString().slice(0, 10);
  const agoraBR = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Recife',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  // Notes ricas — equipe consegue identificar a origem e evitar pânico se
  // achar que é duplicação. Padrão: marcador + workflow + fase + timestamp.
  const notes = [
    `[Auto-workflow] ${task}`,
    workflowName ? `Workflow: ${workflowName}` : '',
    stage        ? `Disparado quando fase mudou pra: ${stage}` : '',
    `Em: ${agoraBR}`,
    `Se você acha que isso é duplicado, avise o Eduardo (lawsuit #${lawsuitId}).`,
  ].filter(Boolean).join('\n');
  const payload = {
    tasks_id: tasksId,
    notes,
    start_date: hoje,
    date_deadline: deadline,
    from: FROM_USER_ID,
    lawsuits_id: lawsuitId,
    guests: [userId],
  };
  const resp = await fetchNF(`${ADVBOX_BASE}/posts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.ADVBOX_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': ADVBOX_UA,
    },
    body: JSON.stringify(payload),
  });
  const raw = await resp.text();
  let body; try { body = JSON.parse(raw); } catch { body = { raw }; }
  if (!resp.ok) {
    const detail = body.errors || body.message || body.error || body.raw;
    throw new Error(`AdvBox ${resp.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  return body;
}

// ── Detecção de duplicação ──────────────────────────────────────────────────
// Antes de criar uma tarefa via POST /posts, checa se já existe uma tarefa
// equivalente recente naquele lawsuit. Pega 3 fontes de duplicação:
//   1. Justin-e (IA do AdvBox) que criou tarefa pra mesma intimação
//   2. Membro da equipe que criou manualmente
//   3. Auto-workflow anterior que não foi registrado (ex: import manual)
//
// Janela default: 168h (7 dias). Configurável via DEDUP_WINDOW_HOURS (env).
// Por que 7 dias? Letícia/Marília podem demorar 3-4 dias pra cumprir uma
// tarefa. Se você roda force=1 ou rebooteia 5 dias depois, 72h não pega
// a duplicação. 168h cobre quase qualquer ciclo realista.

const DEDUP_WINDOW_HOURS = Number(process.env.DEDUP_WINDOW_HOURS) || 168;

/**
 * Monta índice de tarefas recentes por lawsuit.
 * Retorna Map<lawsuitId:number, Set<tasksId:number>>.
 */
async function buildRecentPostsIndex(logger) {
  const idx = new Map();
  try {
    const posts = await fetchAllPosts();    // usa cache do dashboard
    const limite = Date.now() - DEDUP_WINDOW_HOURS * 3600 * 1000;
    for (const p of posts) {
      const lid = Number(p.lawsuits_id);
      const tid = Number(p.tasks_id);
      if (!lid || !tid) continue;
      const criadaTs = Date.parse(p.created_at || p.start_date || '');
      if (Number.isNaN(criadaTs) || criadaTs < limite) continue;
      if (!idx.has(lid)) idx.set(lid, new Set());
      idx.get(lid).add(tid);
    }
    logger.info(`[Auto-Workflow] Índice de duplicação: ${idx.size} lawsuits com posts nas últimas ${DEDUP_WINDOW_HOURS}h`);
  } catch (e) {
    logger.warn(`[Auto-Workflow] Falha ao montar índice de duplicação: ${e.message}. Seguindo sem dedup.`);
  }
  return idx;
}

function hasRecentDuplicate(idx, lawsuitId, tasksId) {
  const set = idx.get(Number(lawsuitId));
  return Boolean(set && set.has(Number(tasksId)));
}

// ── Loop principal ──────────────────────────────────────────────────────────

// Advisory lock ID — número arbitrário mas estável (qualquer int32). Se algum
// outro código no projeto usar advisory lock no futuro, escolher número
// diferente pra não conflitar.
const AUTO_WORKFLOW_LOCK_ID = 902301;

/**
 * Roda 1 ciclo de detecção + dispatch.
 * Retorna { processados, novos, criados, erros, skippedDuplicates }.
 *
 * Concorrência: usa pg_try_advisory_lock pra impedir 2 instâncias rodando ao
 * mesmo tempo (ex: cron lento + manual via /api, ou Replit Autoscale com
 * 2 containers). Race condition aqui sobrescrevia snapshot e causava
 * duplicação de tarefa.
 */
async function runCycle({ logger = console, dryRun = false, forceRefresh = true, force = false, onlyLawsuitId = null } = {}) {
  await ensureTables();

  // Tenta adquirir lock. Se outro ciclo está rodando, abandona com log.
  const lockRes = await query('SELECT pg_try_advisory_lock($1) AS got', [AUTO_WORKFLOW_LOCK_ID]);
  if (!lockRes.rows[0].got) {
    logger.warn(`[Auto-Workflow] Outro ciclo já em execução (lock ${AUTO_WORKFLOW_LOCK_ID} ocupado) — abandonando`);
    return { skipped: true, reason: 'lock_held', processados: 0, novos: 0, criados: 0, skippedDuplicates: 0, erros: 0, detalhes: [], dryRun };
  }

  try {
    return await _runCycleLocked({ logger, dryRun, forceRefresh, force, onlyLawsuitId });
  } finally {
    // Sempre libera o lock — se conexão morrer, Postgres libera no disconnect
    try {
      await query('SELECT pg_advisory_unlock($1)', [AUTO_WORKFLOW_LOCK_ID]);
    } catch (e) {
      logger.error(`[Auto-Workflow] Falha ao liberar lock: ${e.message}`);
    }
  }
}

async function _runCycleLocked({ logger, dryRun, forceRefresh, force, onlyLawsuitId }) {
  let lawsuits = await fetchLawsuits(forceRefresh);
  if (onlyLawsuitId) lawsuits = lawsuits.filter(l => Number(l.id) === Number(onlyLawsuitId));
  logger.info(`[Auto-Workflow] Analisando ${lawsuits.length} lawsuits${force ? ' (force=1)' : ''}...`);

  // Pré-carrega índice de tarefas recentes (Justino, manual, etc) pra dedup
  const recentIdx = await buildRecentPostsIndex(logger);

  let novos = 0;
  let criados = 0;
  let erros = 0;
  let skippedDuplicates = 0;
  const detalhes = [];

  for (const law of lawsuits) {
    const lawId = law.id;
    if (!lawId) continue;
    const newStage = normStr(law.stage);
    if (!newStage) continue;

    const prevStage = await getPreviousStage(lawId);
    const mudou = prevStage !== newStage;

    // SAFETY: na primeira vez que vemos um processo (prevStage === null),
    // só populamos o snapshot — NÃO disparamos workflow. Senão a primeira
    // rodada após deploy criaria workflow pra todos os ~500 processos ativos.
    const ehPrimeiraVez = prevStage === null;

    // force=1 ignora trava de "mudou" e "primeira vez". Continua respeitando
    // alreadyDispatched (que agora só conta sucessos).
    const deveDisparar = TEMPLATES[newStage] && (force || (mudou && !ehPrimeiraVez));
    let dispatchError = false;

    if (deveDisparar) {
      const tpl = TEMPLATES[newStage];
      if (!(await alreadyDispatched(lawId, tpl.name))) {
        novos++;
        if (dryRun) {
          detalhes.push({ lawId, stage: newStage, workflow: tpl.name, dryRun: true });
        } else {
          // Cria as tarefas no AdvBox — 3 camadas de proteção contra duplicação:
          //  1. Retry inteligente: pula tasks já criadas em tentativa anterior
          //     do MESMO workflow (resolve cenário Letícia: falha parcial + retry)
          //  2. Dedup global: pula tasks que existem nas últimas 168h por
          //     qualquer fonte (Justino, manual, outro workflow)
          //  3. Atualização incremental do índice intra-ciclo
          const alreadyCreatedIds = await getAlreadyCreatedTaskIds(lawId, tpl.name);
          const created = [];
          const skipped = [];
          let firstError = null;
          for (const t of tpl.tasks) {
            try {
              const tasksId = await resolveTaskId(t.task);
              if (alreadyCreatedIds.has(tasksId)) {
                skipped.push({ task: t.task, tasks_id: tasksId, motivo: 'retry_ja_criada' });
                logger.info(`[Auto-Workflow] Skip retry lawsuit=${lawId} task='${t.task}' (tasks_id=${tasksId}) — já criada em tentativa anterior deste workflow`);
                continue;
              }
              if (hasRecentDuplicate(recentIdx, lawId, tasksId)) {
                skipped.push({ task: t.task, tasks_id: tasksId, motivo: 'duplicado_recente' });
                skippedDuplicates++;
                logger.info(`[Auto-Workflow] Skip dup lawsuit=${lawId} task='${t.task}' (tasks_id=${tasksId}) — já existe nas últimas ${DEDUP_WINDOW_HOURS}h`);
                continue;
              }
              const post = await createPost({
                lawsuitId: lawId,
                task: t.task,
                userId: t.user_id,
                deadline: daysFromNow(t.prazo_dias),
                workflowName: tpl.name,
                stage: newStage,
              });
              created.push({ task: t.task, tasks_id: tasksId, post_id: post?.id || null });
              criados++;
              // Atualiza índice em memória — evita 2 templates do mesmo ciclo
              // pedirem a mesma task no mesmo lawsuit
              if (!recentIdx.has(lawId)) recentIdx.set(lawId, new Set());
              recentIdx.get(lawId).add(tasksId);
              await new Promise(rs => setTimeout(rs, 800));
            } catch (e) {
              erros++;
              firstError = e.message;
              dispatchError = true;
              logger.error(`[Auto-Workflow] Falha criando '${t.task}' no lawsuit ${lawId}: ${e.message}`);
              break; // para na primeira falha pra não criar workflow parcial
            }
          }
          // Merge com o que já tinha sido criado em tentativas anteriores
          // (pra preservar histórico e não perder rastreamento)
          const allCreated = [];
          for (const id of alreadyCreatedIds) allCreated.push({ tasks_id: id, from_previous_attempt: true });
          allCreated.push(...created);
          await markDispatched(lawId, tpl.name, newStage, { created: allCreated, skipped }, firstError);
          detalhes.push({ lawId, stage: newStage, workflow: tpl.name, tasksCreated: created.length, tasksSkipped: skipped.length, error: firstError });
        }
      }
    }

    // Atualiza snapshot só se a tentativa foi bem-sucedida (ou nem foi tentada).
    // Se houve erro, mantém snapshot antigo pra próxima rodada detectar "mudou"
    // de novo e tentar.
    if (!dryRun && !dispatchError) await updateSnapshot(lawId, newStage);
  }

  logger.info(`[Auto-Workflow] Ciclo: ${lawsuits.length} processados, ${novos} workflows novos, ${criados} tarefas criadas, ${skippedDuplicates} pulados por dedup, ${erros} erros.`);
  return { processados: lawsuits.length, novos, criados, skippedDuplicates, erros, detalhes, dryRun };
}

module.exports = { runCycle, ensureTables };
