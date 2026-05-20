/**
 * Régua de cobrança escalonada — D+1 / D+7 / D+15 / D+30.
 *
 * Filosofia: a Cau não precisa decidir quem cobrar e quando. A régua faz isso.
 * Ela só executa a ligação quando o sistema marca como tarefa, e revê o caso
 * quando escala.
 *
 * Etapas (calculadas sobre diasAtraso = hoje - data_due_mais_antiga):
 *
 *   D+1  (1–6 dias): WhatsApp "soft" — mensagem amigável via ChatGuru
 *                    (lembrete educado, sem pressão).
 *   D+7  (7–14 dias): WhatsApp "firme" — segundo toque, menciona acordo.
 *   D+15 (15–29 dias): Cria tarefa "LIGAR PARA CLIENTE INADIMPLENTE" pra Cau.
 *   D+30 (≥30 dias): Cria tarefa "ESCALAR INADIMPLÊNCIA" pra Eduardo + WhatsApp final.
 *
 * Cooldown por (cliente, etapa, channel) — não repete a mesma etapa.
 * Self-healing: cliente paga → não aparece mais (filtro em getInadimplentes
 * descarta date_payment != null).
 *
 * Configurável:
 *   REGUA_COBRANCA_ENABLED  (default true)
 *   REGUA_COBRANCA_DRY      (default false — se true, só loga, não envia/cria)
 */

'use strict';

const { query } = require('./db');
const { getInadimplentes } = require('./inadimplentes');
const { sendWhatsApp } = require('./chatguru-sender');
const fetch = require('node-fetch');

const ADVBOX_BASE = 'https://app.advbox.com.br/api/v1';
const ADVBOX_UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const USERS = { EDUARDO: 198347, CAU: 236523 };

const DRY_RUN = process.env.REGUA_COBRANCA_DRY === 'true';

// ── Migration ────────────────────────────────────────────────────────────────

