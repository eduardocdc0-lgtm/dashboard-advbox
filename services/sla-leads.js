/**
 * SLA comercial de resposta a leads.
 *
 * Detecta leads que entraram pela ChatGuru/Flowter e estão parados em
 * stage='TRIAGEM' há mais de SLA_HOURS sem atualização. Cria tarefa no
 * AdvBox cobrando Thiago/Tammyres e registra log pra evitar spam.
 *
 * Heurística:
 *  - Lead em TRIAGEM E (now - updated_at) > SLA_HOURS  →  alerta
 *  - Cooldown: 1 alerta por lead a cada 24h (em sla_leads_alertas)
 *
 * Configurável:
 *  - SLA_LEADS_HORAS  (default 2)
 *  - SLA_LEADS_ENABLED (default true)
 */

'use strict';

const { query } = require('./db');
const fetch = require('node-fetch');

const SLA_HORAS    = Number(process.env.SLA_LEADS_HORAS) || 2;
const COOLDOWN_H   = 24;
const ADVBOX_BASE  = 'https://app.advbox.com.br/api/v1';
const ADVBOX_UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// IDs de quem deve responder lead novo. Thiago = closer principal; Tammyres = backup.
const RESPONSAVEIS_LEAD = {
  primary:   224040, // Thiago
  secondary: 267371, // Tammyres
};

// ── Migration ────────────────────────────────────────────────────────────────

async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS sla_leads_alertas (
      id          SERIAL PRIMARY KEY,
      lead_id     INT NOT NULL,
      lead_name   VARCHAR(500),
      lead_phone  VARCHAR(50),
      alerted_at  TIMESTAMP DEFAULT NOW(),
      escalation_level INT DEFAULT 1,
      advbox_post_id BIGINT,
      success     BOOLEAN NOT NULL DEFAULT TRUE,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sla_leads_at   ON sla_leads_alertas(alerted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sla_leads_lead ON sla_leads_alertas(lead_id, alerted_at DESC);
  `);
}

// ── Detecção ─────────────────────────────────────────────────────────────────

/**
 * Lista leads parados em TRIAGEM há > SLA_HORAS e sem alerta nas últimas
 * COOLDOWN_H horas.
 */
async function leadsParados() {
  const res = await query(`
    SELECT l.id, l.name, l.phone, l.message, l.campaign, l.created_at, l.updated_at,
           EXTRACT(EPOCH FROM (NOW() - l.updated_at))/3600 AS horas_parado
    FROM leads l
    WHERE l.stage = 'TRIAGEM'
      AND l.updated_at < NOW() - INTERVAL '${SLA_HORAS} hours'
      AND NOT EXISTS (
        SELECT 1 FROM sla_leads_alertas a
        WHERE a.lead_id = l.id
          AND a.alerted_at > NOW() - INTERVAL '${COOLDOWN_H} hours'
      )
    ORDER BY l.updated_at ASC
    LIMIT 50
  `);
  return res.rows;
}

/**
 * Lê histórico de alertas pra escalation_level (1 → 2 → 3).
 */
async function getEscalationLevel(leadId) {
  const r = await query(
    'SELECT COUNT(*)::int AS n FROM sla_leads_alertas WHERE lead_id = $1 AND success = true',
    [leadId]
  );
  return Math.min((r.rows[0].n || 0) + 1, 3);
}

// ── Métricas (pra painel) ────────────────────────────────────────────────────

/**
 * KPIs do SLA comercial — usado no painel executivo.
 *  - parados_agora: leads em TRIAGEM com horas_parado > SLA_HORAS
 *  - tempo_medio_resposta_h: média das diferenças (1ª tx fora de TRIAGEM)
 *  - leads_7d: leads que chegaram nos últimos 7 dias
 *  - convertidos_7d: leads que saíram de TRIAGEM nos últimos 7 dias
 */
async function getMetrics() {
  const [parados, ultimos, alertas7d] = await Promise.all([
    query(`
      SELECT COUNT(*)::int AS n,
             COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - updated_at))/3600), 0) AS max_h
      FROM leads
      WHERE stage = 'TRIAGEM'
        AND updated_at < NOW() - INTERVAL '${SLA_HORAS} hours'
    `),
    query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS total_7d,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days' AND stage <> 'TRIAGEM' AND stage <> 'CANCELADO')::int AS convertidos_7d
      FROM leads
    `),
    query(`
      SELECT COUNT(*)::int AS n
      FROM sla_leads_alertas
      WHERE alerted_at > NOW() - INTERVAL '7 days'
    `),
  ]);

  // Tempo médio de resposta: aprox. via leads que saíram de TRIAGEM (updated_at − created_at)
  const tempo = await query(`
    SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/3600), 0) AS media_h
    FROM leads
    WHERE stage <> 'TRIAGEM'
      AND created_at > NOW() - INTERVAL '30 days'
  `);

  return {
    sla_horas:           SLA_HORAS,
    parados_agora:       parados.rows[0].n,
    max_horas_parado:    Number(parados.rows[0].max_h).toFixed(1),
    tempo_medio_resp_h:  Number(tempo.rows[0].media_h || 0).toFixed(1),
    leads_7d:            ultimos.rows[0].total_7d,
    convertidos_7d:      ultimos.rows[0].convertidos_7d,
    conversao_7d_pct:    ultimos.rows[0].total_7d
      ? ((ultimos.rows[0].convertidos_7d / ultimos.rows[0].total_7d) * 100).toFixed(1)
      : '0.0',
    alertas_disparados_7d: alertas7d.rows[0].n,
  };
}

// ── Ação: cria tarefa cobrando lead ──────────────────────────────────────────

