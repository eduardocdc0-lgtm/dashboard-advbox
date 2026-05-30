'use strict';

/**
 * Diagnóstico DEFINITIVO de atividades/tarefas do /posts.
 *
 * Contexto: o AdvBox (tela Atividades, filtro "Data do compromisso") mostra
 * ~470 atividades em maio/2026, mas a API /posts só devolveu 164 (filtrando por
 * created_at) — e só 294 no universo inteiro com limit=500. Este script testa,
 * com limit=1000 e PAGINAÇÃO REAL (offset + dedup), qual filtro de data da API
 * chega perto dos 470. Esse é o filtro que o dashboard deve usar.
 *
 * Pares de filtro (doc oficial api.softwareadvbox.com.br/docs/tasks/getPosts):
 *   date_start/date_end           = Data da tarefa  (≈ "Data do compromisso")
 *   created_start/created_end      = Data de criação
 *   deadline_start/deadline_end    = Prazo fatal
 *   completed_start/completed_end  = Data de conclusão
 *
 * NÃO imprime o token. Uso:  node scripts/diag-ativ.js [YYYY-MM]
 */

const client = require('../services/advbox-instance');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function recifeMonth() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 7);
}

/** Pagina /posts com os params dados (limit=1000, offset), dedup por id. */
async function buscar(extraQS, rotulo) {
  const seen = new Set();
  const datasCriacao = [];
  for (let page = 0; page < 10; page++) {
    const offset = page * 1000;
    const url = `/posts?limit=1000&offset=${offset}${extraQS ? '&' + extraQS : ''}`;
    let data;
    try {
      data = await client.request(url);
    } catch (e) {
      console.log(`  ${rotulo.padEnd(42)} ERRO: ${e.message}`);
      return { total: seen.size };
    }
    const arr = Array.isArray(data) ? data : (data.data || []);
    if (!arr.length) break;
    let novos = 0;
    for (const x of arr) {
      if (x && x.id != null && !seen.has(x.id)) {
        seen.add(x.id);
        datasCriacao.push(String(x.created_at || '').slice(0, 10));
        novos++;
      }
    }
    if (arr.length < 1000) break;   // última página
    if (novos === 0) break;          // offset ignorado
    await sleep(300);
  }
  datasCriacao.sort();
  return {
    total: seen.size,
    min: datasCriacao[0] || '-',
    max: datasCriacao[datasCriacao.length - 1] || '-',
  };
}

(async () => {
  const mes = process.argv[2] || recifeMonth();
  const ini = `${mes}-01`;
  const lastDay = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).getUTCDate();
  const fim = `${mes}-${String(lastDay).padStart(2, '0')}`;

  console.log(`\n========= DIAG ATIVIDADES — ${mes} (AdvBox UI mostra ~470) =========\n`);

  console.log('[A] /posts SEM filtro (universo total que a API devolve):');
  const semFiltro = await buscar('', 'sem filtro');
  console.log(`    -> ${semFiltro.total} itens distintos | criados de ${semFiltro.min} a ${semFiltro.max}\n`);

  console.log(`[B] Filtros de data, intervalo ${ini} .. ${fim} (limit=1000, paginado):`);
  const pares = [
    ['date_start',      'date_end',      'date_start/date_end (compromisso)'],
    ['created_start',   'created_end',   'created_start/created_end (criação)'],
    ['deadline_start',  'deadline_end',  'deadline_start/deadline_end (prazo)'],
    ['completed_start', 'completed_end', 'completed_start/completed_end (conclusão)'],
  ];
  const resultados = [];
  for (const [ps, pe, rot] of pares) {
    const r = await buscar(`${ps}=${ini}&${pe}=${fim}`, rot);
    console.log(`  ${rot.padEnd(42)} -> ${String(r.total).padStart(4)} itens | criados ${r.min} .. ${r.max}`);
    resultados.push({ rot, total: r.total });
    await sleep(300);
  }

  const vencedor = resultados.slice().sort((a, b) => b.total - a.total)[0];
  console.log(`\n========= CONCLUSÃO =========`);
  console.log(`Universo sem filtro:        ${semFiltro.total}`);
  console.log(`Filtro que devolve MAIS:    ${vencedor ? vencedor.rot + ' (' + vencedor.total + ')' : '-'}`);
  console.log(`Alvo (AdvBox UI, maio):     ~470`);
  if (vencedor && vencedor.total >= 400) {
    console.log('=> ESSE filtro chega perto dos 470. O dashboard deve usar ELE.');
  } else {
    console.log('=> NENHUM filtro chega perto de 470. A API /posts NÃO expõe todas as');
    console.log('   atividades da tela (provável teto/escopo do endpoint). Próximo passo:');
    console.log('   ver se a tela Atividades usa outro endpoint/token.');
  }
  console.log('');
})().catch(e => { console.error('\nFALHA GERAL:', e.message); process.exit(1); });
