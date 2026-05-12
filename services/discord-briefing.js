/**
 * Briefing diário 7h30 — manda no Discord um resumo operacional do escritório.
 *
 * Conteúdo (embeds):
 *  - Tarefas vencidas (top 8 por dias de atraso)
 *  - Tarefas vencendo hoje/amanhã
 *  - Inadimplência do mês (taxa + valores)
 *  - Caixa: a receber / a pagar
 *  - Top 3 devedores
 *
 * Disparado pelo cron em `clients/dashboard/cron/discord-briefing.js`.
 */

'use strict';

const fetch = require('node-fetch');
const { fetchAllPosts, fetchTransactions } = require('./data');

const COLORS = {
  green:  0x166534,
  yellow: 0xB45309,
  red:    0xB02020,
  neutral: 0x1A1A1A,
};

function fmtMoney(n) {
  if (n == null || isNaN(n)) return '—';
  return 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function diasDesde(s) {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d)) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function isParcelaValida(t) {
  if (t.entry_type !== 'income') return false;
  const amt = Number(t.amount || 0);
  if (amt < 1) return false;
  const desc = String(t.description || t.notes || '').toUpperCase();
  if (desc.includes('EXCLUIR') || desc.includes('ARQUIVADO')) return false;
  return true;
}

function nomeUsuario(t) {
  const u = (t.users || [])[0];
  if (!u) return '—';
  return u.name || u.user_id || '—';
}

async function buildBriefing() {
  const [posts, transactions] = await Promise.all([
    fetchAllPosts().catch(() => []),
    fetchTransactions().catch(() => []),
  ]);

  const agora = Date.now();
  const hojeStr = new Date().toISOString().slice(0,10);
  const amanha = new Date(agora + 86400000).toISOString().slice(0,10);

  // ── Tarefas vencidas ────────────────────────────────────────────────────
  const vencidas = posts
    .filter(t => {
      const prazo = t.date_deadline;
      if (!prazo) return false;
      const u = (t.users || [])[0];
      const concluido = u && (u.completed != null && u.completed !== false && u.completed !== 0);
      if (concluido) return false;
      // Se tem date (data do evento) no futuro, não é vencida real
      if (t.date && new Date(t.date).getTime() >= agora) return false;
      return new Date(prazo).getTime() < agora && new Date(prazo).toISOString().slice(0,10) !== hojeStr;
    })
    .map(t => ({
      id: t.id,
      task: t.task || 'tarefa',
      responsavel: nomeUsuario(t),
      diasAtraso: diasDesde(t.date_deadline),
    }))
    .sort((a,b) => b.diasAtraso - a.diasAtraso)
    .slice(0, 8);

  // ── Tarefas vencendo hoje ou amanhã ─────────────────────────────────────
  const proximas = posts
    .filter(t => {
      const u = (t.users || [])[0];
      const concluido = u && (u.completed != null && u.completed !== false && u.completed !== 0);
      if (concluido) return false;
      const prazoStr = t.date_deadline ? new Date(t.date_deadline).toISOString().slice(0,10) : null;
      return prazoStr === hojeStr || prazoStr === amanha;
    })
    .map(t => ({
      task: t.task || 'tarefa',
      responsavel: nomeUsuario(t),
      prazo: t.date_deadline ? new Date(t.date_deadline).toISOString().slice(0,10) : '',
    }))
    .slice(0, 10);

  // ── Inadimplência do mês ────────────────────────────────────────────────
  const today = new Date();
  const mm = today.getMonth() + 1;
  const yyyy = today.getFullYear();
  const matchMes = s => {
    if (!s) return false;
    const str = String(s);
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) return +str.slice(0,4) === yyyy && +str.slice(5,7) === mm;
    if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) { const p = str.split('/'); return +p[1] === mm && +p[2] === yyyy; }
    return false;
  };
  const doMes = transactions.filter(isParcelaValida).filter(t => matchMes(t.date_due));
  let devido = 0, pago = 0;
  const devedoresMap = new Map();
  for (const t of doMes) {
    const amt = Number(t.amount || 0);
    devido += amt;
    if (t.date_payment) { pago += amt; }
    else {
      const nome = (t.name || t.customer_name || '(sem nome)').toUpperCase();
      const cur = devedoresMap.get(nome) || { nome: t.name || t.customer_name || '(sem nome)', valor: 0, oldestDue: t.date_due };
      cur.valor += amt;
      if (t.date_due && (!cur.oldestDue || t.date_due < cur.oldestDue)) cur.oldestDue = t.date_due;
      devedoresMap.set(nome, cur);
    }
  }
  const atraso = devido - pago;
  const taxa = devido > 0 ? (atraso / devido) * 100 : 0;
  const topDevedores = [...devedoresMap.values()].sort((a,b) => b.valor - a.valor).slice(0,3);

  // ── A receber (income futuro do mês não pago) ───────────────────────────
  const aReceber = transactions.filter(t =>
    isParcelaValida(t) && !t.date_payment && matchMes(t.date_due)
  ).reduce((s,t) => s + Number(t.amount || 0), 0);

  // ── A pagar (expense próximos 30 dias) ──────────────────────────────────
  const em30 = new Date(agora + 30*86400000).toISOString().slice(0,10);
  const aPagar = transactions.filter(t =>
    t.entry_type === 'expense' && !t.date_payment &&
    t.date_due && t.date_due <= em30 && t.date_due >= hojeStr
  ).reduce((s,t) => s + Number(t.amount || 0), 0);

  return {
    vencidas, proximas, taxa, devido, pago, atraso, topDevedores,
    aReceber, aPagar,
  };
}

