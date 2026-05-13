/**
 * Controller — fonte única de verdade sobre "esteira andando direito".
 *
 * Diferente do auditor (que classifica por severidade), o Controller agrupa
 * por TIPO DE AÇÃO PENDENTE — o que o escritório precisa FAZER pra destravar.
 *
 * Cada categoria mapeia 1+ fases do AdvBox a um responsável e uma ação.
 */

'use strict';

const fetch = require('node-fetch');
const { fetchLawsuits } = require('./data');
const { query: dbQuery } = require('./db');

const ADVBOX_BASE = 'https://app.advbox.com.br/api/v1';
const ADVBOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const COOLDOWN_MIN = 60;

// ── Categorias ───────────────────────────────────────────────────────────────
// Ordem = prioridade na UI. Cada categoria tem fases que dispara nela.
const CATEGORIAS = [
  {
    id: 'reprotocolar',
    titulo: '🔁 Re-protocolar',
    descricao: 'Requerimento cancelado pelo INSS, escritório precisa entrar novamente',
    fases: ['CANCELADO REQUERIMENTO'],
    responsavel: 'MARILIA',
    slaDias: 10,
  },
  {
    id: 'sem_laudo_prevdoc',
    titulo: '📋 Falta laudo PrevDoc',
    descricao: 'Cliente precisa fazer/enviar laudo médico',
    fases: ['FALTA LAUDO - FAZER PREVDOC', 'FALTA LAUDO', 'PREVDOC', 'PROCESSOS SEM LAUDOS'],
    responsavel: 'TAMMYRES',
    slaDias: 7,
  },
  {
    id: 'dar_entrada',
    titulo: '⚠️ Falta dar entrada',
    descricao: 'Processo pronto, falta protocolar no INSS',
    fases: ['PARA DAR ENTRADA'],
    responsavel: 'MARILIA',
    slaDias: 5,
  },
  {
    id: 'peticao_inicial',
    titulo: '⚖️ Elaborar petição inicial',
    descricao: 'Caso judicial pronto, falta peticionar',
    fases: ['ELABORAR PETIÇÃO INICIAL', 'ELABORAR PETICAO INICIAL'],
    responsavel: 'LETICIA_OU_ALICE',
    slaDias: 10,
  },
  {
    id: 'com_prazo',
    titulo: '⏰ Com prazo',
    descricao: 'Prazo judicial correndo',
    fases: ['COM PRAZO'],
    responsavel: 'LETICIA_OU_ALICE',
    slaDias: 5,
  },
  {
    id: 'protocolado_adm_velho',
    titulo: '🔄 Protocolado ADM antigo',
    descricao: 'Protocolado, esperando INSS — revisar se passou de 30 dias',
    fases: ['PROTOCOLADO ADM'],
    responsavel: 'MARILIA',
    slaDias: 30,
  },
];

