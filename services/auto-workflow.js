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
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
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
  const res = await query(`
    SELECT 1 FROM workflow_dispatched
    WHERE lawsuit_id = $1 AND workflow_name = $2
  `, [lawsuitId, workflowName]);
  return res.rows.length > 0;
}

async function markDispatched(lawsuitId, workflowName, stage, postsCreated, errorMessage) {
  await query(`
    INSERT INTO workflow_dispatched (lawsuit_id, workflow_name, stage, posts_created, error_message)
    VALUES ($1, $2, $3, $4::jsonb, $5)
    ON CONFLICT (lawsuit_id, workflow_name) DO NOTHING;
  `, [lawsuitId, workflowName, stage, JSON.stringify(postsCreated || []), errorMessage || null]);
}

// ── Cria tarefa no AdvBox ───────────────────────────────────────────────────

async function createPost({ lawsuitId, task, userId, deadline }) {
  const payload = {
    task,
    notes: `[Auto-workflow] Criado pelo dashboard quando processo mudou de fase.`,
    date_deadline: deadline,
    lawsuits_id: lawsuitId,
    users: [{ user_id: userId }],
  };
  const resp = await client.request('/posts', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return resp;
}

// ── Loop principal ──────────────────────────────────────────────────────────

/**
 * Roda 1 ciclo de detecção + dispatch.
 * Retorna { processados, novos, criados, erros }.
 */
async function runCycle({ logger = console, dryRun = false, forceRefresh = true } = {}) {
  await ensureTables();

  const lawsuits = await fetchLawsuits(forceRefresh);
  logger.info(`[Auto-Workflow] Analisando ${lawsuits.length} lawsuits...`);

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

    if (mudou && !ehPrimeiraVez && TEMPLATES[newStage]) {
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
              // Pequeno delay pra não estourar rate limit
              await new Promise(rs => setTimeout(rs, 800));
            } catch (e) {
              erros++;
              firstError = e.message;
              logger.error(`[Auto-Workflow] Falha criando '${t.task}' no lawsuit ${lawId}: ${e.message}`);
              break; // para na primeira falha pra não criar workflow parcial
            }
          }
          await markDispatched(lawId, tpl.name, newStage, created, firstError);
          detalhes.push({ lawId, stage: newStage, workflow: tpl.name, tasksCreated: created.length, error: firstError });
        }
      }
    }

    // Atualiza snapshot só se não for dryRun (pra não comprometer próxima rodada)
    if (!dryRun) await updateSnapshot(lawId, newStage);
  }

  logger.info(`[Auto-Workflow] Ciclo: ${lawsuits.length} processados, ${novos} workflows novos, ${criados} tarefas criadas, ${erros} erros.`);
  return { processados: lawsuits.length, novos, criados, erros, detalhes, dryRun };
}

module.exports = { runCycle, ensureTables };
