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
const { fetchLawsuits, fetchAllPosts } = require('./data');
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
    titulo: '📋 Processo sem laudo',
    descricao: 'Cliente precisa fazer/enviar laudo médico',
    fases: ['PROCESSO SEM LAUDO', 'FALTA LAUDO - FAZER PREVDOC', 'FALTA LAUDO', 'PREVDOC', 'PROCESSOS SEM LAUDOS'],
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

// ── Setores (agrupam categorias pra ranking de eficiência) ───────────────────
const SETORES = [
  {
    id: 'comercial',
    titulo: '💼 Comercial',
    cor: '#8b5cf6',
    responsaveis: ['TAMMYRES'],
    categorias: ['sem_laudo_prevdoc'],
  },
  {
    id: 'operacional',
    titulo: '⚙️ Operacional',
    cor: '#f97316',
    responsaveis: ['MARILIA'],
    categorias: ['dar_entrada', 'protocolado_adm_velho', 'reprotocolar'],
  },
  {
    id: 'juridico',
    titulo: '⚖️ Jurídico',
    cor: '#14b8a6',
    responsaveis: ['LETICIA_OU_ALICE'],
    categorias: ['peticao_inicial', 'com_prazo'],
  },
];

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

/**
 * Indexa tasks pendentes por lawsuit_id pra detectar "sem workflow ativo".
 * Uma task é pendente quando ninguém marcou completed=true. Se a task tá
 * só atribuída sem conclusão e sem prazo passado, ainda conta como "ativa".
 */
function indexTasksPendentes(posts) {
  const idx = new Map();
  for (const p of posts || []) {
    if (!p.lawsuits_id) continue;
    const users = Array.isArray(p.users) ? p.users : [];
    const algumPendente = users.some(u => u && (u.completed === null || u.completed === false));
    if (!algumPendente) continue;
    if (!idx.has(p.lawsuits_id)) idx.set(p.lawsuits_id, 0);
    idx.set(p.lawsuits_id, idx.get(p.lawsuits_id) + 1);
  }
  return idx;
}

async function buildOverview({ force = false } = {}) {
  const lawsuits = await fetchLawsuits(force);

  // Posts em paralelo — pra detectar quem tá sem task ativa.
  // Falha resiliente: se /posts der erro/rate-limit, o detector fica off
  // mas o resto do Controller continua funcionando.
  let tasksIdx = new Map();
  try {
    const posts = await fetchAllPosts(500, 4, 600, force);
    tasksIdx = indexTasksPendentes(posts);
  } catch (e) {
    console.error('[controller] sem-workflow detector off: ' + e.message);
  }

  const buckets = new Map();
  for (const cat of CATEGORIAS) buckets.set(cat.id, []);

  for (const l of lawsuits) {
    const stage = (l.stage || '').toUpperCase();
    const cat = FASE_TO_CATEGORIA.get(stage);
    if (!cat) continue;

    const diasParado = diasDesde(l.status_closure) ?? diasDesde(l.created_at) ?? diasDesde(new Date().toISOString()) ?? 0;
    const tasksPendentes = tasksIdx.get(l.id) || 0;
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
      tasksPendentes,
      semWorkflow: tasksPendentes === 0,
    });
  }

  const categorias = CATEGORIAS.map(cat => {
    const items = buckets.get(cat.id) || [];
    items.sort((a, b) => b.diasParado - a.diasParado);
    return {
      ...cat,
      total: items.length,
      estourados: items.filter(i => i.estourouSla).length,
      semWorkflow: items.filter(i => i.semWorkflow).length,
      processos: items,
    };
  });

  const ranking = computeRanking(categorias);

  return {
    geradoEm: new Date().toISOString(),
    totalAtivos: lawsuits.length,
    totalNoController: categorias.reduce((s, c) => s + c.total, 0),
    totalSemWorkflow: categorias.reduce((s, c) => s + c.semWorkflow, 0),
    categorias,
    ranking,
  };
}

/**
 * Calcula score 0-100 por setor com base na foto atual:
 *  - 60%  % de processos dentro do SLA (qualidade da fila)
 *  - 40%  proximidade de zero do tempo médio parado (velocidade)
 *
 * Score alto = setor entregando dentro do prazo e com fila curta.
 * Quando o setor tem 0 processos pendentes → score 100 (esteira limpa).
 *
 * Limitação: usa só o estado atual. Sem histórico de stages, não dá pra
 * medir "volume entregue por dia". Esse dado vem quando o cron diário
 * de snapshot começar a popular controller_snapshots.
 */