function buildEmbed(b) {
  const diasDaSemana = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
  const hoje = new Date();
  const dataLabel = `${hoje.toLocaleDateString('pt-BR')} (${diasDaSemana[hoje.getDay()]})`;

  // Cor do embed baseada no pior indicador
  let color = COLORS.green;
  if (b.taxa >= 15 || b.vencidas.length > 10) color = COLORS.red;
  else if (b.taxa >= 5 || b.vencidas.length > 3) color = COLORS.yellow;

  const fields = [];

  if (b.vencidas.length) {
    fields.push({
      name: `🔴 Tarefas vencidas (${b.vencidas.length})`,
      value: b.vencidas.map(t =>
        `• \`#${t.id}\` ${t.task.slice(0,55)} — **${t.responsavel}** · ${t.diasAtraso}d`
      ).join('\n').slice(0, 1020),
      inline: false,
    });
  }

  if (b.proximas.length) {
    fields.push({
      name: `⏰ Vencem hoje/amanhã (${b.proximas.length})`,
      value: b.proximas.map(t =>
        `• ${t.task.slice(0,55)} — **${t.responsavel}** · ${t.prazo}`
      ).join('\n').slice(0, 1020),
      inline: false,
    });
  }

  const estadoTaxa = b.taxa >= 15 ? '🔴 Crítico' : b.taxa >= 5 ? '🟡 Atenção' : '🟢 Saudável';
  fields.push({
    name: '💰 Financeiro do mês',
    value: [
      `**A receber:** ${fmtMoney(b.aReceber)}`,
      `**A pagar (30d):** ${fmtMoney(b.aPagar)}`,
      `**Inadimplência:** ${b.taxa.toFixed(1)}% (${estadoTaxa})`,
      `_Devido ${fmtMoney(b.devido)} · Pago ${fmtMoney(b.pago)} · Atraso ${fmtMoney(b.atraso)}_`,
    ].join('\n'),
    inline: false,
  });

  if (b.topDevedores.length) {
    fields.push({
      name: `⚠️ Top devedores`,
      value: b.topDevedores.map(d => {
        const dias = d.oldestDue ? Math.max(0, Math.floor((Date.now() - new Date(d.oldestDue)) / 86400000)) : null;
        return `• **${d.nome}** — ${fmtMoney(d.valor)}${dias != null ? ` · ${dias}d atraso` : ''}`;
      }).join('\n').slice(0, 1020),
      inline: false,
    });
  }

  return {
    embeds: [{
      title: `☀️ Bom dia — ${dataLabel}`,
      description: 'Resumo operacional do escritório.',
      color,
      fields,
      footer: { text: 'Eduardo Rodrigues Advocacia · Dashboard AdvBox' },
      timestamp: new Date().toISOString(),
    }],
  };
}

async function sendBriefing({ logger = console } = {}) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) throw new Error('DISCORD_WEBHOOK_URL não configurado');
  const b = await buildBriefing();
  const payload = buildEmbed(b);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Discord ${resp.status}: ${txt.slice(0,200)}`);
  }
  logger.info(`[Briefing] enviado — vencidas:${b.vencidas.length} proximas:${b.proximas.length} taxa:${b.taxa.toFixed(1)}%`);
  return { ok: true, summary: { vencidas: b.vencidas.length, proximas: b.proximas.length, taxa: b.taxa } };
}

module.exports = { buildBriefing, buildEmbed, sendBriefing };
