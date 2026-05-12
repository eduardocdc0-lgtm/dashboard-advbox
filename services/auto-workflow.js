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
const { fetchLawsuits, client } = require('./data');
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

async function createPost({ lawsuitId, task, userId, deadline }) {
  const tasksId = await resolveTaskId(task);
  const hoje = new Date().toISOString().slice(0, 10);
  const payload = {
    tasks_id: tasksId,
    notes: `[Auto-workflow] ${task} — disparado quando processo mudou de fase.`,
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

// ── Loop principal ──────────────────────────────────────────────────────────

/**
 * Roda 1 ciclo de detecção + dispatch.
 * Retorna { processados, novos, criados, erros }.
 */
async function runCycle({ logger = console, dryRun = false, forceRefresh = true, force = false, onlyLawsuitId = null } = {}) {
  await ensureTables();

  let lawsuits = await fetchLawsuits(forceRefresh);
  if (onlyLawsuitId) lawsuits = lawsuits.filter(l => Number(l.id) === Number(onlyLawsuitId));
  logger.info(`[Auto-Workflow] Analisando ${lawsuits.length} lawsuits${force ? ' (force=1)' : ''}...`);

  let novos = 0;
  let criados = 0;
  let erros = 0;
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
          // Cria as tarefas no AdvBox
          const created = [];
          let firstError = null;
          for (const t of tpl.tasks) {
            try {
              const post = await createPost({
                lawsuitId: lawId,
                task: t.task,
                userId: t.user_id,
                deadline: daysFromNow(t.prazo_dias),
              });
              created.push({ task: t.task, post_id: post?.id || null });
              criados++;
              await new Promise(rs => setTimeout(rs, 800));
            } catch (e) {
              erros++;
              firstError = e.message;
              dispatchError = true;
              logger.error(`[Auto-Workflow] Falha criando '${t.task}' no lawsuit ${lawId}: ${e.message}`);
              break; // para na primeira falha pra não criar workflow parcial
            }
          }
          await markDispatched(lawId, tpl.name, newStage, created, firstError);
          detalhes.push({ lawId, stage: newStage, workflow: tpl.name, tasksCreated: created.length, error: firstError });
        }
      }
    }

    // Atualiza snapshot só se a tentativa foi bem-sucedida (ou nem foi tentada).
    // Se houve erro, mantém snapshot antigo pra próxima rodada detectar "mudou"
    // de novo e tentar.
    if (!dryRun && !dispatchError) await updateSnapshot(lawId, newStage);
  }

  logger.info(`[Auto-Workflow] Ciclo: ${lawsuits.length} processados, ${novos} workflows novos, ${criados} tarefas criadas, ${erros} erros.`);
  return { processados: lawsuits.length, novos, criados, erros, detalhes, dryRun };
}

module.exports = { runCycle, ensureTables };