async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS cobranca_regua_log (
      id          SERIAL PRIMARY KEY,
      cliente_key VARCHAR(255) NOT NULL,
      cliente     VARCHAR(500),
      etapa       VARCHAR(20) NOT NULL,
      channel     VARCHAR(20) NOT NULL,
      dias_atraso INT,
      valor_total NUMERIC(12,2),
      lawsuit_id  BIGINT,
      payload     JSONB,
      success     BOOLEAN NOT NULL DEFAULT TRUE,
      error_message TEXT,
      sent_at     TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_crl_sent_at ON cobranca_regua_log(sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crl_key     ON cobranca_regua_log(cliente_key, etapa, sent_at DESC);
  `);
}

// ── Classifica devedor em etapa ──────────────────────────────────────────────

function etapaPorDias(dias) {
  if (dias == null) return null;
  if (dias < 1)   return null;
  if (dias < 7)   return 'D1';
  if (dias < 15)  return 'D7';
  if (dias < 30)  return 'D15';
  return 'D30';
}

// Cooldown (em horas) por etapa. D+1 e D+7 só repetem após 7 dias.
// D+15 e D+30 só repetem após 14 dias (envolvem trabalho da equipe).
const COOLDOWN_H = { D1: 7 * 24, D7: 7 * 24, D15: 14 * 24, D30: 14 * 24 };

async function jaFoiCobrado(clienteKey, etapa) {
  const h = COOLDOWN_H[etapa] || 24;
  const res = await query(
    `SELECT id FROM cobranca_regua_log
     WHERE cliente_key = $1 AND etapa = $2 AND success = true
       AND sent_at > NOW() - INTERVAL '${h} hours'
     LIMIT 1`,
    [clienteKey, etapa]
  );
  return res.rows.length > 0;
}

// ── Templates de mensagem ────────────────────────────────────────────────────

const MSG_D1 = (nome, valor) =>
`Olá, ${nome.split(' ')[0]}. Aqui é do escritório Eduardo Rodrigues Advocacia.

Notei que a parcela de ${valor} venceu há poucos dias. Sei que pode ter passado batido — quer que eu envie o boleto novamente ou prefere combinar uma nova data?

Qualquer dificuldade, me responda por aqui. Estou pra ajudar.`;

const MSG_D7 = (nome, valor) =>
`Olá, ${nome.split(' ')[0]}. Tudo bem?

Estou retornando sobre a parcela de ${valor} ainda em aberto. Pra evitar que a situação se complique, podemos combinar um pagamento ou um novo parcelamento.

Me responda quando puder — vou guardar um horário pra falar com você.

Eduardo Rodrigues Advocacia`;

const MSG_D30 = (nome, valor) =>
`${nome.split(' ')[0]}, este é o último contato amigável sobre a pendência de ${valor}.

A partir de agora seu caso passa pra análise interna do Dr. Eduardo. Conseguimos resolver hoje? Me responda por aqui ou ligue diretamente pro escritório.

Eduardo Rodrigues Advocacia`;

function fmtBRL(n) {
  return 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Resolve task_id no AdvBox (cache local) ─────────────────────────────────

let _taskMap = null, _taskMapAt = 0;
const TASK_TTL = 60 * 60 * 1000;

async function resolveTaskId(name) {
  if (!_taskMap || Date.now() - _taskMapAt > TASK_TTL) {
    try {
      const resp = await fetch(`${ADVBOX_BASE}/settings`, {
        headers: {
          Authorization: `Bearer ${process.env.ADVBOX_TOKEN}`,
          'User-Agent': ADVBOX_UA,
          Accept: 'application/json',
        },
      });
      const json = await resp.json();
      const tasks = (json && json.tasks) || [];
      _taskMap = tasks.map(t => ({
        id: t.id,
        n: String(t.task || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(),
      }));
      _taskMapAt = Date.now();
    } catch {
      _taskMap = [];
    }
  }
  const n = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  let hit = _taskMap.find(t => t.n === n);
  if (hit) return hit.id;
  hit = _taskMap.find(t => t.n.includes(n) || n.includes(t.n));
  if (hit) return hit.id;
  return 8894482; // ACOMPANHAR ANDAMENTO PROCESSUAL (fallback)
}

async function criarTarefaAdvBox({ task, userId, lawsuitId, notes }) {
  const hoje = new Date().toISOString().slice(0, 10);
  const tasksId = await resolveTaskId(task);
  const payload = {
    tasks_id: tasksId,
    notes,
    start_date: hoje,
    date_deadline: hoje,
    from: USERS.EDUARDO,
    lawsuits_id: lawsuitId,
    guests: [userId],
  };
  const resp = await fetch(`${ADVBOX_BASE}/posts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.ADVBOX_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': ADVBOX_UA,
    },
    body: JSON.stringify(payload),
  });
  const raw = await resp.text();
  let body; try { body = JSON.parse(raw); } catch { body = { raw }; }
  if (!resp.ok) {
    const detail = body.errors || body.message || body.raw;
    throw new Error(`AdvBox ${resp.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  return body;
}

// ── Lookup de telefone do cliente (via AdvBox customers) ─────────────────────

async function lookupTelefone(cliente, lawsuits) {
  // Tenta achar telefone via customers do AdvBox (lawsuit do cliente)
  if (!lawsuits || !lawsuits.length) return null;
  const lid = lawsuits[0].id;
  if (!lid) return null;
  try {
    const resp = await fetch(`${ADVBOX_BASE}/lawsuits/${lid}`, {
      headers: {
        Authorization: `Bearer ${process.env.ADVBOX_TOKEN}`,
        'User-Agent': ADVBOX_UA,
        Accept: 'application/json',
      },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const customers = (data && data.customers) || [];
    for (const c of customers) {
      const tel = c.phone || c.mobile || c.cellphone;
      if (tel) return String(tel).replace(/\D/g, '');
    }
  } catch { /* swallow */ }
  return null;
}

// ── Execução de cada etapa ───────────────────────────────────────────────────

async function executaEtapa(cluster, etapa, logger) {
  const valor = fmtBRL(cluster.valorTotal);
  const clienteKey = `cpf:${(cluster.cpf || '').replace(/\D/g, '') || 'sem'}|nome:${cluster.cliente}`;
  const lawsuitId = cluster.lawsuits[0]?.id || null;

  // Etapa → channel + ação
  if (etapa === 'D1' || etapa === 'D7') {
    const tel = await lookupTelefone(cluster, cluster.lawsuits);
    if (!tel) {
      return { ok: false, reason: 'sem_telefone', channel: 'whatsapp' };
    }
    const msg = etapa === 'D1' ? MSG_D1(cluster.cliente, valor) : MSG_D7(cluster.cliente, valor);
    if (DRY_RUN) {
      return { ok: true, dryRun: true, channel: 'whatsapp', telefone: tel, msg: msg.slice(0, 60) + '...' };
    }
    try {
      const r = await sendWhatsApp(tel, msg);
      return { ok: true, channel: 'whatsapp', messageId: r.messageId, telefone: tel };
    } catch (e) {
      throw new Error(`ChatGuru: ${e.message}`);
    }
  }

  if (etapa === 'D15') {
    if (!lawsuitId) return { ok: false, reason: 'sem_lawsuit', channel: 'advbox_task' };
    const notes = [
      `[Régua D+15] Cliente inadimplente há ${cluster.diasAtraso} dias.`,
      `Valor total atrasado: ${valor}`,
      `Parcelas atrasadas: ${cluster.parcelas}`,
      `Cliente: ${cluster.cliente}`,
      cluster.cpf ? `CPF: ${cluster.cpf}` : '',
      `AÇÃO: ligar para o cliente e negociar pagamento ou parcelamento.`,
      `Antes da ligação confira se ele respondeu o WhatsApp das etapas anteriores.`,
    ].filter(Boolean).join('\n');
    if (DRY_RUN) return { ok: true, dryRun: true, channel: 'advbox_task' };
    const post = await criarTarefaAdvBox({
      task: 'LIGAR PARA CLIENTE INADIMPLENTE',
      userId: USERS.CAU,
      lawsuitId,
      notes,
    });
    return { ok: true, channel: 'advbox_task', post_id: post?.id || null };
  }

  if (etapa === 'D30') {
    if (!lawsuitId) return { ok: false, reason: 'sem_lawsuit', channel: 'advbox_task' };
    const notes = [
      `[Régua D+30 ESCALAÇÃO] Dr. Eduardo, este caso passou todas as etapas anteriores sem retorno.`,
      `Cliente: ${cluster.cliente}`,
      cluster.cpf ? `CPF: ${cluster.cpf}` : '',
      `Atraso: ${cluster.diasAtraso} dias · ${cluster.parcelas} parcela(s) · Total: ${valor}`,
      `Histórico já tentado: WhatsApp D+1, WhatsApp D+7, ligação D+15.`,
      `AÇÃO sugerida: decidir entre protesto, acordo extrajudicial ou execução.`,
    ].join('\n');
    if (DRY_RUN) return { ok: true, dryRun: true, channel: 'advbox_task' };
    const post = await criarTarefaAdvBox({
      task: 'ESCALAR INADIMPLENCIA',
      userId: USERS.EDUARDO,
      lawsuitId,
      notes,
    });
    // Também tenta WhatsApp final de aviso
    try {
      const tel = await lookupTelefone(cluster, cluster.lawsuits);
      if (tel) await sendWhatsApp(tel, MSG_D30(cluster.cliente, valor));
    } catch (e) {
      logger.warn(`[Régua D30] WhatsApp final falhou (segue): ${e.message}`);
    }
    return { ok: true, channel: 'advbox_task', post_id: post?.id || null };
  }

  return { ok: false, reason: 'etapa_desconhecida' };
}

// ── Logging ──────────────────────────────────────────────────────────────────

async function logEvento(clienteKey, cluster, etapa, channel, result, errorMessage) {
  try {
    await query(
      `INSERT INTO cobranca_regua_log
        (cliente_key, cliente, etapa, channel, dias_atraso, valor_total, lawsuit_id, payload, success, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
      [
        clienteKey,
        cluster.cliente,
        etapa,
        channel,
        cluster.diasAtraso,
        cluster.valorTotal,
        cluster.lawsuits[0]?.id || null,
        JSON.stringify(result || {}),
        result?.ok ? true : false,
        errorMessage || null,
      ]
    );
  } catch (e) {
    // não bloqueia o ciclo
    console.error('[Régua] log falhou:', e.message);
  }
}

