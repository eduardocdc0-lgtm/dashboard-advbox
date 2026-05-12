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
const { advboxUserIdFromSession } = require('../../../services/team-users');

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
  const force = req.query.force === '1';
  const onlyLawsuitId = req.query.lawsuit_id ? Number(req.query.lawsuit_id) : null;
  if (force && !onlyLawsuitId) {
    return res.status(400).json({ error: 'force=1 exige lawsuit_id (proteção contra disparo em massa).' });
  }
  try {
    const result = await runCycle({ dryRun, force, onlyLawsuitId, forceRefresh: true });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DEBUG: explica por que um lawsuit caiu em críticos do kanban ─────────────
// GET /api/audit/_debug/explain-critical?lawsuit_id=10339766&mes=05/2026
router.get('/audit/_debug/explain-critical', requireAuth, async (req, res) => {
  if (req.session.user?.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const lid = Number(req.query.lawsuit_id);
  const mes = (req.query.mes || '').toString();
  if (!lid || !mes) return res.status(400).json({ error: 'lawsuit_id e mes obrigatórios' });

  const { fetchTransactions, fetchLawsuits } = require('../../../services/data');
  const [transactions, lawsuits] = await Promise.all([
    fetchTransactions(true), fetchLawsuits(true),
  ]);
  const law = lawsuits.find(l => l.id === lid);
  if (!law) return res.json({ error: 'lawsuit não encontrado' });

  const [mm, yyyy] = mes.split('/').map(Number);
  const matchMes = s => {
    if (!s) return false;
    const str = String(s);
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) return +str.slice(0,4) === yyyy && +str.slice(5,7) === mm;
    if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) { const p = str.split('/'); return +p[1] === mm && +p[2] === yyyy; }
    return false;
  };

  // Transações vinculadas ao lawsuit (lógica primária)
  const direct = transactions.filter(t =>
    Number(t.lawsuits_id || t.lawsuit_id) === lid &&
    t.entry_type === 'income' &&
    (matchMes(t.date_payment) || matchMes(t.date_due))
  );

  // Clientes do lawsuit — IGNORA PARTE CONTRÁRIA. Campo certo é customer_id (não id).
  const custReais = (law.customers || []).filter(c =>
    c && (c.origin || '').toUpperCase() !== 'PARTE CONTRÁRIA'
  );
  const custIds = custReais.map(c => c.customer_id).filter(Boolean);
  const custNomes = custReais.map(c => c.name).filter(Boolean);

  // Quantos lawsuits cada cliente desses tem em fase parcelada
  const FASES_COB = ['SALARIO MATERNIDADE PARCELADO','JUDICIAL PARCELADO','ADM PARCELADO','RPV DO MES'];
  const isCobranca = s => {
    const n = (s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase().replace(/\s+/g,' ').trim();
    return FASES_COB.some(f => n === f || n.includes(f) || f.includes(n));
  };
  const lawsByCustomer = {};
  for (const l of lawsuits) {
    if (!isCobranca(l.stage || '')) continue;
    for (const c of (l.customers || [])) {
      const cid = c?.customer_id;
      if (!cid) continue;
      if ((c.origin || '').toUpperCase() === 'PARTE CONTRÁRIA') continue;
      (lawsByCustomer[cid] = lawsByCustomer[cid] || []).push({ id: l.id, stage: l.stage });
    }
  }

  // Transações income do mês — todas, pra calcular soltas + match
  const incomeDoMes = transactions.filter(t =>
    t.entry_type === 'income' && (matchMes(t.date_payment) || matchMes(t.date_due))
  );

  // "Soltas" = sem lawsuits_id. Transação tem campo `name` (cliente), não customer_id direto.
  const soltas = incomeDoMes
    .filter(t => !(t.lawsuits_id || t.lawsuit_id))
    .map(t => ({
      id: t.id,
      amount: t.amount,
      date_payment: t.date_payment,
      date_due: t.date_due,
      description: t.description || t.notes,
      name: t.name,
      identification: t.identification,
      raw_keys: Object.keys(t),
    }));

  // Match por NOME entre soltas e custNomes (transactions têm t.name, não customer_id)
  const normalize = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
  const custNomesNorm = custNomes.map(normalize).filter(Boolean);
  const soltasDoCliente = soltas.filter(s => {
    const sn = normalize(s.name);
    if (!sn) return false;
    // match exato OU um contém o outro (handles abreviações)
    return custNomesNorm.some(cn => sn === cn || sn.includes(cn) || cn.includes(sn));
  });

  res.json({
    lawsuit: { id: law.id, stage: law.stage, customers: law.customers },
    custIds,
    custNomes,
    // ── Diagnóstico do fallback ────────────────────────────────────────────
    transacoes_diretas_no_mes: direct,
    quantos_lawsuits_parcelados_por_cliente: custIds.map(cid => ({
      customer_id: cid,
      lawsuits: lawsByCustomer[cid] || [],
    })),
    quant_soltas_no_mes: soltas.length,
    primeira_solta_keys: soltas[0]?.raw_keys || null,
    // ── Lista os NOMES das soltas (pra ver se algum bate com o cliente) ────
    soltas_sample: soltas.slice(0, 15).map(s => ({
      id: s.id,
      name: s.name,
      identification: s.identification,
      amount: s.amount,
      date_due: s.date_due,
      date_payment: s.date_payment,
      description: s.description,
    })),
    soltas_que_batem_com_cliente: soltasDoCliente,
    // ── Diagnóstico final ─────────────────────────────────────────────────
    diagnostico: (() => {
      if (direct.length) return 'NÃO ERA CRÍTICO — tem transação vinculada direta';
      const ambig = custIds.some(cid => (lawsByCustomer[cid] || []).length > 1);
      if (ambig) return 'CRÍTICO — cliente tem múltiplos lawsuits parcelados (fallback não roda por segurança)';
      if (!soltasDoCliente.length) return 'CRÍTICO — nenhuma transação solta no mês encontrada para o customer_id do lawsuit';
      return 'DEVERIA TER PASSADO via fallback — investigar campo de customer';
    })(),
  });
});

// ── DEBUG: inspeciona transações financeiras (income) por lawsuit ────────────
// GET /api/audit/_debug/inspect-financial?lawsuit_id=10339766&mes=05/2026
router.get('/audit/_debug/inspect-financial', requireAuth, async (req, res) => {
  if (req.session.user?.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const lid = Number(req.query.lawsuit_id);
  const mes = (req.query.mes || '').toString(); // "MM/YYYY"
  if (!lid) return res.status(400).json({ error: 'lawsuit_id obrigatório' });

  const { fetchTransactions } = require('../../../services/data');
  const transactions = await fetchTransactions(true); // force=true → ignora cache

  // Tudo que TEM lawsuit_id matching
  const doLawsuit = transactions.filter(t =>
    Number(t.lawsuits_id || t.lawsuit_id) === lid
  );

  // Tudo que MENCIONA o lawsuit em notes/description (caso esteja "solto")
  const mencionaNoTexto = transactions.filter(t => {
    if (Number(t.lawsuits_id || t.lawsuit_id) === lid) return false;
    const blob = JSON.stringify(t).toLowerCase();
    return blob.includes(`#${lid}`.toLowerCase()) || blob.includes(`"${lid}"`);
  });

  // Pega lawsuit pra extrair nome do cliente
  const { fetchLawsuits } = require('../../../services/data');
  const lawsuits = await fetchLawsuits(true);
  const law = lawsuits.find(l => l.id === lid);
  const clientName = ((law?.customers || [])[0] || {}).name || null;

  // Filtra qualquer transação que cite o nome do cliente nas notes
  let matchNome = [];
  if (clientName) {
    const partes = clientName.split(/\s+/).filter(p => p.length >= 5).slice(0, 2);
    matchNome = transactions.filter(t => {
      if (Number(t.lawsuits_id || t.lawsuit_id) === lid) return false;
      const blob = JSON.stringify(t).toUpperCase();
      return partes.every(p => blob.includes(p));
    });
  }

  // Filtra pelo mês alvo (se passado)
  let doMesAlvo = null;
  if (mes) {
    const [mm, yyyy] = mes.split('/').map(Number);
    const matchMes = s => {
      if (!s) return false;
      const str = String(s);
      if (/^\d{4}-\d{2}-\d{2}/.test(str)) return +str.slice(0,4) === yyyy && +str.slice(5,7) === mm;
      if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) { const p = str.split('/'); return +p[1] === mm && +p[2] === yyyy; }
      return false;
    };
    doMesAlvo = transactions.filter(t =>
      (matchMes(t.date_payment) || matchMes(t.date_due) || (t.competence === mes)) &&
      t.entry_type === 'income'
    ).map(t => ({ id: t.id, lawsuits_id: t.lawsuits_id, entry_type: t.entry_type, amount: t.amount, competence: t.competence, date_payment: t.date_payment, date_due: t.date_due, description: t.description || t.notes, customer_name: t.customer_name }));
  }

  res.json({
    lawsuit_id: lid,
    cliente: clientName,
    fase: law?.stage,
    transacoes_do_lawsuit: doLawsuit.map(t => ({ id: t.id, entry_type: t.entry_type, amount: t.amount, competence: t.competence, date_payment: t.date_payment, date_due: t.date_due, description: t.description || t.notes })),
    transacoes_mencionam_no_texto: mencionaNoTexto.slice(0, 10),
    transacoes_match_nome_cliente: matchNome.slice(0, 10).map(t => ({ id: t.id, lawsuits_id: t.lawsuits_id, entry_type: t.entry_type, amount: t.amount, competence: t.competence, date_payment: t.date_payment, date_due: t.date_due, customer_name: t.customer_name, description: t.description || t.notes })),
    todas_income_do_mes_alvo: doMesAlvo,
    total_transactions: transactions.length,
  });
});

// ── DEBUG: inspeciona um cliente/processo + regras que dispararam ────────────
// GET /api/audit/_debug/inspect-client?q=MARCOS%20VINICIUS%20DORNELAS
router.get('/audit/_debug/inspect-client', requireAuth, async (req, res) => {
  if (req.session.user?.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const q = (req.query.q || '').toString().trim().toUpperCase();
  if (!q) return res.status(400).json({ error: 'q (nome ou trecho) obrigatório' });

  const { fetchCustomers, fetchLawsuits, fetchAllPosts } = require('../../../services/data');
  const { runAudit } = require('../../../services/auditor');

  const [customers, lawsuits, tasks] = await Promise.all([
    fetchCustomers(true), fetchLawsuits(true), fetchAllPosts(true),
  ]);

  const norm = s => String(s || '').toUpperCase();
  const cust = customers.filter(c => norm(c.name).includes(q));
  const custIds = new Set(cust.map(c => c.id));

  const laws = lawsuits.filter(l => {
    if (custIds.size && (l.customers || []).some(c => custIds.has(c.id))) return true;
    return (l.customers || []).some(c => norm(c.name).includes(q));
  });
  const lawIds = new Set(laws.map(l => l.id));

  const tarefas = tasks.filter(t => lawIds.has(t.lawsuits_id));

  // Roda audit completo e filtra problemas relacionados a esses lawsuits
  const audit = await runAudit({ force: true });
  const problemas = (audit.problemas || []).filter(p => {
    if (p.lawsuit_id && lawIds.has(p.lawsuit_id)) return true;
    if (p.id && lawIds.has(p.id)) return true;
    if (p.id && tarefas.some(t => t.id === p.id)) return true;
    return false;
  });

  res.json({
    query: q,
    customers: cust.map(c => ({ id: c.id, name: c.name, cpf: c.cpf, birthdate: c.birthdate })),
    lawsuits: laws.map(l => ({
      id: l.id, process_number: l.process_number, stage: l.stage,
      responsible: l.responsible, responsible_id: l.responsible_id,
      type_lawsuit: l.type_lawsuit, status_closure: l.status_closure,
      created_at: l.created_at,
    })),
    tarefas: tarefas.map(t => ({
      id: t.id, task: t.task, date: t.date, date_deadline: t.date_deadline,
      users: t.users, lawsuits_id: t.lawsuits_id,
    })),
    problemas_do_auditor: problemas,
  });
});

// ── DEBUG: sonda endpoints de upload do AdvBox ───────────────────────────────
// GET /api/audit/_debug/probe-upload?lawsuit_id=10339673&post_id=210808069
// Testa paths prováveis e devolve status code + 200 chars do body de cada.
router.get('/audit/_debug/probe-upload', requireAuth, async (req, res) => {
  if (req.session.user?.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const lid = Number(req.query.lawsuit_id) || 10339673;
  const pid = Number(req.query.post_id) || 210808069;
  const paths = [
    '/attachments', '/files', '/documents', '/uploads', '/media',
    `/lawsuits/${lid}/attachments`, `/lawsuits/${lid}/files`,
    `/lawsuits/${lid}/documents`, `/lawsuits/${lid}/uploads`,
    `/lawsuits/${lid}/media`,
    `/posts/${pid}/attachments`, `/posts/${pid}/files`,
    `/posts/${pid}/documents`,
    '/customers/attachments', '/customers/files',
  ];
  const results = [];
  for (const p of paths) {
    try {
      const r = await fetch(`https://app.advbox.com.br/api/v1${p}`, {
        headers: {
          Authorization: `Bearer ${process.env.ADVBOX_TOKEN}`,
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });
      const txt = (await r.text()).slice(0, 200);
      results.push({ path: p, status: r.status, body_preview: txt });
    } catch (e) {
      results.push({ path: p, error: e.message });
    }
  }
  res.json({ probed: paths.length, results });
});

// ── DEBUG: audit trail (últimas 20 ações) ────────────────────────────────────
// GET /api/audit/_debug/actions-log?limit=20 (admin only)
router.get('/audit/_debug/actions-log', requireAuth, async (req, res) => {
  if (req.session.user?.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const limit = Math.min(Number(req.query.limit) || 20, 200);
  try {
    const { rows } = await dbQuery(
      `SELECT id, actor_username, actor_advbox_id, action_type,
              target_lawsuit_id, target_user_id, success, error_message,
              problema_payload, advbox_response, created_at
       FROM audit_actions
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ count: rows.length, actions: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

// ── Marcar tarefa como "tratada" (ignorar do auditor por 30 dias) ────────────
// POST /api/audit/action/ignorar-tarefa
// body: { problema_id, problema_tipo, problema_campo, lawsuit_id?, motivo? }
//
// Comportamento: registra na tabela audit_ignored com janela de 30 dias.
// O runAudit filtra problemas que tenham ignore válido (não expirado).
// Self-healing: passados 30 dias, volta a aparecer no auditor se ainda
// estiver pendente no AdvBox.
async function ensureIgnoredTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS audit_ignored (
      id SERIAL PRIMARY KEY,
      problema_tipo TEXT NOT NULL,
      problema_id   TEXT NOT NULL,
      problema_campo TEXT,
      lawsuit_id    INT,
      ignored_by    TEXT NOT NULL,
      motivo        TEXT,
      ignored_until TIMESTAMP NOT NULL,
      created_at    TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ignored_lookup ON audit_ignored(problema_tipo, problema_id, ignored_until);
  `);
}

router.post('/audit/action/ignorar-tarefa', requireAuth, async (req, res) => {
  const username = req.session.user?.username || 'desconhecido';
  const { problema_id, problema_tipo, problema_campo, lawsuit_id, motivo } = req.body || {};
  if (!problema_id || !problema_tipo) {
    return res.status(400).json({ error: 'problema_id e problema_tipo obrigatórios.' });
  }

  try {
    await ensureIgnoredTable();
    const ignoredUntil = new Date(Date.now() + 30 * 86400_000); // +30 dias
    await dbQuery(`
      INSERT INTO audit_ignored (problema_tipo, problema_id, problema_campo, lawsuit_id, ignored_by, motivo, ignored_until)
      VALUES ($1, $2, $3, $4, $5, $6, $7);
    `, [
      String(problema_tipo),
      String(problema_id),
      problema_campo || null,
      lawsuit_id ? Number(lawsuit_id) : null,
      username,
      motivo || null,
      ignoredUntil.toISOString(),
    ]);
    res.json({
      ok: true,
      ignored_until: ignoredUntil.toISOString(),
      mensagem: `Tarefa marcada como tratada. Volta no auditor em 30 dias se ainda estiver pendente no AdvBox.`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/audit/action/ignored — lista ignores ativos do usuário (admin vê tudo)
router.get('/audit/action/ignored', requireAuth, async (req, res) => {
  try {
    await ensureIgnoredTable();
    const isAdmin = req.session.user?.role === 'admin';
    const params = [];
    let where = `ignored_until > NOW()`;
    if (!isAdmin) {
      where += ` AND ignored_by = $1`;
      params.push(req.session.user.username);
    }
    const r = await dbQuery(
      `SELECT * FROM audit_ignored WHERE ${where} ORDER BY created_at DESC LIMIT 100`,
      params,
    );
    res.json({ ok: true, total: r.rows.length, items: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.ensureIgnoredTable = ensureIgnoredTable;
