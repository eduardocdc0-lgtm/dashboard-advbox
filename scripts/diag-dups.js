'use strict';

/**
 * Diagnóstico de DUPLICATAS em /posts (Produtividade > Jurídico).
 *
 * Hipótese do Eduardo (quem conhece a operação): a contagem do Jurídico está
 * INFLADA. Tarefas COMPARTILHADAS (ex.: Letícia + Alice, ou Marília + uma das
 * duas) viram um registro SEPARADO por pessoa. Quando uma conclui, "aparece pra
 * outra concluindo também" -> a MESMA tarefa lógica conta 2x (uma pra cada).
 *
 * O bloco Jurídico (audit.js) atribui por users[0] (1º responsável) e soma 1 por
 * registro. Se a API devolve 2 registros (um com users[0]=Letícia, outro com
 * users[0]=Alice) pra mesma tarefa, ambas ganham +1 -> dobra.
 *
 * Este script NÃO altera nada. Ele:
 *   [A] baixa os posts CRIADOS no mês (mesmo recorte do bloco Jurídico),
 *   [B] sonda a estrutura do registro p/ achar um ID que ligue as cópias
 *       (task_id, schedule_id, group_id, etc.),
 *   [C] agrupa por chaves candidatas e mede quantos registros são "excesso",
 *   [D] mostra contagem por pessoa ANTES x DEPOIS do dedup,
 *   [E] imprime EXEMPLOS concretos (processo + tarefa + as pessoas envolvidas)
 *       pro Eduardo confirmar se é dup de verdade.
 *
 * NÃO imprime o token. Uso (Shell do Replit, na raiz):
 *   git pull origin main --no-edit && node scripts/diag-dups.js [YYYY-MM]
 */

const client = require('../services/advbox-instance');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function recifeMonth() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 7);
}

function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // tira acento (marcas combinantes)
    .trim().toUpperCase().replace(/\s+/g, ' ');
}

/** Nome do executor = primeiro responsável (mesma regra do dashboard). */
function executor(p) {
  const u = (p.users || [])[0];
  return u && u.name ? u.name : '(sem responsável)';
}

/** Todos os responsáveis de um post: [{ name, completed }]. */
function usuariosDe(p) {
  return (p.users || [])
    .filter(u => u && u.name)
    .map(u => ({ name: u.name, completed: !!u.completed }));
}

/** Pagina /posts com QUALQUER query extra (limit=1000, offset), dedup por id. */
async function paginar(extraQS) {
  const all = [];
  const seen = new Set();
  for (let page = 0; page < 15; page++) {
    const offset = page * 1000;
    const url = `/posts?limit=1000&offset=${offset}${extraQS ? '&' + extraQS : ''}`;
    let data;
    try {
      data = await client.request(url);
    } catch (e) {
      console.error(`  página ${page + 1} falhou: ${e.message}`);
      if (page === 0) return all;
      break;
    }
    const arr = Array.isArray(data) ? data : (data.data || []);
    if (!arr.length) break;
    let novos = 0;
    for (const p of arr) {
      if (p && p.id != null && !seen.has(p.id)) { seen.add(p.id); all.push(p); novos++; }
    }
    console.log(`  página ${page + 1}: ${arr.length} (novos ${novos}, total ${all.length})`);
    if (arr.length < 1000) break;
    if (novos === 0) break;
    await sleep(350);
  }
  return all;
}

/** Atalho: posts criados no intervalo [ini, fim). */
function baixarMes(ini, fim) {
  return paginar(`created_start=${ini}&created_end=${fim}`);
}

/** Conta registros por pessoa (executor = users[0] — jeito do dashboard). */
function porPessoa(lista) {
  const m = {};
  for (const p of lista) {
    const nome = executor(p);
    m[nome] = (m[nome] || 0) + 1;
  }
  return m;
}

/** Conta dando +1 a CADA responsável do post (jeito "por designado", AdvBox). */
function porAssignee(lista) {
  const m = {};
  for (const p of lista) {
    for (const u of usuariosDe(p)) m[u.name] = (m[u.name] || 0) + 1;
  }
  return m;
}

function imprimeRanking(titulo, mapa) {
  console.log(titulo);
  const r = Object.entries(mapa).sort((a, b) => b[1] - a[1]);
  if (!r.length) { console.log('   (vazio)'); return; }
  for (const [nome, n] of r) console.log(`   ${String(n).padStart(4)}  ${nome}`);
}