// ── Ciclo principal ──────────────────────────────────────────────────────────

async function runCycle({ logger = console, dryRun = false } = {}) {
  await ensureTable();
  const { criticosRecentes, acumulados } = await getInadimplentes({ force: false });
  const todos = [...criticosRecentes, ...acumulados];
  logger.info(`[Régua] ${todos.length} clientes inadimplentes detectados`);

  let executados = 0, pulados = 0, erros = 0;
  const detalhes = [];

  for (const cluster of todos) {
    const etapa = etapaPorDias(cluster.diasAtraso);
    if (!etapa) { pulados++; continue; }

    const clienteKey = `cpf:${(cluster.cpf || '').replace(/\D/g, '') || 'sem'}|nome:${cluster.cliente}`;
    if (await jaFoiCobrado(clienteKey, etapa)) {
      pulados++;
      continue;
    }

    try {
      const result = dryRun
        ? { ok: true, dryRun: true, channel: etapa === 'D1' || etapa === 'D7' ? 'whatsapp' : 'advbox_task' }
        : await executaEtapa(cluster, etapa, logger);

      await logEvento(clienteKey, cluster, etapa, result.channel || 'unknown', result, result.ok ? null : result.reason);

      if (result.ok) {
        executados++;
        detalhes.push({ cliente: cluster.cliente, etapa, dias: cluster.diasAtraso, valor: cluster.valorTotal, ...result });
      } else {
        pulados++;
        detalhes.push({ cliente: cluster.cliente, etapa, motivo: result.reason });
      }

      // throttle anti-rate-limit (AdvBox + ChatGuru)
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      erros++;
      logger.error(`[Régua] erro cliente=${cluster.cliente} etapa=${etapa}: ${e.message}`);
      await logEvento(clienteKey, cluster, etapa, 'erro', null, e.message.slice(0, 500));
    }
  }

  logger.info(`[Régua] Ciclo: ${todos.length} analisados, ${executados} executados, ${pulados} pulados, ${erros} erros`);
  return { processados: todos.length, executados, pulados, erros, detalhes, dryRun: !!dryRun };
}