// Index inverso: fase normalizada → categoria
const FASE_TO_CATEGORIA = new Map();
for (const cat of CATEGORIAS) {
  for (const fase of cat.fases) FASE_TO_CATEGORIA.set(fase.toUpperCase(), cat);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function diasDesde(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr.replace(' ', 'T'));
  if (isNaN(d)) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

function pickClientName(lawsuit) {
  const customers = Array.isArray(lawsuit.customers) ? lawsuit.customers : [];
  for (const c of customers) {
    if (c?.origin === 'PARTE CONTRÁRIA') continue;
    if (c?.name) return c.name;
  }
  return null;
}

function pickClientCpf(lawsuit) {
  const customers = Array.isArray(lawsuit.customers) ? lawsuit.customers : [];
  for (const c of customers) {
    if (c?.origin === 'PARTE CONTRÁRIA') continue;
    if (c?.identification && /\d{3}\.\d{3}\.\d{3}-\d{2}/.test(c.identification)) return c.identification;
  }
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function buildOverview({ force = false } = {}) {
  const lawsuits = await fetchLawsuits(force);

  const buckets = new Map();
  for (const cat of CATEGORIAS) buckets.set(cat.id, []);

  for (const l of lawsuits) {
    const stage = (l.stage || '').toUpperCase();
    const cat = FASE_TO_CATEGORIA.get(stage);
    if (!cat) continue;

    const diasParado = diasDesde(l.status_closure) ?? diasDesde(l.created_at) ?? 0;
    buckets.get(cat.id).push({
      lawsuit_id: l.id,
      stage: l.stage,
      cliente: pickClientName(l),
      cpf: pickClientCpf(l),
      responsavel_advbox: l.responsible,
      responsible_id: l.responsible_id,
      tipo: l.type,
      protocol_number: l.protocol_number,
      folder: l.folder,
      created_at: l.created_at,
      status_closure: l.status_closure,
      notes: (l.notes || '').slice(0, 300),
      diasParado,
      estourouSla: diasParado > cat.slaDias,
    });
  }

  const categorias = CATEGORIAS.map(cat => {
    const items = buckets.get(cat.id) || [];
    items.sort((a, b) => b.diasParado - a.diasParado);
    return {
      ...cat,
      total: items.length,
      estourados: items.filter(i => i.estourouSla).length,
      processos: items,
    };
  });

  return {
    geradoEm: new Date().toISOString(),
    totalAtivos: lawsuits.length,
    totalNoController: categorias.reduce((s, c) => s + c.total, 0),
    categorias,
  };
}

// ── Cobrança em lote ─────────────────────────────────────────────────────────

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

/**
 * Cobra um único processo. Reusa a mesma tabela `audit_actions` (cooldown
 * compartilhado com a aba Auditoria — não duplica disparos).
 *
 * Retorna { ok, status, error?, cooldown_until? }
 */
async function cobrarLawsuit({ actor, lawsuit_id, user_id, descricao, problema_id, categoriaId }) {
  if (!lawsuit_id || !user_id) {
    return { ok: false, status: 400, error: 'lawsuit_id e user_id obrigatórios' };
  }

  const actionType = 'cobrar-responsavel';

  // Cooldown
  try {
    const { rows } = await dbQuery(
      `SELECT created_at FROM audit_actions
       WHERE action_type = $1 AND target_lawsuit_id = $2 AND success = TRUE
         AND created_at > NOW() - INTERVAL '${COOLDOWN_MIN} minutes'
       ORDER BY created_at DESC LIMIT 1`,
      [actionType, Number(lawsuit_id)]
    );
    if (rows.length) {
      const ageMin = Math.floor((Date.now() - new Date(rows[0].created_at).getTime()) / 60000);
      return { ok: false, status: 429, error: `Cooldown: já cobrado há ${ageMin}min` };
    }
  } catch (err) {
    console.error('[controller] cooldown check:', err.message);
  }

  // Payload AdvBox
  const fromUserId = actor?.advboxUserId || 198347; // fallback Eduardo
  const tasksId = Number(process.env.ADVBOX_TASK_ID_GENERICA) || 8894482;
  const payload = {
    tasks_id: tasksId,
    notes: `[Controller] ${descricao}. Verificar e tomar ação.`,
    start_date: ymd(new Date()),
    date_deadline: ymd(addBusinessDays(new Date(), 3)),
    from: fromUserId,
    lawsuits_id: Number(lawsuit_id),
    guests: [Number(user_id)],
  };

  // POST AdvBox
  let advboxResponse = null, success = false, errorMessage = null;
  try {
    const r = await advboxPostRaw('/posts', payload);
    advboxResponse = r.body;
    success = r.ok;
    if (!success) {
      const detail = r.body?.errors || r.body?.message || r.body?.error || r.body?.raw;
      errorMessage = `${r.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    }
  } catch (err) {
    errorMessage = err.message || String(err);
  }

  // Audit log SEMPRE
  try {
    await dbQuery(
      `INSERT INTO audit_actions
         (actor_username, actor_advbox_id, action_type, target_lawsuit_id, target_user_id,
          problema_payload, advbox_response, success, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        actor?.username || 'controller-lote',
        actor?.advboxUserId || null,
        actionType,
        Number(lawsuit_id),
        Number(user_id),
        JSON.stringify({ problema_id, categoriaId, descricao, payload, source: 'controller-lote' }),
        advboxResponse ? JSON.stringify(advboxResponse) : null,
        success,
        errorMessage,
      ]
    );
  } catch (logErr) {
    console.error('[controller] audit log:', logErr.message);
  }

  if (!success) return { ok: false, status: 502, error: errorMessage };
  return { ok: true, cooldown_until: new Date(Date.now() + COOLDOWN_MIN * 60_000).toISOString() };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Cobra vários processos em sequência com throttle.
 * items: [{ lawsuit_id, user_id, descricao, problema_id, categoriaId }]
 * Throttle padrão 1.2s entre requisições (~50 req/min, respeita rate do AdvBox).
 */
async function cobrarLote({ actor, items, throttleMs = 1200 }) {
  const resultados = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const r = await cobrarLawsuit({ actor, ...item });
      resultados.push({ lawsuit_id: item.lawsuit_id, ...r });
    } catch (e) {
      resultados.push({ lawsuit_id: item.lawsuit_id, ok: false, error: e.message });
    }
    if (i < items.length - 1) await sleep(throttleMs);
  }
  const sucesso = resultados.filter(r => r.ok).length;
  const cooldown = resultados.filter(r => r.status === 429).length;
  const erro = resultados.length - sucesso - cooldown;
  return { total: items.length, sucesso, cooldown, erro, resultados };
}

module.exports = { buildOverview, CATEGORIAS, cobrarLawsuit, cobrarLote };
