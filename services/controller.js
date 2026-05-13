/**
 * Controller — fonte única de verdade sobre "esteira andando direito".
 *
 * Diferente do auditor (que classifica por severidade), o Controller agrupa
 * por TIPO DE AÇÃO PENDENTE — o que o escritório precisa FAZER pra destravar.
 *
 * Cada categoria mapeia 1+ fases do AdvBox a um responsável e uma ação.
 */

'use strict';

const { fetchLawsuits } = require('./data');

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

module.exports = { buildOverview, CATEGORIAS };