// ── Métricas pro painel ──────────────────────────────────────────────────────

async function getMetrics() {
  const res = await query(`
    SELECT
      COUNT(*) FILTER (WHERE sent_at > NOW() - INTERVAL '7 days' AND success = true)::int AS execs_7d,
      COUNT(*) FILTER (WHERE sent_at > NOW() - INTERVAL '30 days' AND success = true)::int AS execs_30d,
      COUNT(*) FILTER (WHERE sent_at > NOW() - INTERVAL '7 days' AND etapa = 'D30' AND success = true)::int AS escalacoes_7d,
      COUNT(DISTINCT cliente_key) FILTER (WHERE sent_at > NOW() - INTERVAL '30 days')::int AS clientes_unicos_30d
    FROM cobranca_regua_log
  `);
  const porEtapa = await query(`
    SELECT etapa, COUNT(*)::int AS n
    FROM cobranca_regua_log
    WHERE sent_at > NOW() - INTERVAL '30 days' AND success = true
    GROUP BY etapa
    ORDER BY etapa
  `);
  return {
    ...res.rows[0],
    por_etapa_30d: porEtapa.rows.reduce((acc, r) => (acc[r.etapa] = r.n, acc), {}),
  };
}

module.exports = { runCycle, getMetrics, etapaPorDias, ensureTable };
