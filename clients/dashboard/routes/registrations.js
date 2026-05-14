/**
 * Rota de cadastros pendentes (validação de anotações dos processos).
 *
 * Bug fix: removido o `fetchLawsuits(true)` que invalidava o cache de
 * lawsuits a cada chamada. Agora respeita o cache; `?force=1` invalida.
 */

'use strict';

const { Router } = require('express');
const { fetchLawsuits } = require('../../../services/data');
const cache = require('../../../cache');
const { asyncHandler } = require('../../../middleware/errorHandler');

cache.define('registrations', 20 * 60 * 1000);

// ── Constantes de domínio ─────────────────────────────────────────────────────
const RESP_VALIDOS = ['THIAGO', 'MARILIA', 'LETICIA', 'EDUARDO', 'TAMMYRES'];
const BPC_TRIGGERS = ['BPC', 'BENEFICIO ASSISTENCIAL', 'AUXILIO DOENCA', 'AUXÍLIO DOENÇA', 'BENEFÍCIO ASSISTENCIAL'];
// Frases que sinalizam status de laudo. Comparadas após norm() (uppercase + sem acentos).
// Eduardo escolheu manter "LAUDO PELO ESCRITORIO" como variação aceita (campanha de
// laudo feito internamente). Inclui variações comuns pra não exigir digitação exata.
const LAUDO_OPCOES = [
  'COM LAUDO', 'SEM LAUDO', 'LAUDO OK', 'FAZER LAUDO', 'AGUARDANDO LAUDO',
  'LAUDO PELO ESCRITORIO', 'LAUDO DO ESCRITORIO', 'LAUDO ESCRITORIO',
];
const ORIGEM_ORGANICA = ['ORGANICO', 'PARCERIA', 'PARCEIRO', 'PARCEIRA', 'ESCRITORIO', 'INDICACAO', 'INDICAÇÃO', 'ORGÂNICO', 'ESCRITÓRIO'];
const CAMPANHAS = ['LAUDO DO SUS'];
const ENTIDADES_NAO_PESSOAIS = /INSS|INSTITUTO NACIONAL|PREVIDENCIA|ESTADO|MUNICIPIO|UNIAO FEDERAL/i;