function computeRanking(categorias) {
  const setores = SETORES.map(setor => {
    const cats = categorias.filter(c => setor.categorias.includes(c.id));
    const totalProc = cats.reduce((s, c) => s + c.total, 0);
    const totalEstourados = cats.reduce((s, c) => s + c.estourados, 0);
    const allProcs = cats.flatMap(c => c.processos);
    const diasMedios = allProcs.length
      ? allProcs.reduce((s, p) => s + p.diasParado, 0) / allProcs.length
      : 0;
    const maxSla = Math.max(...cats.map(c => c.slaDias), 1);

    let score = 100;
    if (totalProc > 0) {
      const slaPct = ((totalProc - totalEstourados) / totalProc) * 100;
      const velocidade = Math.max(0, 100 - (diasMedios / maxSla) * 100);
      score = Math.round(slaPct * 0.6 + velocidade * 0.4);
    }

    return {
      id: setor.id,
      titulo: setor.titulo,
      cor: setor.cor,
      responsaveis: setor.responsaveis,
      totalProc,
      totalEstourados,
      diasMedios: Math.round(diasMedios * 10) / 10,
      slaPct: totalProc > 0 ? Math.round(((totalProc - totalEstourados) / totalProc) * 100) : 100,
      score,
    };
  });

  setores.sort((a, b) => b.score - a.score);
  setores.forEach((s, i) => { s.posicao = i + 1; });
  return setores;
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

// ── Snapshot diário (cron 23h) ───────────────────────────────────────────────

/**
 * Grava a foto atual do Controller no Postgres pra tendência/produtividade.
 * Roda 1x por dia via cron. Idempotente — re-rodar no mesmo dia atualiza
 * a linha existente (UPSERT).
 *
 * Aproveita o pipeline do buildOverview pra usar exatamente a mesma lógica
 * que o dashboard mostra ao vivo.
 */
async function saveSnapshot({ force = true } = {}) {
  const overview = await buildOverview({ force });

  // Mapeia categoria → setor (pra facilitar query por setor depois)
  const catToSetor = new Map();
  for (const setor of SETORES) {
    for (const catId of setor.categorias) catToSetor.set(catId, setor.id);
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let saved = 0;
  for (const cat of overview.categorias) {
    const diasMedios = cat.processos.length
      ? cat.processos.reduce((s, p) => s + p.diasParado, 0) / cat.processos.length
      : 0;
    const slaPct = cat.total > 0
      ? Math.round(((cat.total - cat.estourados) / cat.total) * 100)
      : 100;

    try {
      await dbQuery(
        `INSERT INTO controller_snapshots
           (snapshot_date, categoria_id, setor_id, total, estourados, dias_medios, sla_pct)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (snapshot_date, categoria_id) DO UPDATE SET
           setor_id    = EXCLUDED.setor_id,
           total       = EXCLUDED.total,
           estourados  = EXCLUDED.estourados,
           dias_medios = EXCLUDED.dias_medios,
           sla_pct     = EXCLUDED.sla_pct`,
        [today, cat.id, catToSetor.get(cat.id) || null, cat.total, cat.estourados, diasMedios.toFixed(2), slaPct]
      );
      saved++;
    } catch (err) {
      console.error(`[controller-snapshot] cat ${cat.id}: ${err.message}`);
    }
  }
  console.log(`[controller-snapshot] ${saved}/${overview.categorias.length} categorias salvas em ${today}`);
  return { date: today, saved, total: overview.categorias.length };
}

/**
 * Lê últimos N dias do histórico e calcula:
 *  - série temporal por categoria (total + estourados por dia)
 *  - delta vs ontem (subiu/desceu)
 *  - volume entregue (estimativa: redução no total = processos que saíram da fila)
 */
async function getTendencia({ dias = 7 } = {}) {
  const { rows } = await dbQuery(
    `SELECT snapshot_date::text AS date, categoria_id, setor_id, total, estourados, dias_medios, sla_pct
     FROM controller_snapshots
     WHERE snapshot_date >= CURRENT_DATE - $1::INT
     ORDER BY snapshot_date ASC, categoria_id ASC`,
    [dias]
  );

  // Agrupa por categoria → série
  const porCategoria = new Map();
  for (const r of rows) {
    if (!porCategoria.has(r.categoria_id)) porCategoria.set(r.categoria_id, []);
    porCategoria.get(r.categoria_id).push({
      date: r.date,
      total: r.total,
      estourados: r.estourados,
      diasMedios: Number(r.dias_medios),
      slaPct: r.sla_pct,
    });
  }

  // Calcula delta (último ponto vs penúltimo)
  const deltas = {};
  for (const [catId, serie] of porCategoria) {
    if (serie.length < 2) { deltas[catId] = null; continue; }
    const atual = serie[serie.length - 1];
    const ontem = serie[serie.length - 2];
    deltas[catId] = {
      totalDelta: atual.total - ontem.total,
      // Volume entregue ≈ se total caiu, processos saíram da fila
      entregues: Math.max(0, ontem.total - atual.total),
      // Volume entrante: se subiu, entraram novos
      novos: Math.max(0, atual.total - ontem.total),
      slaDelta: atual.slaPct - ontem.slaPct,
    };
  }

  return {
    series: Object.fromEntries(porCategoria),
    deltas,
    diasNoHistorico: porCategoria.size > 0 ? Math.max(...[...porCategoria.values()].map(s => s.length)) : 0,
  };
}

module.exports = {
  buildOverview,
  CATEGORIAS,
  SETORES,
  cobrarLawsuit,
  cobrarLote,
  saveSnapshot,
  getTendencia,
};
