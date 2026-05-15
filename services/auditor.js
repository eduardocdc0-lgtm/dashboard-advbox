/**
 * Auditor de uso do AdvBox — porting do auditoria.py.
 *
 * Aplica regras de cadastro + workflow (SLA por etapa, gargalo, responsável errado,
 * produtividade de petições). Filtra por user_id quando solicitado.
 */

'use strict';

const r = require('./audit-rules');
const { fetchLawsuits, fetchCustomers, fetchTransactions, fetchAllPosts, client } = require('./data');

// ── HELPERS ──────────────────────────────────────────────────────────────────

const CPF_RE  = /\d{3}\.\d{3}\.\d{3}-\d{2}/;
const CNPJ_RE = /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/;
const INSTITUCIONAL_RE =
  /INSS|INSTITUTO NACIONAL|SEGURO SOCIAL|PREVIDENCIA|ESTADO|MUNICIPIO|UNIAO FEDERAL/;

function normStr(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function pickClientName(lawsuit) {
  const customers = Array.isArray(lawsuit.customers) ? lawsuit.customers : [];
  // 1) Com CPF (pessoa física)
  for (const c of customers) {
    if (!c || typeof c !== 'object') continue;
    if (c.identification && CPF_RE.test(c.identification) && c.name) return c.name;
  }
  // 2) Não-institucional
  for (const c of customers) {
    if (!c || !c.name) continue;
    const nomeUp = c.name.toUpperCase();
    if (INSTITUCIONAL_RE.test(nomeUp)) continue;
    if (c.identification && CNPJ_RE.test(c.identification)) continue;
    return c.name;
  }
  // 3) Qualquer
  for (const c of customers) {
    if (c && c.name) return c.name;
  }
  return null;
}

function ehPeticao(task) {
  if (!task) return false;
  const t = normStr(task);
  if (r.PREFIXOS_NAO_PETICAO.some(ex => t.startsWith(ex))) return false;
  return r.PREFIXOS_PETICAO.some(kw => t.startsWith(kw));
}

function parseData(s) {
  if (!s) return null;
  // ISO: 2025-04-09 11:36:43 ou 2025-04-09T11:36:43
  const m1 = /^(\d{4})-(\d{2})-(\d{2})[ T]?(\d{2})?:?(\d{2})?:?(\d{2})?/.exec(s);
  if (m1) {
    return new Date(
      Number(m1[1]), Number(m1[2]) - 1, Number(m1[3]),
      Number(m1[4] || 0), Number(m1[5] || 0), Number(m1[6] || 0),
    );
  }
  // BR: 09/04/2025
  const m2 = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (m2) return new Date(Number(m2[3]), Number(m2[2]) - 1, Number(m2[1]));
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function userIdDaTarefa(t) {
  const users = t.users || [];
  if (!Array.isArray(users) || users.length === 0) return null;
  const u = users[0];
  return (u && typeof u === 'object') ? (u.user_id || u.id || null) : null;
}

function zonaDoUsuario(nome) {
  const n = normStr(nome);
  if (!n) return null;
  if (n.includes('LETICIA') || n.includes('ALICE')) return 'LETICIA_OU_ALICE';
  if (n.includes('MARILIA')) return 'MARILIA';
  if (n.includes('CAU') || n.includes('CLAUDIANA')) return 'CAU';
  if (n.includes('TAMMYRES')) return 'TAMMYRES';
  if (n.includes('EDUARDO')) return 'EDUARDO';
  return null;
}

function isAtivo(lawsuit) {
  // ATENÇÃO: status_closure da API NÃO indica encerramento (fica preenchido
  // em muitos processos ativos). Filtramos só pela FASE.
  const stage = (lawsuit.stage || '').toUpperCase();
  if (!stage) return true;
  return !r.FASES_INATIVAS.has(stage);
}

function campoVazio(obj, campo) {
  const v = obj[campo];
  if (v == null) return true;
  if (typeof v === 'string') return v.length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

// ── AUDITORIAS DE CADASTRO ───────────────────────────────────────────────────

function auditarClientes(clientes, mapaClienteParaUser) {
  const problemas = [];
  for (const c of clientes) {
    const userId = mapaClienteParaUser.get(c.id) || null;
    const idLabel = c.id;
    const nome = c.name || '?';

    for (const campo of r.CAMPOS_OBRIGATORIOS_CLIENTE) {
      if (campoVazio(c, campo)) {
        problemas.push({
          tipo: 'cliente', nivel: 'erro', user_id: userId,
          id: idLabel, campo, descricao: `Cliente '${nome}' sem ${campo}`,
        });
      }
    }
    for (const campo of r.CAMPOS_RECOMENDADOS_CLIENTE) {
      if (campoVazio(c, campo)) {
        problemas.push({
          tipo: 'cliente', nivel: 'aviso', user_id: userId,
          id: idLabel, campo, descricao: `Cliente '${nome}' poderia ter ${campo} preenchido`,
        });
      }
    }
  }
  return problemas;
}

function auditarProcessos(processos) {
  const problemas = [];
  const agora = Date.now();
  const limite = agora - r.DIAS_PROCESSO_SEM_MOVIMENTACAO * 86400000;

  for (const p of processos) {
    const userId = p.responsible_id || null;
    const pid = p.id;
    const clienteNome = pickClientName(p);
    const procLabel = p.process_number || (clienteNome ? `de ${clienteNome}` : `#${pid}`);

    for (const campo of r.CAMPOS_OBRIGATORIOS_PROCESSO) {
      if (campoVazio(p, campo)) {
        problemas.push({
          tipo: 'processo', nivel: 'erro', user_id: userId,
          id: pid, campo, descricao: `Processo ${procLabel} sem ${campo}`,
        });
      }
    }
    const ultima = parseData(p.last_movement_date) || parseData(p.updated_at);
    if (ultima && ultima.getTime() < limite) {
      const dias = Math.floor((agora - ultima.getTime()) / 86400000);
      problemas.push({
        tipo: 'processo', nivel: 'aviso', user_id: userId,
        id: pid, campo: 'movimentacao',
        descricao: `Processo ${procLabel} sem movimentação há ${dias} dias`,
      });
    }
  }
  return problemas;
}

function auditarTarefas(tarefas) {
  const problemas = [];
  for (const t of tarefas) {
    const userId = userIdDaTarefa(t);
    const tid = t.id;

    for (const campo of r.CAMPOS_OBRIGATORIOS_TAREFA) {
      if (campoVazio(t, campo)) {
        problemas.push({
          tipo: 'tarefa', nivel: 'erro', user_id: userId,
          id: tid, campo, descricao: `Tarefa #${tid} sem ${campo}`,
        });
      }
    }

    if (r.EXIGE_DESCRICAO_TAREFA) {
      const texto = String(t.notes || t.description || t.text || t.content || '').trim();
      if (texto.length < r.TAMANHO_MINIMO_DESCRICAO_TAREFA) {
        problemas.push({
          tipo: 'tarefa', nivel: 'aviso', user_id: userId,
          id: tid, campo: 'descricao',
          descricao: `Tarefa #${tid} com descrição muito curta ('${texto.slice(0, 30)}')`,
        });
      }
    }
  }
  return problemas;
}

// ── AUDITORIAS DE WORKFLOW ───────────────────────────────────────────────────

function audTarefasVencidas(tarefas) {
  const problemas = [];
  const agora = Date.now();
  for (const t of tarefas) {
    const prazo = parseData(t.date_deadline);
    if (!prazo || prazo.getTime() >= agora) continue;
    const users = t.users || [];
    const completed = Array.isArray(users) && users[0] ? !!users[0].completed : false;
    if (completed) continue;

    // Se a tarefa tem DATA DO EVENTO futura (ex: perícia agendada pra próxima semana),
    // não é vencida — só vai ser concluída depois do evento. date_deadline aqui é
    // só lembrete interno antes do evento.
    const dataEvento = parseData(t.date);
    if (dataEvento && dataEvento.getTime() >= agora) continue;
    const dias = Math.floor((agora - prazo.getTime()) / 86400000);
    problemas.push({
      tipo: 'workflow', nivel: 'erro',
      user_id: userIdDaTarefa(t),
      id: t.id, campo: 'prazo_vencido',
      lawsuit_id: t.lawsuits_id || null,
      descricao: `Tarefa #${t.id} '${t.task || '(sem nome)'}' venceu há ${dias} dia(s)`,
    });
  }
  return problemas;
}

function audGargaloPorEtapa(processos, tarefas) {
  const problemas = [];
  const agora = Date.now();

  const ultimaTarefaPorProc = new Map();
  for (const t of tarefas) {
    const lid = t.lawsuits_id;
    if (!lid) continue;
    const criada = parseData(t.created_at);
    if (!criada) continue;
    const atual = ultimaTarefaPorProc.get(lid);
    if (!atual || criada.getTime() > atual.getTime()) ultimaTarefaPorProc.set(lid, criada);
  }

  for (const p of processos) {
    const pid = p.id;
    if (!pid) continue;
    const stage = normStr(p.stage);
    const slaDias = r.SLA_POR_FASE[stage];
    if (!slaDias) continue;

    const ref = ultimaTarefaPorProc.get(pid) || parseData(p.created_at);
    if (!ref) continue;
    const diasParado = Math.floor((agora - ref.getTime()) / 86400000);
    if (diasParado <= slaDias) continue;

    const nome = pickClientName(p) || `#${pid}`;
    const procLabel = p.process_number || `de ${nome}`;
    const nivel = diasParado >= slaDias * 2 ? 'erro' : 'aviso';

    problemas.push({
      tipo: 'workflow', nivel,
      user_id: p.responsible_id || null,
      id: pid, campo: 'gargalo_etapa',
      lawsuit_id: pid,
      descricao: `${procLabel} parado em '${p.stage}' há ${diasParado} dia(s) (SLA: ${slaDias})`,
    });
  }
  return problemas;
}

function audResponsavelErrado(processos) {
  const problemas = [];
  for (const p of processos) {
    const stage = normStr(p.stage);
    if (!stage || r.FASES_IGNORADAS_RESPONSAVEL.has(stage)) continue;

    let zonaCerta = r.RESPONSAVEL_POR_FASE[stage] || null;
    const zonasMulti = r.RESPONSAVEL_POR_FASE_MULTI[stage] || null;
    if (!zonaCerta && !zonasMulti) continue;

    const responsavelAtual = normStr(p.responsible);
    if (!responsavelAtual) continue;

    // Eduardo (dono/admin) supervisiona qualquer fase — nunca é erro.
    if (responsavelAtual.includes('EDUARDO')) continue;

    // Pra cada zona esperada, busca SUAS keywords (ex: zona LETICIA_OU_ALICE
    // aceita "LETICIA" ou "ALICE" no nome real do AdvBox).
    const zonasEsperadas = zonasMulti || [zonaCerta];
    const keywordsAceitas = zonasEsperadas.flatMap(z => r.ZONA_KEYWORDS[z] || [z]);
    if (keywordsAceitas.some(k => responsavelAtual.includes(k))) continue;

    const pid = p.id;
    const nome = pickClientName(p) || `#${pid}`;
    const procLabel = p.process_number || `de ${nome}`;
    const zonaLabel = zonasMulti ? zonasMulti.join(' ou ') : zonaCerta;

    problemas.push({
      tipo: 'workflow', nivel: 'erro',
      user_id: p.responsible_id || null,
      id: pid, campo: 'responsavel_errado',
      lawsuit_id: pid,
      descricao: `Processo ${procLabel} em '${p.stage}' deveria ser de ${zonaLabel}, está com ${p.responsible}`,
    });
  }
  return problemas;
}

function audProdutividadePeticoes(tarefas, usuarios) {
  const problemas = [];
  const semanaAtras = Date.now() - 7 * 86400000;

  const peticoesPorUser = new Map();
  for (const t of tarefas) {
    const criada = parseData(t.created_at);
    if (!criada || criada.getTime() < semanaAtras) continue;
    if (!ehPeticao(t.task)) continue;
    const uid = userIdDaTarefa(t);
    if (!uid) continue;
    peticoesPorUser.set(uid, (peticoesPorUser.get(uid) || 0) + 1);
  }

  for (const u of usuarios) {
    const uid = u.id;
    if (!uid) continue;
    const zona = zonaDoUsuario(u.name || '');
    if (!r.ZONAS_QUE_PETICIONAM.has(zona)) continue;
    const count = peticoesPorUser.get(uid) || 0;
    if (count >= r.META_PETICOES_SEMANA) continue;
    problemas.push({
      tipo: 'workflow', nivel: 'aviso',
      user_id: uid, id: uid, campo: 'produtividade_baixa',
      descricao: `${u.name || 'Usuário #' + uid} fez apenas ${count} petição(ões) nos últimos 7 dias (meta: ${r.META_PETICOES_SEMANA})`,
    });
  }
  return problemas;
}

function auditarWorkflow(processos, tarefas, usuarios) {
  return [
    ...audTarefasVencidas(tarefas),
    ...audGargaloPorEtapa(processos, tarefas),
    ...audResponsavelErrado(processos),
    ...audProdutividadePeticoes(tarefas, usuarios),
  ];
}

// ── ORQUESTRADOR ─────────────────────────────────────────────────────────────

/**
 * Roda auditoria completa. Retorna { resumo, problemas, porUsuario }.
 * Caches via services/data.js (cache embutido).
 */
async function runAudit({ force = false } = {}) {
  const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout ${label} (${ms}ms)`)), ms)),
  ]);

  const [settings, clientesRaw, lawsuitsRaw, posts] = await Promise.all([
    withTimeout(client.getSettings(),         10_000, 'getSettings'),
    withTimeout(fetchCustomers(force),        15_000, 'fetchCustomers'),
    withTimeout(fetchLawsuits(force),         15_000, 'fetchLawsuits'),
    withTimeout(fetchAllPosts(500,4,600,force), 30_000, 'fetchAllPosts'),
  ]);

  const usuarios = (settings && settings.users) || [];
  const lawsuitsAll = Array.isArray(lawsuitsRaw) ? lawsuitsRaw : (lawsuitsRaw?.data || []);
  const processos = lawsuitsAll.filter(isAtivo);
  const clientes = Array.isArray(clientesRaw) ? clientesRaw : (clientesRaw?.data || []);

  // Mapa cliente → responsável (inferido por processo)
  const mapaClienteParaUser = new Map();
  for (const p of processos) {
    if (!p.responsible_id) continue;
    for (const c of (p.customers || [])) {
      const cid = c?.customer_id;
      if (cid && !mapaClienteParaUser.has(cid)) mapaClienteParaUser.set(cid, p.responsible_id);
    }
  }

  let problemas = [
    ...auditarClientes(clientes, mapaClienteParaUser),
    ...auditarProcessos(processos),
    ...auditarTarefas(posts),
    ...auditarWorkflow(processos, posts, usuarios),
  ];

  // Filtra problemas marcados como "Tratei" (botão de ignore com 30d).
  // Self-healing: passados 30d, ignore expira e o problema volta a aparecer.
  try {
    const { query } = require('./db');
    const r = await query(`
      SELECT problema_tipo, problema_id FROM audit_ignored
      WHERE ignored_until > NOW()
    `);
    if (r.rows.length) {
      const ignoreSet = new Set(r.rows.map(x => `${x.problema_tipo}:${x.problema_id}`));
      problemas = problemas.filter(p => !ignoreSet.has(`${p.tipo}:${p.id}`));
    }
  } catch (e) {
    // Se tabela não existe ainda (primeira execução), só ignora silenciosamente.
    if (!/relation .* does not exist/i.test(e.message)) {
      console.error('[auditor] erro ao filtrar ignored:', e.message);
    }
  }

  // Consolida por usuário (igual ao Python)
  const nomePorId = {};
  for (const u of usuarios) {
    if (u.id) nomePorId[u.id] = u.name || `Usuário #${u.id}`;
  }

  const totalPorUser = {};
  for (const c of clientes) {
    const uid = mapaClienteParaUser.get(c.id);
    if (uid) totalPorUser[uid] = (totalPorUser[uid] || 0) + 1;
  }
  for (const p of processos) {
    const uid = p.responsible_id;
    if (uid) totalPorUser[uid] = (totalPorUser[uid] || 0) + 1;
  }
  for (const t of posts) {
    const uid = userIdDaTarefa(t);
    if (uid) totalPorUser[uid] = (totalPorUser[uid] || 0) + 1;
  }

  const problemasPorUser = {};
  const registrosComProblema = {};
  for (const p of problemas) {
    const uid = p.user_id;
    if (!uid) continue;
    (problemasPorUser[uid] = problemasPorUser[uid] || []).push(p);
    const key = `${p.tipo}:${p.id}`;
    (registrosComProblema[uid] = registrosComProblema[uid] || new Set()).add(key);
  }

  const porUsuario = [];
  const allUids = new Set([...Object.keys(totalPorUser), ...Object.keys(problemasPorUser)]);
  for (const uidStr of allUids) {
    const uid = Number(uidStr);
    const total = totalPorUser[uid] || 0;
    const comProblema = (registrosComProblema[uid]?.size) || 0;
    const ok = Math.max(0, total - comProblema);
    const percentual = total > 0 ? (ok / total) * 100 : 100;
    porUsuario.push({
      user_id: uid,
      nome: nomePorId[uid] || `Usuário #${uid}`,
      total_registros: total,
      registros_ok: ok,
      percentual,
      problemas: problemasPorUser[uid] || [],
    });
  }

  return {
    resumo: {
      total_clientes:  clientes.length,
      total_processos: processos.length,
      total_tarefas:   posts.length,
      total_problemas: problemas.length,
    },
    problemas,
    porUsuario,
    geradoEm: new Date().toISOString(),
  };
}

module.exports = {
  runAudit,
  // helpers exportados pra testes
  normStr,
  pickClientName,
  ehPeticao,
  zonaDoUsuario,
};
