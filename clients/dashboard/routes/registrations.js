const { Router } = require('express');
const { fetchLawsuits } = require('../../../services/data');
const cache = require('../../../cache');

cache.define('registrations', 20 * 60 * 1000);

const RESP_VALIDOS    = ['THIAGO', 'MARILIA', 'LETICIA', 'EDUARDO', 'TAMMYRES'];
const BPC_TRIGGERS    = ['BPC', 'BENEFICIO ASSISTENCIAL', 'AUXILIO DOENCA', 'AUXÍLIO DOENÇA', 'BENEFÍCIO ASSISTENCIAL'];
const LAUDO_OPCOES    = ['COM LAUDO', 'SEM LAUDO', 'LAUDO OK', 'FAZER LAUDO', 'AGUARDANDO LAUDO'];
const ORIGEM_ORGANICA = ['ORGANICO', 'PARCERIA', 'PARCEIRO', 'PARCEIRA', 'ESCRITORIO', 'INDICACAO', 'INDICAÇÃO', 'ORGÂNICO', 'ESCRITÓRIO'];
const CAMPANHAS       = ['LAUDO DO SUS'];

function norm(s) { return (s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function getField(obj, ...keys) {
  for (const k of keys) { if (obj[k] != null && obj[k] !== '') return obj[k]; }
  return null;
}
function parseDeadline(str) {
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return new Date(str.slice(0, 10) + 'T00:00:00');
  if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) { const [d, m, y] = str.split('/'); return new Date(`${y}-${m}-${d}T00:00:00`); }
  return new Date(str);
}

async function buildRegistrations() {
  const all = await fetchLawsuits(true);
  const results = [];

  for (const l of all) {
    const dateStr = getField(l, 'created_at', 'date_cadastro', 'dt_cadastro', 'date_registration', 'registration_date', 'date', 'created');
    if (!dateStr) continue;
    const dateObj = parseDeadline(String(dateStr));
    if (!dateObj || isNaN(dateObj)) continue;

    const rawNotes  = getField(l, 'general_notes', 'annotations', 'notes', 'general_annotation', 'anotacoes', 'note', 'observation') || '';
    const notes     = norm(rawNotes);
    const rawTipo   = getField(l, 'type_of_action', 'action_type', 'tipo_acao', 'lawsuit_type', 'type', 'kind', 'action') || '';
    const tipoNorm  = norm(rawTipo);
    const responsible = getField(l, 'responsible', 'responsible_name', 'user_name', 'lawyer', 'attorney') || '';

    const clientsArr = Array.isArray(l.customers) ? l.customers : [];
    let clientName = '';
    if (clientsArr.length) {
      const personal = clientsArr.find(c => c.name && !/INSS|INSTITUTO NACIONAL|PREVIDENCIA|ESTADO|MUNICIPIO|UNIAO FEDERAL/i.test(norm(c.name)));
      clientName = (personal || clientsArr[0]).name || '';
    } else {
      clientName = getField(l, 'customer_name', 'client_name', 'customers_name') || '';
    }

    const problemas = [];
    const hasFechadoPor = RESP_VALIDOS.some(r => {
      if (notes.includes(`FECHADO POR ${r}`) || notes.includes(`FECHADO POR: ${r}`) || notes.includes(`FECHADO ${r}`)) return true;
      const i = notes.indexOf('FECHADO POR ');
      return i >= 0 && notes.slice(i + 12, i + 40).includes(r);
    });
    if (!hasFechadoPor) problemas.push({ code: 'SEM_FECHADO_POR', label: 'Sem fechado por', severity: 'critical' });

    const isBpcAux = BPC_TRIGGERS.some(k => tipoNorm.includes(k));
    if (isBpcAux && !LAUDO_OPCOES.some(k => notes.includes(k))) problemas.push({ code: 'SEM_LAUDO', label: 'Sem laudo', severity: 'critical' });

    if (hasFechadoPor && !ORIGEM_ORGANICA.some(k => notes.includes(k)) && !notes.includes('CAMPANHA') && !CAMPANHAS.some(c => notes.includes(c))) {
      problemas.push({ code: 'SEM_CAMPANHA', label: 'Canal não identificado', severity: 'mild' });
    }

    let origem = 'DESCONHECIDO';
    if (['PARCERIA', 'PARCEIRO', 'PARCEIRA'].some(k => notes.includes(k)))                                      origem = 'PARCEIRO';
    else if (['ORGANICO', 'ORGÂNICO', 'ESCRITORIO', 'ESCRITÓRIO', 'INDICACAO', 'INDICAÇÃO'].some(k => notes.includes(k))) origem = 'ORGANICO';
    else if (notes.includes('CAMPANHA') || CAMPANHAS.some(c => notes.includes(c)))                              origem = 'CAMPANHA';

    let campanhaNome = '';
    if (origem === 'CAMPANHA') {
      const ci = notes.indexOf('CAMPANHA ');
      if (ci >= 0) { const after = notes.slice(ci + 9); const end = after.search(/[,.|;]/); campanhaNome = (end >= 0 ? after.slice(0, end) : after.slice(0, 50)).trim(); }
      else campanhaNome = CAMPANHAS.find(c => notes.includes(c)) || '';
    }

    let laudoStatus = 'N/A';
    if (isBpcAux) laudoStatus = LAUDO_OPCOES.find(k => notes.includes(k)) || 'PENDENTE';

    let fechadoPorNome = '';
    const fpIdx = notes.indexOf('FECHADO POR ');
    if (fpIdx >= 0) { const after = notes.slice(fpIdx + 12); const end = after.search(/[,.|;]/); fechadoPorNome = (end >= 0 ? after.slice(0, end) : after.slice(0, 35)).trim(); }

    const id         = l.id || l.lawsuits_id;
    const severity   = problemas.some(p => p.severity === 'critical') ? 'critical' : problemas.length ? 'mild' : 'ok';
    const causeValue = parseFloat(String(l.fees_expec  || '0').replace(/[^0-9.,]/g, '').replace(',', '.')) || 0;
    const feesValue  = parseFloat(String(l.fees_money  || '0').replace(/[^0-9.,]/g, '').replace(',', '.')) || 0;
    const feesPercent= parseFloat(String(l.contingency || '0').replace(/[^0-9.,]/g, '').replace(',', '.')) || 0;

    results.push({ id, processo: l.process_number || `#${id}`, cliente: clientName, tipo: rawTipo, data: dateStr, responsavel: responsible, fechadoPor: fechadoPorNome, origem, campanha: campanhaNome, laudoStatus, problemas, severity, causeValue, feesValue, feesPercent });
  }

  const order = { critical: 0, mild: 1, ok: 2 };
  results.sort((a, b) => { const d = order[a.severity] - order[b.severity]; return d !== 0 ? d : new Date(b.data) - new Date(a.data); });
  console.log(`[Cadastros] ${results.length} processos | ${results.filter(r => r.severity === 'critical').length} críticos`);
  return { results };
}

let _building = false;
const router  = Router();

router.get('/incomplete-registrations', async (req, res, next) => {
  try {
    const force = req.query.force === '1';
    if (force) cache.invalidate('registrations');

    if ((force || cache.isStale('registrations')) && !_building) {
      _building = true;
      buildRegistrations()
        .then(data => cache.set('registrations', { ...data, cachedAt: new Date().toISOString() }))
        .catch(err => console.error('[Cadastros] Erro:', err.message))
        .finally(() => { _building = false; });
    }

    const cached = cache.getData('registrations');
    res.json(cached ? { ...cached, loading: false } : { loading: true, results: [] });
  } catch (err) { next(err); }
});

module.exports = router;
