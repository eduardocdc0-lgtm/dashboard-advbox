const { Router } = require('express');
const { client } = require('../../../services/data');
const cache = require('../../../cache');

const router = Router();

cache.define('petitions_month', 10 * 60 * 1000);

// ── Identificação de Petições ─────────────────────────────────────────────────
// HEURÍSTICA: considera "petição" qualquer tarefa cujo campo `task` contenha
// uma das palavras-chave abaixo (sem acento, maiúsculas).
// Ajuste a lista conforme os tipos reais do escritório.
const PETITION_KEYWORDS = [
  'PETIÇÃO', 'PETICAO', 'RECURSO', 'AJUIZAR', 'PROTOCOLAR',
  'CUMPRIMENTO DE SENTENÇA', 'CUMPRIMENTO DE SENTENCA',
  'INICIAL', 'CONTESTAÇÃO', 'CONTESTACAO', 'MANIFESTAÇÃO', 'MANIFESTACAO',
  'IMPUGNAÇÃO', 'IMPUGNACAO',
];

function normStr(s) {
  return (s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function isPetition(task) {
  const t = normStr(task);
  return PETITION_KEYWORDS.some(kw => t.includes(kw));
}

// ── Fuso America/Recife (UTC-3) ───────────────────────────────────────────────
function recifeDateStr(offsetDays = 0) {
  const d = new Date(Date.now() - 3 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

function getPeriodRange(period) {
  const today = recifeDateStr(0);
  if (period === 'today')     return { start: today + ' 00:00:00', end: today + ' 23:59:59' };
  if (period === 'yesterday') {
    const y = recifeDateStr(-1);
    return { start: y + ' 00:00:00', end: y + ' 23:59:59' };
  }
  if (period === 'this_week') {
    // Segunda como início de semana
    const dow = new Date(today).getDay(); // 0=Dom
    const diff = dow === 0 ? -6 : 1 - dow;
    const weekStart = recifeDateStr(diff);
    return { start: weekStart + ' 00:00:00', end: today + ' 23:59:59' };
  }
  if (period === 'this_month') {
    return { start: today.slice(0, 7) + '-01 00:00:00', end: today + ' 23:59:59' };
  }
  return { start: today + ' 00:00:00', end: today + ' 23:59:59' };
}

function inRange(createdAt, range) {
  if (!createdAt) return false;
  const d = createdAt.slice(0, 19);
  return d >= range.start && d <= range.end;
}

// ── Fetch de posts por intervalo ──────────────────────────────────────────────
async function fetchPostsForPeriod(period) {
  const range = getPeriodRange(period);
  const limitPerPage = 500;
  const maxPages = period === 'this_month' ? 10 : period === 'this_week' ? 5 : 2;

  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const offset = page * limitPerPage;
    let data;
    try {
      data = await client.request(`/posts?limit=${limitPerPage}&offset=${offset}`);
    } catch (e) {
      if (e.message === 'RATE_LIMIT' && page > 0) break;
      throw e;
    }
    const items = Array.isArray(data) ? data : (data.data || []);
    if (!items.length) break;

    for (const p of items) {
      if (inRange(p.created_at, range)) all.push(p);
    }

    // Se o item mais antigo desta página já é anterior ao início do período, para
    const oldest = items[items.length - 1];
    if (oldest && oldest.created_at && oldest.created_at.slice(0, 19) < range.start) break;
    if (items.length < limitPerPage) break;
  }
  return { posts: all, range };
}

// ── Rota principal ────────────────────────────────────────────────────────────
router.get('/petitions/by-person', async (req, res, next) => {
  try {
    const period      = req.query.period || 'today';
    const filterResp  = req.query.responsible || null;

    const { posts, range } = await fetchPostsForPeriod(period);
    const petitions = posts.filter(p => isPetition(p.task));

    // Agrupar por responsável
    const byPerson = {};
    for (const p of petitions) {
      for (const u of (p.users || [])) {
        if (!u.name) continue;
        const name = u.name;
        if (filterResp && normStr(name) !== normStr(filterResp)) continue;
        if (!byPerson[name]) byPerson[name] = { name, count: 0, types: {}, items: [] };
        byPerson[name].count++;
        byPerson[name].types[p.task] = (byPerson[name].types[p.task] || 0) + 1;
        byPerson[name].items.push({
          id: p.id,
          task: p.task,
          notes: (p.notes || '').slice(0, 120),
          lawsuits_id: p.lawsuits_id,
          lawsuit_name: p.lawsuit?.name || null,
          created_at: p.created_at,
        });
      }
    }

    const result = Object.values(byPerson).sort((a, b) => b.count - a.count);
    const total  = result.reduce((s, p) => s + p.count, 0);

    res.json({ period, range, total, by_person: result });
  } catch (err) { next(err); }
});

module.exports = router;
