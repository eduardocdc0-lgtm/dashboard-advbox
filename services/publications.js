/**
 * Publicações recentes — agrega /last_movements (movimentos processuais)
 * com /lawsuits (pra enriquecer com nome de cliente e fase do processo).
 *
 * Source: /last_movements traz tudo que o AdvBox capturou dos diários da
 * justiça (PJe, e-SAJ, Projudi). Aqui filtramos por janela (default 7 dias)
 * e devolvemos formato pronto pra UI.
 *
 * Cache: usa o cache compartilhado 'flow' (já definido em data.js), TTL
 * 20 min. Evita martelar a API a cada refresh da aba.
 */

'use strict';

const { client, fetchLawsuits } = require('./data');
const cache = require('../cache');

const DEFAULT_DAYS = 7;
const MOVEMENTS_LIMIT = 500;

function parseTs(s) {
  if (!s) return NaN;
  const ts = Date.parse(s);
  return Number.isNaN(ts) ? NaN : ts;
}

function normalizeMovement(m, lawByid) {
  const lawId = Number(m.lawsuit_id || m.lawsuits_id || m.lawsuitId || 0) || null;
  const law = lawId ? lawByid.get(lawId) : null;
  return {
    date: m.date || m.created_at || m.movement_date || null,
    lawsuit_id: lawId,
    lawsuit_number: law?.number || law?.process_number || null,
    cliente: law?.customer?.name || law?.customer_name || law?.name || '—',
    stage: law?.stage || null,
    description: m.description || m.movement || m.text || m.content || '',
    source: m.source || m.tribunal || m.diario || null,
  };
}

/**
 * Retorna publicações dos últimos N dias enriquecidas com dados do lawsuit.
 * @param {Object} opts
 * @param {number} [opts.days=7]
 * @param {boolean} [opts.force=false] — pula cache
 * @returns {Promise<{total:number, days:number, items:Array, error?:string}>}
 */
async function getRecentPublications({ days = DEFAULT_DAYS, force = false } = {}) {
  const cacheKey = `publications:${days}`;
  return cache.getOrFetch(cacheKey, async () => {
    let movData, lawsuits;
    try {
      [movData, lawsuits] = await Promise.all([
        client.getLastMovements(MOVEMENTS_LIMIT),
        fetchLawsuits(),
      ]);
    } catch (e) {
      return { total: 0, days, items: [], error: e.message };
    }

    const movsRaw = Array.isArray(movData) ? movData : (movData?.data || []);
    const lawByid = new Map();
    for (const l of lawsuits || []) {
      const id = Number(l.id);
      if (id) lawByid.set(id, l);
    }

    const limite = Date.now() - days * 86400 * 1000;
    const items = movsRaw
      .map(m => normalizeMovement(m, lawByid))
      .filter(m => {
        const ts = parseTs(m.date);
        return !Number.isNaN(ts) && ts >= limite;
      })
      .sort((a, b) => parseTs(b.date) - parseTs(a.date));

    return { total: items.length, days, items };
  }, force);
}

// Define cache do módulo (TTL 20 min pra cada janela)
cache.define('publications:7', 20 * 60 * 1000);
cache.define('publications:14', 20 * 60 * 1000);
cache.define('publications:30', 20 * 60 * 1000);

module.exports = { getRecentPublications };
