'use strict';

/**
 * Diagnóstico do endpoint /posts do AdvBox.
 *
 * Responde 3 perguntas que explicam por que a "Atividade da equipe" pode estar
 * subcontando (ex: Letícia/Alice com poucas atividades):
 *   1. A API respeita o parâmetro `offset`? (em /transactions ela IGNORA)
 *   2. Qual janela de datas os posts mais recentes cobrem?
 *   3. A janela alcança o início do mês alvo, ou faltam atividades do começo?
 *
 * Também testa, como SONDA, alguns nomes de parâmetro de filtro por data, pra
 * ver se dá pra buscar um mês inteiro direto na API.
 *
 * NÃO imprime o token. Usa a instância configurada (token vem do env do Replit).
 *
 * Uso (no Shell do Replit, a partir da raiz do projeto):
 *   git pull && node scripts/diag-posts.js          # mês atual (Recife)
 *   node scripts/diag-posts.js 2026-05              # mês específico
 */

const client = require('../services/advbox-instance');

function recifeMonth() {
  const d = new Date(Date.now() - 3 * 3600 * 1000); // UTC-3
  return d.toISOString().slice(0, 7);
}

function fmtDate(x) {
  return String(x && x.created_at || '').slice(0, 10);
}

async function paginarPosts(mes) {
  const pageSize = 500;
  const maxPages = 40;
  const seen = new Set();
  const all = [];
  let offsetIgnorado = false;

  console.log(`Paginando /posts (limit=${pageSize}, até ${maxPages} páginas)...\n`);

  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    let data;
    try {
      data = await client.request(`/posts?limit=${pageSize}&offset=${offset}`);
    } catch (e) {
      console.error(`  p${page + 1} ERRO: ${e.message}`);
      break;
    }
    const arr = Array.isArray(data) ? data : (data.data || []);
    if (!arr.length) { console.log(`  p${page + 1}: vazio — fim da lista`); break; }

    let novos = 0;
    for (const x of arr) {
      if (x && x.id != null && !seen.has(x.id)) { seen.add(x.id); all.push(x); novos++; }
    }
    console.log(`  p${page + 1}: recebeu ${arr.length}, novos ${novos} (distintos acumulados: ${all.length})`);

    if (arr.length < pageSize) { console.log('     -> última página (recebeu < pageSize)'); break; }
    if (novos === 0) {
      offsetIgnorado = true;
      console.log('     -> OFFSET IGNORADO: 0 itens novos, a API devolveu os mesmos posts. Paginação por offset NÃO funciona em /posts.');
      break;
    }
    await new Promise(r => setTimeout(r, 400));
  }

  return { all, offsetIgnorado };
}

async function sondaFiltroData(mes) {
  // Testa se a API aceita algum filtro por data. Se aceitar, dá pra buscar o
  // mês inteiro sem depender de offset. Param desconhecido → provavelmente
  // ignorado (retorna a mesma lista que sem filtro).
  const ini = `${mes}-01`;
  const lastDay = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).getUTCDate();
  const fim = `${mes}-${String(lastDay).padStart(2, '0')}`;

  const candidatos = [
    `/posts?limit=500&start_date=${ini}&end_date=${fim}`,
    `/posts?limit=500&date_start=${ini}&date_end=${fim}`,
    `/posts?limit=500&from=${ini}&to=${fim}`,
    `/posts?limit=500&created_at_start=${ini}&created_at_end=${fim}`,
  ];

  console.log(`\n--- SONDA: filtro por data (${ini} → ${fim}) ---`);
  for (const url of candidatos) {
    try {
      const data = await client.request(url);
      const arr = Array.isArray(data) ? data : (data.data || []);
      const datas = arr.map(fmtDate).filter(Boolean).sort();
      const dentro = arr.filter(x => fmtDate(x).slice(0, 7) === mes).length;
      console.log(`  ${url.replace('/posts?limit=500&', '')}: ${arr.length} itens | ${datas[0] || '-'} → ${datas[datas.length - 1] || '-'} | no mês ${mes}: ${dentro}`);
    } catch (e) {
      console.log(`  ${url.replace('/posts?limit=500&', '')}: ERRO ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  console.log('  (se TODOS derem a mesma contagem/janela, o filtro foi ignorado)');
}

(async () => {
  const mes = process.argv[2] || recifeMonth();
  console.log(`\n================ DIAG /posts — mês alvo: ${mes} ================\n`);

  const { all, offsetIgnorado } = await paginarPosts(mes);

  const datas = all.map(fmtDate).filter(Boolean).sort();
  const maisAntigo = datas[0];
  const maisNovo = datas[datas.length - 1];

  const doMes = all.filter(x => fmtDate(x).slice(0, 7) === mes);
  const porPessoa = {};
  for (const x of doMes) {
    const u = (x.users || [])[0];
    if (!u || !u.name) continue;
    porPessoa[u.name] = (porPessoa[u.name] || 0) + 1;
  }
  const ranking = Object.entries(porPessoa).sort((a, b) => b[1] - a[1]);
  const cobreInicio = maisAntigo && maisAntigo <= `${mes}-01`;

  console.log(`\n================ RESUMO ================`);
  console.log(`Posts distintos coletados:     ${all.length}`);
  console.log(`API respeita offset:           ${offsetIgnorado ? 'NÃO (paginação quebrada — só dá pra ver os ~500 mais recentes)' : 'sim'}`);
  console.log(`Janela de datas coberta:       ${maisAntigo || '-'}  →  ${maisNovo || '-'}`);
  console.log(`Cobre o mês ${mes} inteiro?   ${cobreInicio ? 'SIM' : `NÃO — post mais antigo é ${maisAntigo}, depois do dia 01. Faltam atividades do começo do mês.`}`);
  console.log(`Posts dentro de ${mes}:        ${doMes.length}`);
  console.log(`\nPor pessoa (executor = users[0]) em ${mes}:`);
  if (!ranking.length) console.log('  (nenhum)');
  for (const [nome, n] of ranking) console.log(`  ${String(n).padStart(4)}  ${nome}`);

  await sondaFiltroData(mes);
  console.log('');
})().catch(e => { console.error('\nFALHA GERAL:', e.message); process.exit(1); });
