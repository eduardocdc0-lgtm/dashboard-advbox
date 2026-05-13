/**
 * Camada de dados compartilhada — wraps do AdvBoxClient com cache inteligente.
 */

const client = require('./advbox-instance');
const cache  = require('../cache');

cache
  .define('lawsuits',     20 * 60 * 1000)
  .define('transactions', 30 * 60 * 1000)
  .define('customers',    30 * 60 * 1000)
  .define('flow',         20 * 60 * 1000);

async function fetchLawsuits(force = false) {
  return cache.getOrFetch('lawsuits', () => client.getAllLawsuits(), force);
}

async function fetchCustomers(force = false) {
  return cache.getOrFetch('customers', () => client.getAllCustomers(), force);
}

async function fetchTransactions(force = false) {
  // Usa paginação — sem isso, /transactions trunca em 1000 e as 40+ tx mais
  // recentes ficam fora (caso Marcos Vinicius 28/05/2026 confirmou o bug).
  return cache.getOrFetch('transactions', () => client.getAllTransactions(), force);
}

async function fetchAllPosts(limitPerPage = 500, maxPages = 4, delayMs = 600, force = false) {
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const offset = page * limitPerPage;
    let data;
    try {
      data = await client.request(`/posts?limit=${limitPerPage}&offset=${offset}`);
    } catch (e) {
      // Falha resiliente: loga e segue. Se a 1ª página falhar, retornamos
      // array vazio em vez de quebrar a rota toda (que faz "Atividade da
      // equipe" sumir com mensagem genérica de erro).
      console.error(`[Posts] p${page + 1} falhou: ${e.message}`);
      if (e.message === 'RATE_LIMIT' && page > 0) break;
      if (page === 0) return all; // nada conseguimos
      break;
    }
    const items = Array.isArray(data) ? data : (data.data || []);
    all.push(...items);
    console.log(`[Posts] p${page + 1}: ${items.length} (total: ${all.length})`);
    if (items.length < limitPerPage) break;
    if (page < maxPages - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  return all;
}

module.exports = { fetchLawsuits, fetchCustomers, fetchTransactions, fetchAllPosts, client };
