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

/**
 * Busca posts/tarefas filtrando por um par de datas nativo da API
 * (created_start/created_end, completed_start/completed_end, etc — ver doc
 * oficial api.softwareadvbox.com.br/docs/tasks/getPosts), formato YYYY-MM-DD.
 *
 * Por que existe: `fetchAllPosts` pagina "às cegas" e, como a AdvBox às vezes
 * IGNORA o offset (vide getAllTransactions), na prática só os ~500 posts mais
 * recentes chegavam — cobrindo só os últimos dias do mês. Filtrando por data no
 * servidor, o volume cai pra ~1 mês e cabe em poucas páginas — com dedup +
 * guarda de "offset ignorado" por segurança.
 *
 * @param {string} startParam  nome do parâmetro de início (ex.: 'completed_start')
 * @param {string} endParam    nome do parâmetro de fim (ex.: 'completed_end')
 * @param {string} start       YYYY-MM-DD (inclusivo)
 * @param {string} end         YYYY-MM-DD (exclusivo recomendado: 1º dia do mês seguinte)
 */
async function fetchPostsByDateFilter(startParam, endParam, start, end, { pageSize = 1000, maxPages = 15, delayMs = 400 } = {}) {
  const all = [];
  const seen = new Set();
  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const qs = `limit=${pageSize}&offset=${offset}&${startParam}=${start}&${endParam}=${end}`;
    let data;
    try {
      data = await client.request(`/posts?${qs}`);
    } catch (e) {
      console.error(`[Posts ${startParam}=${start}..${end}] p${page + 1} falhou: ${e.message}`);
      if (e.message === 'RATE_LIMIT' && page > 0) break;
      if (page === 0) return all;
      break;
    }
    const items = Array.isArray(data) ? data : (data.data || []);
    if (!items.length) break;

    let added = 0;
    for (const p of items) {
      if (p && p.id != null && !seen.has(p.id)) { seen.add(p.id); all.push(p); added++; }
    }
    console.log(`[Posts ${startParam}=${start}..${end}] p${page + 1}: ${items.length} (novos: ${added}, total: ${all.length})`);

    if (items.length < pageSize) break;
    if (added === 0) break; // API ignorou offset e devolveu os mesmos itens
    if (page < maxPages - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  return all;
}

/** Posts/tarefas CRIADAS no intervalo (created_start/created_end, YYYY-MM-DD). */
function fetchPostsCreatedBetween(createdStart, createdEnd, opts) {
  return fetchPostsByDateFilter('created_start', 'created_end', createdStart, createdEnd, opts);
}

/**
 * Posts/tarefas CONCLUÍDAS no intervalo (completed_start/completed_end, YYYY-MM-DD).
 *
 * Usado pelo bloco Jurídico da Produtividade: a métrica é "tarefas concluídas no
 * mês", creditadas a quem concluiu (ver audit.js). Esse filtro é o que mais se
 * aproxima do volume real de atividades (≈334 em maio/2026 vs 164 do created),
 * porque mede o que a equipe ENTREGOU, não o que apenas entrou.
 */
function fetchPostsCompletedBetween(completedStart, completedEnd, opts) {
  return fetchPostsByDateFilter('completed_start', 'completed_end', completedStart, completedEnd, opts);
}

module.exports = { fetchLawsuits, fetchCustomers, fetchTransactions, fetchAllPosts, fetchPostsCreatedBetween, fetchPostsCompletedBetween, client };
