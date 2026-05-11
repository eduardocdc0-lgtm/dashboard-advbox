/**
 * Ações 1-click da Auditoria de Uso.
 *
 * Princípios:
 *  - SEMPRE registrar a tentativa em audit_actions (mesmo se a chamada AdvBox falhar)
 *  - Cooldown: rejeita se mesma (action_type + lawsuit_id) foi disparada com SUCESSO < 60 min
 *  - Sem retry automático em erro do AdvBox: devolve o erro pro frontend mostrar
 */

'use strict';

const fetch = require('node-fetch');
const { Router } = require('express');
const { requireAuth } = require('../../../middleware/auth');
const { query: dbQuery } = require('../../../services/db');
const { client } = require('../../../services/data');
const { TEAM_USERS, advboxUserIdFromSession } = require('../../../services/team-users');

const ADVBOX_BASE = 'https://app.advbox.com.br/api/v1';
const ADVBOX_UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// POST cru no AdvBox que preserva o body completo do erro (4xx).
// O AdvBoxClient padrão só pega body.message — em 422, o AdvBox costuma
// retornar { errors: { campo: ["msg"] } } com o diagnóstico real do payload.
async function advboxPostRaw(endpoint, payload) {
  const resp = await fetch(`${ADVBOX_BASE}${endpoint}`, {
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
  let body;
  try { body = JSON.parse(raw); } catch { body = { raw }; }
  return { ok: resp.ok, status: resp.status, body };
}

const router = Router();

const COOLDOWN_MIN = 60;
const COBRAVEIS = new Set(['gargalo_etapa', 'responsavel_errado', 'prazo_vencido']);

function addBusinessDays(date, days) {
  const d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

router.post('/audit/action/cobrar-responsavel', requireAuth, async (req, res, next) => {
  const sessionUser = req.session.user;
  const actorUsername = sessionUser.username;
  const actorAdvboxId = sessionUser.advboxUserId || null;
  const actionType = 'cobrar-responsavel';

  const body = req.body || {};
  const { problema_id, problema_tipo, problema_campo, lawsuit_id, user_id, descricao } = body;

  // ── Validações de entrada ──────────────────────────────────────────────────
  if (problema_tipo !== 'workflow' || !COBRAVEIS.has(problema_campo)) {
    return res.status(400).json({ error: 'Problema não cobrável (tipo/campo inválidos).' });
  }
  if (!user_id) {
    return res.status(400).json({ error: 'user_id (responsável) é obrigatório.' });
  }
  if (!lawsuit_id) {
    return res.status(400).json({ error: 'lawsuit_id é obrigatório (AdvBox exige vincular task a um processo).' });
  }
  if (!descricao) {
    return res.status(400).json({ error: 'descricao é obrigatória.' });
  }

  // Team users só podem cobrar a si mesmos
  const isAdmin = sessionUser.role === 'admin';
  if (!isAdmin) {
    const ownId = advboxUserIdFromSession(sessionUser);
    if (Number(user_id) !== Number(ownId)) {
      return res.status(403).json({ error: 'Você só pode cobrar os próprios problemas.' });
    }
  }

  // ── Cooldown ───────────────────────────────────────────────────────────────
  try {
    const { rows } = await dbQuery(
      `SELECT id, created_at FROM audit_actions
       WHERE action_type = $1
         AND target_lawsuit_id IS NOT DISTINCT FROM $2
         AND success = TRUE
         AND created_at > NOW() - INTERVAL '${COOLDOWN_MIN} minutes'
       ORDER BY created_at DESC LIMIT 1`,
      [actionType, lawsuit_id || null]
    );
    if (rows.length) {
      const ageMin = Math.floor((Date.now() - new Date(rows[0].created_at).getTime()) / 60000);
      const restantes = COOLDOWN_MIN - ageMin;
      return res.status(429).json({
        error: `Cooldown ativo: já foi cobrado há ${ageMin} min. Tente novamente em ${restantes} min.`,
      });
    }
  } catch (err) {
    console.error('[audit-actions] erro no cooldown check:', err.message);
    // Não bloqueia — segue tentando a ação, mas loga.
  }

  // ── Monta payload pra AdvBox ───────────────────────────────────────────────
  // Campos obrigatórios descobertos via erro 422:
  //   start_date, from, tasks_id, guests, lawsuits_id
  const hoje = ymd(new Date());
  const dataPrazo = ymd(addBusinessDays(new Date(), 3));
  const fromUserId = actorAdvboxId || 198347; // fallback: Eduardo (admin)
  // ID da task pré-cadastrada no AdvBox (settings.tasks). Default:
  // "ACOMPANHAR ANDAMENTO PROCESSUAL" (id 8894482, reward 8). Override via env.
  const tasksId = Number(process.env.ADVBOX_TASK_ID_GENERICA) || 8894482;

  const advboxPayload = {
    tasks_id: tasksId,
    notes: `[Auditoria] ${descricao}. Verificar e tomar ação.`,
    start_date: hoje,
    date_deadline: dataPrazo,
    from: fromUserId,
    lawsuits_id: Number(lawsuit_id),
    guests: [Number(user_id)],
  };

  // ── Chama AdvBox (POST cru para preservar body do erro 4xx) ────────────────
  let advboxResponse = null;
  let advboxStatus = null;
  let success = false;
  let errorMessage = null;

  try {
    const r = await advboxPostRaw('/posts', advboxPayload);
    advboxResponse = r.body;
    advboxStatus = r.status;
    success = r.ok;
    if (!success) {
      const detail = r.body && (r.body.errors || r.body.message || r.body.error || r.body.raw);
      errorMessage = `${r.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
      console.error('[audit-actions] AdvBox 4xx — payload:', JSON.stringify(advboxPayload), '| resp:', errorMessage);
    }
  } catch (err) {
    errorMessage = err.message || String(err);
    success = false;
    console.error('[audit-actions] AdvBox network error:', errorMessage);
  }

  // ── Audit log SEMPRE ───────────────────────────────────────────────────────
  try {
    await dbQuery(
      `INSERT INTO audit_actions
         (actor_username, actor_advbox_id, action_type, target_lawsuit_id, target_user_id,
          problema_payload, advbox_response, success, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        actorUsername,
        actorAdvboxId,
        actionType,
        lawsuit_id ? Number(lawsuit_id) : null,
        Number(user_id),
        JSON.stringify({ problema_id, problema_tipo, problema_campo, descricao, payload: advboxPayload }),
        advboxResponse ? JSON.stringify(advboxResponse) : null,
        success,
        errorMessage,
      ]
    );
  } catch (logErr) {
    console.error('[audit-actions] erro ao gravar audit_actions:', logErr.message);
  }

  if (!success) {
    return res.status(502).json({
      error: `AdvBox ${errorMessage}`,
      payload_enviado: advboxPayload,
      advbox_response: advboxResponse,
    });
  }

  res.json({
    ok: true,
    cooldown_until: new Date(Date.now() + COOLDOWN_MIN * 60_000).toISOString(),
    task: advboxResponse,
  });
});

// ── Admin: roda 1 ciclo do auto-workflow manualmente ─────────────────────────
// GET /api/audit/auto-workflow/run?dryRun=1
router.get('/auto-workflow/run', requireAuth, async (req, res) => {
  if (req.session.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Só admin pode rodar auto-workflow manualmente.' });
  }
  const { runCycle } = require('../../../services/auto-workflow');
  const dryRun = req.query.dryRun === '1';
  try {
    const result = await runCycle({ dryRun, forceRefresh: true });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DEBUG: inspecionar schema real do POST /posts ────────────────────────────
// Acesse: /api/audit/_debug/posts-sample (admin only)
// Retorna os 3 primeiros posts do AdvBox + tenta GET /tasks e GET /settings
// pra revelar onde estão os tasks_id pré-cadastrados.
router.get('/audit/_debug/posts-sample', requireAuth, async (req, res) => {
  if (req.session.user?.role !== 'admin') {
    return res.status(403).json({ error: 'admin only' });
  }
  const out = {};
  try {
    const posts = await client.request('/posts');
    const arr = Array.isArray(posts) ? posts : (posts.data || []);
    out.posts_sample = arr.slice(0, 3);
    out.posts_count = arr.length;
    out.post_keys = arr[0] ? Object.keys(arr[0]) : null;
  } catch (e) { out.posts_error = e.message; }

  try { out.settings = await client.request('/settings'); }
  catch (e) { out.settings_error = e.message; }

  try { out.tasks = await client.request('/tasks'); }
  catch (e) { out.tasks_error = e.message; }

  res.json(out);
});

module.exports = router;