// ── Utilitários ───────────────────────────────────────────────────────────────
function norm(s) {
  return (s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function getField(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
}

function parseDate(str) {
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return new Date(str.slice(0, 10) + 'T00:00:00');
  if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) {
    const [d, m, y] = str.split('/');
    return new Date(`${y}-${m}-${d}T00:00:00`);
  }
  return new Date(str);
}

function parseFloatBR(s) {
  return parseFloat(String(s || '0').replace(/[^0-9.,]/g, '').replace(',', '.')) || 0;
}

function detectarFechadoPor(notes) {
  for (const r of RESP_VALIDOS) {
    if (notes.includes(`FECHADO POR ${r}`) || notes.includes(`FECHADO POR: ${r}`) || notes.includes(`FECHADO ${r}`)) return true;
    const i = notes.indexOf('FECHADO POR ');
    if (i >= 0 && notes.slice(i + 12, i + 40).includes(r)) return true;
  }
  return false;
}

function detectarOrigem(notes) {
  if (['PARCERIA', 'PARCEIRO', 'PARCEIRA'].some(k => notes.includes(k))) return 'PARCEIRO';
  if (['ORGANICO', 'ORGÂNICO', 'ESCRITORIO', 'ESCRITÓRIO', 'INDICACAO', 'INDICAÇÃO'].some(k => notes.includes(k))) return 'ORGANICO';
  if (notes.includes('CAMPANHA') || CAMPANHAS.some(c => notes.includes(c))) return 'CAMPANHA';
  return 'DESCONHECIDO';
}

function extrairCampanha(notes) {
  const ci = notes.indexOf('CAMPANHA ');
  if (ci >= 0) {
    const after = notes.slice(ci + 9);
    const end = after.search(/[,.|;]/);
    return (end >= 0 ? after.slice(0, end) : after.slice(0, 50)).trim();
  }
  return CAMPANHAS.find(c => notes.includes(c)) || '';
}

function extrairFechadoPorNome(notes) {
  const fpIdx = notes.indexOf('FECHADO POR ');
  if (fpIdx < 0) return '';
  const after = notes.slice(fpIdx + 12);
  const end = after.search(/[,.|;]/);
  return (end >= 0 ? after.slice(0, end) : after.slice(0, 35)).trim();
}

function pickClientName(lawsuit) {
  const arr = Array.isArray(lawsuit.customers) ? lawsuit.customers : [];
  if (arr.length === 0) {
    return getField(lawsuit, 'customer_name', 'client_name', 'customers_name') || '';
  }
  const personal = arr.find(c => c.name && !ENTIDADES_NAO_PESSOAIS.test(norm(c.name)));
  return (personal || arr[0]).name || '';
}

// ── Construção do dataset ─────────────────────────────────────────────────────
async function buildRegistrations(force = false) {
  const all = await fetchLawsuits(force);   // ← respeita cache; só força se pedido
  const results = [];

  for (const l of all) {
    const dateStr = getField(l, 'created_at', 'date_cadastro', 'dt_cadastro', 'date_registration', 'registration_date', 'date', 'created');
    if (!dateStr) continue;
    const dateObj = parseDate(String(dateStr));
    if (!dateObj || isNaN(dateObj)) continue;

    const rawNotes = getField(l, 'general_notes', 'annotations', 'notes', 'general_annotation', 'anotacoes', 'note', 'observation') || '';
    const notes    = norm(rawNotes);
    const rawTipo  = getField(l, 'type_of_action', 'action_type', 'tipo_acao', 'lawsuit_type', 'type', 'kind', 'action') || '';
    const tipoNorm = norm(rawTipo);
    const responsible = getField(l, 'responsible', 'responsible_name', 'user_name', 'lawyer', 'attorney') || '';
    const clientName  = pickClientName(l);

    const problemas = [];
    const hasFechadoPor = detectarFechadoPor(notes);
    if (!hasFechadoPor) problemas.push({ code: 'SEM_FECHADO_POR', label: 'Sem fechado por', severity: 'critical' });

    const isBpcAux = BPC_TRIGGERS.some(k => tipoNorm.includes(k));
    if (isBpcAux && !LAUDO_OPCOES.some(k => notes.includes(k))) {
      problemas.push({ code: 'SEM_LAUDO', label: 'Sem laudo', severity: 'critical' });
    }

    if (hasFechadoPor && !ORIGEM_ORGANICA.some(k => notes.includes(k))
        && !notes.includes('CAMPANHA') && !CAMPANHAS.some(c => notes.includes(c))) {
      problemas.push({ code: 'SEM_CAMPANHA', label: 'Canal não identificado', severity: 'mild' });
    }

    const origem      = detectarOrigem(notes);
    const campanhaNome = origem === 'CAMPANHA' ? extrairCampanha(notes) : '';
    const laudoStatus = isBpcAux ? (LAUDO_OPCOES.find(k => notes.includes(k)) || 'PENDENTE') : 'N/A';
    const fechadoPorNome = extrairFechadoPorNome(notes);

    const id        = l.id || l.lawsuits_id;
    const severity  = problemas.some(p => p.severity === 'critical') ? 'critical' : (problemas.length ? 'mild' : 'ok');

    results.push({
      id,
      processo:   l.process_number || `#${id}`,
      cliente:    clientName,
      tipo:       rawTipo,
      data:       dateStr,
      responsavel: responsible,
      fechadoPor:  fechadoPorNome,
      origem,
      campanha:    campanhaNome,
      laudoStatus,
      problemas,
      severity,
      causeValue:  parseFloatBR(l.fees_expec),
      feesValue:   parseFloatBR(l.fees_money),
      feesPercent: parseFloatBR(l.contingency),
    });
  }

  const order = { critical: 0, mild: 1, ok: 2 };
  results.sort((a, b) => {
    const d = order[a.severity] - order[b.severity];
    return d !== 0 ? d : new Date(b.data) - new Date(a.data);
  });

  return { results };
}

// ── Rota ──────────────────────────────────────────────────────────────────────
const router = Router();

router.get('/incomplete-registrations', asyncHandler(async (req, res) => {
  const force = req.query.force === '1';
  if (force) cache.invalidate('registrations');

  // Build em background (mantém UX rápido) — usa lock simples
  if ((force || cache.isStale('registrations')) && !buildRegistrations._building) {
    buildRegistrations._building = true;
    buildRegistrations(force)
      .then(data => cache.set('registrations', { ...data, cachedAt: new Date().toISOString() }))
      .catch(err => console.error('[Cadastros] build erro:', err.message))
      .finally(() => { buildRegistrations._building = false; });
  }

  const cached = cache.getData('registrations');
  res.json(cached ? { ...cached, loading: false } : { loading: true, results: [] });
}));

module.exports = router;