(async () => {
  const mes = process.argv[2] || recifeMonth();
  const ini = `${mes}-01`;
  const yyyy = Number(mes.slice(0, 4));
  const mm = Number(mes.slice(5, 7));
  // fim exclusivo = 1º dia do mês seguinte (mesmo critério do audit.js)
  const fim = `${mm === 12 ? yyyy + 1 : yyyy}-${String(mm === 12 ? 1 : mm + 1).padStart(2, '0')}-01`;

  console.log(`\n================ DIAG DUPLICATAS — ${mes} ================`);
  console.log(`Recorte: created_start=${ini} .. created_end=${fim} (mesmo do bloco Jurídico)\n`);

  const posts = await baixarMes(ini, fim);
  console.log(`\nTotal de posts (distintos por id) no recorte: ${posts.length}\n`);
  if (!posts.length) { console.log('Nada a analisar.'); return; }

  // ── [B] Estrutura: que campos existem? Tem algum ID que ligue as cópias? ──
  console.log('================ [B] ESTRUTURA DO REGISTRO ================');
  const chaves = new Set();
  for (const p of posts) for (const k of Object.keys(p)) chaves.add(k);
  console.log('Campos presentes:', [...chaves].sort().join(', '));

  // Mostra 1 registro de exemplo (sem dados sensíveis — posts não têm token).
  console.log('\nExemplo de 1 registro (campos crus):');
  console.log(JSON.stringify(posts[0], null, 2).slice(0, 1500));

  // Procura campos *_id que possam agrupar cópias da mesma tarefa.
  const idLike = [...chaves].filter(k => /(_id|^id$|id$)/i.test(k));
  console.log('\nCampos com cara de ID:', idLike.join(', '));
  for (const campo of idLike) {
    if (campo === 'id') continue; // id é único por registro, não agrupa
    const vals = posts.map(p => p[campo]).filter(v => v != null);
    if (!vals.length) continue;
    const distintos = new Set(vals.map(String));
    // Quantos registros COMPARTILHAM o mesmo valor com outro registro?
    const cont = {};
    for (const v of vals) cont[String(v)] = (cont[String(v)] || 0) + 1;
    const compartilhados = Object.values(cont).filter(n => n > 1).reduce((a, n) => a + n, 0);
    console.log(`   ${campo.padEnd(16)} preenchido em ${vals.length}/${posts.length} | distintos ${distintos.size} | em grupos repetidos: ${compartilhados} registros`);
  }

  // ── [C] Agrupamento por chaves candidatas ──
  console.log('\n================ [C] AGRUPAMENTO (mede excesso) ================');

  function analisaChave(nomeChave, keyFn) {
    const grupos = new Map();
    for (const p of posts) {
      const k = keyFn(p);
      if (k == null) continue;
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(p);
    }
    let gruposDup = 0;        // grupos com >1 registro
    let excesso = 0;          // registros a mais (total - 1 por grupo)
    let excessoCrossUser = 0; // excesso onde os registros têm executores DIFERENTES
    for (const arr of grupos.values()) {
      if (arr.length > 1) {
        gruposDup++;
        excesso += arr.length - 1;
        const execs = new Set(arr.map(executor));
        if (execs.size > 1) excessoCrossUser += arr.length - 1;
      }
    }
    console.log(`\n  Chave: ${nomeChave}`);
    console.log(`     grupos com duplicata: ${gruposDup}`);
    console.log(`     registros em excesso (total): ${excesso}`);
    console.log(`     excesso entre PESSOAS diferentes (o que infla o ranking): ${excessoCrossUser}`);
    return grupos;
  }

  // C1: por task_id, se existir (cópia da mesma tarefa-modelo)
  const temTaskId = posts.some(p => p.task_id != null);
  if (temTaskId) {
    analisaChave('task_id (id da tarefa-modelo)', p => (p.task_id != null ? `T${p.task_id}` : null));
  } else {
    console.log('\n  (sem campo task_id — pulando essa chave)');
  }

  // C2: composto = processo + tipo de tarefa + dia (created_at)
  const gComposto = analisaChave(
    'processo + tarefa + dia (created_at)',
    p => `${p.lawsuits_id || p.lawsuit_id || '?'}|${norm(p.task)}|${String(p.created_at || '').slice(0, 10)}`
  );

  // C3: composto usando date (data do compromisso) no lugar de created_at
  analisaChave(
    'processo + tarefa + dia (date/compromisso)',
    p => `${p.lawsuits_id || p.lawsuit_id || '?'}|${norm(p.task)}|${String(p.date || p.date_deadline || '').slice(0, 10)}`
  );

  // ── [D] Por pessoa: ANTES x DEPOIS do dedup (chave composta C2) ──
  console.log('\n================ [D] POR PESSOA: ANTES x DEPOIS ================');
  const antes = porPessoa(posts);

  // Dedup: 1 registro por grupo composto. Mantém o "canônico" = users[0]
  // do registro de menor id (estável). Os demais do grupo são descartados.
  const canonicos = [];
  for (const arr of gComposto.values()) {
    arr.sort((a, b) => (a.id || 0) - (b.id || 0));
    canonicos.push(arr[0]);
  }
  const depois = porPessoa(canonicos);

  imprimeRanking(`ANTES do dedup (${posts.length} registros):`, antes);
  imprimeRanking(`\nDEPOIS do dedup (${canonicos.length} registros):`, depois);

  console.log('\nDelta por pessoa (quanto cada uma cai com o dedup):');
  const nomes = new Set([...Object.keys(antes), ...Object.keys(depois)]);
  const deltas = [...nomes]
    .map(n => ({ n, d: (antes[n] || 0) - (depois[n] || 0) }))
    .filter(x => x.d !== 0)
    .sort((a, b) => b.d - a.d);
  if (!deltas.length) console.log('   (ninguém perdeu nada — então NÃO há dup por essa chave)');
  for (const { n, d } of deltas) console.log(`   -${String(d).padStart(3)}  ${n}`);

  // ── [E] Exemplos concretos de grupos com pessoas diferentes ──
  console.log('\n================ [E] EXEMPLOS (cross-user) ================');
  console.log('Grupos "mesmo processo + mesma tarefa + mesmo dia" com 2+ PESSOAS diferentes:\n');
  let mostrados = 0;
  for (const arr of gComposto.values()) {
    if (arr.length < 2) continue;
    const execs = new Set(arr.map(executor));
    if (execs.size < 2) continue; // queremos os cross-user (Letícia x Alice etc.)
    const p0 = arr[0];
    const proc = (p0.lawsuit && p0.lawsuit.name) || p0.lawsuits_id || p0.lawsuit_id || '?';
    console.log(`• Processo: ${proc}`);
    console.log(`  Tarefa:   ${p0.task || '(sem tipo)'}  | dia ${String(p0.created_at || '').slice(0, 10)}`);
    for (const p of arr) {
      console.log(`     id=${p.id}  resp=${executor(p)}  concluída=${!!((p.users || [])[0] || {}).completed}`);
    }
    console.log('');
    if (++mostrados >= 20) { console.log('  ... (mais grupos omitidos)'); break; }
  }
  if (!mostrados) console.log('  (nenhum grupo cross-user encontrado por essa chave)');

  // ── [F] Tarefas COMPARTILHADAS (1 registro com 2+ responsáveis) ──
  // É AQUI que mora o "quando uma conclui, aparece pra outra concluindo tb":
  // um único post com users=[Letícia, Alice]. O dashboard conta só users[0],
  // mas a tela de Atividades do AdvBox conta pra CADA designado (infla x2).
  console.log('\n================ [F] TAREFAS COMPARTILHADAS (users[] >= 2) ================');
  const distrib = {};            // quantos responsáveis -> nº de posts
  const pares = {};              // "A + B" -> nº de posts
  const paresAmbosConcluiram = {}; // "A + B" -> posts onde 2+ marcaram concluído
  let compartilhados = 0, comDoisConcluidos = 0;
  for (const p of posts) {
    const us = usuariosDe(p);
    distrib[us.length] = (distrib[us.length] || 0) + 1;
    if (us.length >= 2) {
      compartilhados++;
      const chave = us.map(u => u.name).sort().join(' + ');
      pares[chave] = (pares[chave] || 0) + 1;
      const nConcl = us.filter(u => u.completed).length;
      if (nConcl >= 2) {
        comDoisConcluidos++;
        paresAmbosConcluiram[chave] = (paresAmbosConcluiram[chave] || 0) + 1;
      }
    }
  }
  console.log('Distribuição de responsáveis por post:');
  for (const [n, q] of Object.entries(distrib).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`   ${q} posts com ${n} responsável(is)`);
  }
  console.log(`\nPosts compartilhados (2+ responsáveis): ${compartilhados}`);
  console.log(`  destes, com 2+ pessoas marcadas como CONCLUÍDO: ${comDoisConcluidos}`);
  if (compartilhados) {
    console.log('\nPares de responsáveis que mais dividem tarefa:');
    for (const [par, n] of Object.entries(pares).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      const amb = paresAmbosConcluiram[par] || 0;
      console.log(`   ${String(n).padStart(3)}x  ${par}${amb ? `   (ambos concluíram em ${amb})` : ''}`);
    }
  } else {
    console.log('=> NENHUM post tem 2+ responsáveis. Tarefa "compartilhada" no AdvBox vira');
    console.log('   registros separados (1 por pessoa), não um registro com vários users.');
  }

  // ── [G] Dashboard (users[0]) x "por designado" (todos os users) ──
  // Mostra QUANTO cada pessoa inflaria se contássemos cada designado. Se o
  // dashboard batesse com a tela do AdvBox, seria por contar "por designado".
  console.log('\n================ [G] users[0] x por-designado ================');
  function comparaContagem(rotulo, lista) {
    const d = porPessoa(lista);     // dashboard
    const a = porAssignee(lista);   // por designado
    const nomes = new Set([...Object.keys(d), ...Object.keys(a)]);
    console.log(`\n  ${rotulo} (${lista.length} registros):`);
    console.log('     pessoa                         users[0]   por-designado   +infla');
    for (const nome of [...nomes].sort((x, y) => (a[y] || 0) - (a[x] || 0))) {
      const du = d[nome] || 0, ad = a[nome] || 0;
      console.log(`     ${nome.padEnd(30)} ${String(du).padStart(6)}   ${String(ad).padStart(11)}   ${String(ad - du).padStart(5)}`);
    }
  }
  comparaContagem('CRIADAS no mês (recorte atual do dashboard)', posts);

  // Slice de CONCLUÍDAS no mês — onde o "quando conclui" realmente acontece.
  console.log('\n  Baixando CONCLUÍDAS no mês (completed_start/completed_end)...');
  const concluidas = await paginar(`completed_start=${ini}&completed_end=${fim}`);
  comparaContagem('CONCLUÍDAS no mês', concluidas);

  // ── [H] PRÉVIA do painel NOVO: concluídas, creditadas a QUEM concluiu ──────
  // Replica exatamente a lógica do audit.js. Se "ambíguos" (2+ marcaram
  // concluído) for alto, a regra "quem concluiu" cai pro 1º responsável e a
  // Alice volta a ser sub-contada — sinal de que o flag completed é setado em
  // TODOS os designados, não só em quem fechou.
  console.log('\n================ [H] PRÉVIA DO PAINEL NOVO (concluídas / quem concluiu) ================');
  const isDone = (u) => u && u.completed != null && u.completed !== false && u.completed !== 0;
  const previa = {};
  let multiDone = 0, semDone = 0;
  for (const p of concluidas) {
    const us = (p.users || []).filter(u => u && u.name);
    if (!us.length) continue;
    const done = us.filter(isDone);
    if (done.length >= 2) multiDone++;
    if (done.length === 0) semDone++;
    const dono = done[0] || us[0];
    previa[dono.name] = (previa[dono.name] || 0) + 1;
  }
  imprimeRanking(`Concluídas creditadas a quem concluiu (${concluidas.length} tarefas — é ISSO que o painel vai mostrar):`, previa);
  console.log(`\n  Registros c/ 2+ pessoas marcadas concluído (ambíguos → vão pro 1º resp.): ${multiDone}`);
  console.log(`  Registros s/ ninguém marcado concluído (fallback p/ 1º resp.):           ${semDone}`);
  console.log('  Se "ambíguos" for ALTO e a Alice continuar baixa aqui, o flag é por-tarefa');
  console.log('  (não por-pessoa) e a regra precisa mudar (ex.: creditar todos os que fecharam).');

  console.log('\n================ CONCLUSÃO ================');
  console.log(`Posts CRIADOS no mês:           ${posts.length}`);
  console.log(`Após dedup processo+tarefa+dia: ${canonicos.length}  (excesso ${posts.length - canonicos.length})`);
  console.log(`Posts compartilhados (2+ resp): ${compartilhados}`);
  console.log(`Posts CONCLUÍDOS no mês:        ${concluidas.length}`);
  console.log('');
  console.log('Leitura: se [F] mostra muitos pares Letícia+Alice e [G] tem "+infla" alto,');
  console.log('o x2 vem de contar POR DESIGNADO — e o fix é garantir users[0] (já é o caso)');
  console.log('OU contar a tarefa 1x mesmo no slice de concluídas. Se [F]=0 e [G] +infla=0,');
  console.log('não há dup nesse recorte e o número do dashboard já está correto.');
  console.log('');
})().catch(e => { console.error('\nFALHA GERAL:', e.message); process.exit(1); });
