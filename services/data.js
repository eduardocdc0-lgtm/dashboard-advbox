/**
 * Camada de dados compartilhada — wraps do AdvBoxClient com cache inteligente.
 */

const client = require('./advbox-instance');
const cache  = require('../cache');

cache
  .define('lawsuits',     20 * 60 * 1000)
  .define('transactions', 30 * 60 * 1000)
  .define('flow',         20 * 60 * 1000);

async function fetchLawsuits(force = false) {
  return cache.getOrFetch('lawsuits', () => client.getAllLawsuits(), force);
}

async function fetchTransactions(force = false) {
  return cache.getOrFetch('transactions', async () => {
    const data = await client.getTransactions();
    return Array.isArray(data) ? data : (data.data || []);
  }, force);
}

async function fetchAllPosts(limitPerPage = 500, maxPages = 4, delayMs = 600) {
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
    all.push(...items);
    console.log(`[Posts] p${page + 1}: ${items.length} (total: ${all.length})`);
    if (items.length < limitPerPage) break;
    if (page < maxPages - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  return all;
}

module.exports = { fetchLawsuits, fetchTransactions, fetchAllPosts, client };