async function resolveTaskIdFor(name) {
  // Reusa cache do auto-workflow. Importado tarde pra evitar ciclo.
  const { resolveTaskId } = (() => {
    // Re-implementação local simples: tenta /settings, busca por nome. Cacheia.
    let _map = null, _at = 0;
    const TTL = 60 * 60 * 1000;
    async function resolveTaskId(taskName) {
      if (!_map || Date.now() - _at > TTL) {
        try {
          const resp = await fetch(`${ADVBOX_BASE}/settings`, {
            headers: {
              Authorization: `Bearer ${process.env.ADVBOX_TOKEN}`,
              'User-Agent': ADVBOX_UA,
              Accept: 'application/json',
            },
          });
          const json = await resp.json();
          const tasks = (json && json.tasks) || [];
          _map = tasks.map(t => ({
            id: t.id,
            n: String(t.task || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(),
          }));
          _at = Date.now();
        } catch {
          _map = [];
        }
      }
      const n = String(taskName || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
      let hit = _map.find(t => t.n === n);
      if (hit) return hit.id;
      hit = _map.find(t => t.n.includes(n) || n.includes(t.n));
      if (hit) return hit.id;
      return 8894482; // fallback: ACOMPANHAR ANDAMENTO
    }
    return { resolveTaskId };
  })();
  return resolveTaskId(name);
}

async function criarTarefaCobranca(lead, level) {
  // Sem lawsuit vinculado (lead ainda não virou processo). AdvBox exige
  // lawsuits_id no POST /posts. Solução: criar uma "tarefa órfã" não é
  // possível — registramos só no log interno e enviamos notificação.
  // Se o lead JÁ tem advbox_lawsuit_id, cria a tarefa lá.
  if (!lead.advbox_lawsuit_id) {
    return { ok: false, skipped: true, reason: 'lead_sem_lawsuit' };
  }

  const tasksId = await resolveTaskIdFor('LIGAR PARA CLIENTE');
  const hoje = new Date().toISOString().slice(0, 10);
  const assignee = level >= 2 ? RESPONSAVEIS_LEAD.secondary : RESPONSAVEIS_LEAD.primary;
  const escalaTxt = level === 1 ? 'ALERTA 1' : level === 2 ? 'ALERTA 2 (escalado)' : 'ALERTA 3 (crítico)';

  const notes = [
    `[SLA-Leads ${escalaTxt}] Lead parado há mais de ${SLA_HORAS}h sem resposta.`,
    `Nome: ${lead.name || '?'}`,
    `Telefone: ${lead.phone || '?'}`,
    `Campanha: ${lead.campaign || '—'}`,
    lead.message ? `Mensagem inicial: ${String(lead.message).slice(0, 300)}` : '',
    `Lead ID interno: ${lead.id}`,
  ].filter(Boolean).join('\n');

  const payload = {
    tasks_id: tasksId,
    notes,
    start_date: hoje,
    date_deadline: hoje,
    from: 198347, // Eduardo
    lawsuits_id: Number(lead.advbox_lawsuit_id),
    guests: [assignee],
  };

  const resp = await fetch(`${ADVBOX_BASE}/posts`, {
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
    const detail = body.errors || body.message || body.raw;
    throw new Error(`AdvBox ${resp.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  return { ok: true, post_id: body?.id || null, assignee_id: assignee };
}

// ── Ciclo ────────────────────────────────────────────────────────────────────

async function runCycle({ logger = console, dryRun = false } = {}) {
  await ensureTable();
  const parados = await leadsParados();
  logger.info(`[SLA-Leads] ${parados.length} leads parados há > ${SLA_HORAS}h`);
  if (!parados.length) return { processados: 0, alertados: 0, skipped: 0, erros: 0 };

  let alertados = 0, skipped = 0, erros = 0;
  const detalhes = [];

  for (const lead of parados) {
    try {
      const level = await getEscalationLevel(lead.id);
      if (dryRun) {
        detalhes.push({ lead_id: lead.id, level, dryRun: true });
        continue;
      }
      const result = await criarTarefaCobranca(lead, level);
      if (result.skipped) {
        // Sem lawsuit: registra alerta interno mesmo assim pra contar no painel
        await query(
          `INSERT INTO sla_leads_alertas (lead_id, lead_name, lead_phone, escalation_level, success, error_message)
           VALUES ($1, $2, $3, $4, false, $5)`,
          [lead.id, lead.name, lead.phone, level, 'sem_lawsuit_vinculado']
        );
        skipped++;
      } else {
        await query(
          `INSERT INTO sla_leads_alertas (lead_id, lead_name, lead_phone, escalation_level, advbox_post_id, success)
           VALUES ($1, $2, $3, $4, $5, true)`,
          [lead.id, lead.name, lead.phone, level, result.post_id]
        );
        alertados++;
      }
      detalhes.push({ lead_id: lead.id, level, ...result });
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      erros++;
      logger.error(`[SLA-Leads] erro lead ${lead.id}: ${e.message}`);
      try {
        await query(
          `INSERT INTO sla_leads_alertas (lead_id, lead_name, lead_phone, escalation_level, success, error_message)
           VALUES ($1, $2, $3, $4, false, $5)`,
          [lead.id, lead.name, lead.phone, 1, e.message.slice(0, 500)]
        );
      } catch {/* swallow */}
    }
  }

  logger.info(`[SLA-Leads] Ciclo: ${parados.length} analisados, ${alertados} alertados, ${skipped} sem lawsuit, ${erros} erros`);
  return { processados: parados.length, alertados, skipped, erros, detalhes };
}

module.exports = { runCycle, getMetrics, leadsParados, ensureTable, SLA_HORAS };
