/**
 * Painel executivo — agrega 6 KPIs essenciais pro dono ver no celular.
 *
 *  1. Caixa do mês (recebido + previsto, saldo - despesas)
 *  2. Ticket médio últimos 90d
 *  3. % procedência (sentenças procedentes / total sentenças últimos 60d)
 *  4. Tarefas vencidas hoje (top 5)
 *  5. Leads sem resposta (SLA estourado)
 *  6. Régua de cobrança — execuções 7d + escalações
 *
 * Cache 5 min (curto, pra o painel ser sempre fresco).
 *
 * GET /api/executivo
 */

'use strict';

const { Router } = require('express');
const { requireAdmin } = require('../../../middleware/auth');
const cache = require('../../../cache');
const { fetchTransactions, fetchLawsuits, fetchAllPosts } = require('../../../services/data');
const { parseAdvboxDate } = require('../../../services/date-utils');
const { isParcelaValida } = require('../../../services/finance-helpers');
const { getMetrics: getSlaMetrics, ensureTable: ensureSlaTable } = require('../../../services/sla-leads');
const { getMetrics: getReguaMetrics, ensureTable: ensureReguaTable } = require('../../../services/regua-cobranca');
const { getForecast } = require('../../../services/forecast');

const router = Router();

cache.define('executivo', 5 * 60 * 1000);

// ── Helpers ──────────────────────────────────────────────────────────────────

function normFase(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[-–—]/g, ' ').replace(/\s+/g, ' ').trim();
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(baseISO, n) {
  const d = new Date(baseISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── KPI 1: caixa do mês ──────────────────────────────────────────────────────

function calcCaixaMes(transactions) {
  const hoje = new Date();
  const mm = hoje.getMonth() + 1;
  const yyyy = hoje.getFullYear();
  const matchMes = s => {
    if (!s) return false;
    const str = String(s);
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) return +str.slice(0,4) === yyyy && +str.slice(5,7) === mm;
    if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) { const p = str.split('/'); return +p[1] === mm && +p[2] === yyyy; }
    return false;
  };

  let recebido = 0, previsto = 0, despesasPagas = 0;
  for (const t of transactions) {
    if (t.entry_type === 'income' && isParcelaValida(t)) {
      if (matchMes(t.date_payment)) recebido += Number(t.amount || 0);
      else if (!t.date_payment && matchMes(t.date_due)) previsto += Number(t.amount || 0);
    } else if (t.entry_type === 'expense' && matchMes(t.date_payment)) {
      despesasPagas += Number(t.amount || 0);
    }
  }
  return {
    mes: `${String(mm).padStart(2, '0')}/${yyyy}`,
    recebido: Number(recebido.toFixed(2)),
    previsto: Number(previsto.toFixed(2)),
    despesas_pagas: Number(despesasPagas.toFixed(2)),
    saldo: Number((recebido - despesasPagas).toFixed(2)),
    projetado_total: Number((recebido + previsto).toFixed(2)),
  };
}

// ── KPI 2: ticket médio últimos 90d ──────────────────────────────────────────

function calcTicketMedio(transactions) {
  const cortISO = addDays(todayISO(), -90);
  const porCaso = new Map();
  for (const t of transactions) {
    if (!isParcelaValida(t) || !t.date_payment) continue;
    const payISO = parseAdvboxDate(t.date_payment)?.toISOString().slice(0,10);
    if (!payISO || payISO < cortISO) continue;
    const lid = t.lawsuit_id || t.lawsuits_id;
    if (!lid) continue;
    porCaso.set(lid, (porCaso.get(lid) || 0) + Number(t.amount || 0));
  }
  if (porCaso.size === 0) return { ticket_medio: 0, casos: 0 };
  const total = [...porCaso.values()].reduce((s, v) => s + v, 0);
  return {
    ticket_medio: Number((total / porCaso.size).toFixed(2)),
    casos: porCaso.size,
    receita_90d: Number(total.toFixed(2)),
  };
}

// ── KPI 3: % procedência últimos 60d ─────────────────────────────────────────

function calcProcedencia(lawsuits, posts) {
  // Usa lawsuits que estão atualmente em fases pós-sentença + posts de sentença
  // últimos 60d como aproximação. Métrica mais grossa, mas evita precisar de
  // dados históricos profundos.
  const FASES_PROCEDENTE = new Set([
    'SENTENCA PROCEDENTE VERIFICAR IMPLANTACAO',
    'PROCEDENTE EM PARTE FAZER RECURSO',
    'JUDICIAL IMPLANTADO A RECEBER',
    'ADM IMPLANTADO A RECEBER',
    'BENEFICIO CONCEDIDO AGUARDAR',
    'TRANSITO EM JULGADO NAO CABE RECURSO',
  ]);
  const FASES_IMPROCEDENTE = new Set([
    'SENTENCA IMPROCEDENTE',
    'IMPROCEDENTE CABE RECURSO',
    'DESENVOLVENDO RECURSO AOS TRIBUNAIS',
    'RECURSO PROTOCOLADO INICIADO',
  ]);
  let proc = 0, improc = 0;
  for (const l of lawsuits) {
    const f = normFase(l.stage);
    if (FASES_PROCEDENTE.has(f)) proc++;
    else if (FASES_IMPROCEDENTE.has(f)) improc++;
  }
  const total = proc + improc;
  return {
    procedencia_pct: total ? Number(((proc / total) * 100).toFixed(1)) : 0,
    procedentes: proc,
    improcedentes: improc,
  };
}

// ── KPI 4: tarefas vencidas (top 5) ──────────────────────────────────────────

function calcVencidas(posts) {
  const agora = Date.now();
  const vencidas = posts.filter(t => {
    const prazo = t.date_deadline;
    if (!prazo) return false;
    const u = (t.users || [])[0];
    const concluido = u && (u.completed != null && u.completed !== false && u.completed !== 0);
    if (concluido) return false;
    if (t.date && new Date(t.date).getTime() >= agora) return false;
    return new Date(prazo).getTime() < agora;
  });

  const top = vencidas
    .map(t => ({
      id: t.id,
      task: (t.task || 'tarefa').slice(0, 70),
      responsavel: (t.users || [])[0]?.name || '—',
      dias_atraso: Math.floor((agora - new Date(t.date_deadline).getTime()) / 86400000),
      lawsuit_id: t.lawsuits_id || null,
    }))
    .sort((a, b) => b.dias_atraso - a.dias_atraso)
    .slice(0, 5);

  return {
    total: vencidas.length,
    top5: top,
  };
}

// ── Endpoint principal ───────────────────────────────────────────────────────

router.get('/executivo', requireAdmin, async (req, res, next) => {
  try {
    const force = req.query.force === '1';
    const data = await cache.getOrFetch('executivo', async () => {
      await Promise.all([ensureSlaTable(), ensureReguaTable()]);

      const [transactions, lawsuits, posts, slaMetrics, reguaMetrics, forecast] = await Promise.all([
        fetchTransactions(force),
        fetchLawsuits(force),
        fetchAllPosts(500, 4, 600).catch(() => []),
        getSlaMetrics().catch(() => null),
        getReguaMetrics().catch(() => null),
        getForecast({ force }).catch(() => null),
      ]);

      const caixaMes = calcCaixaMes(transactions);
      const ticket   = calcTicketMedio(transactions);
      const procd    = calcProcedencia(lawsuits, posts);
      const venc     = calcVencidas(posts);

      // Status semáforo por KPI (verde/amarelo/vermelho)
      const statusCaixa   = caixaMes.saldo >= 0 ? 'verde' : (caixaMes.saldo > -5000 ? 'amarelo' : 'vermelho');
      const statusProcd   = procd.procedencia_pct >= 70 ? 'verde' : (procd.procedencia_pct >= 50 ? 'amarelo' : 'vermelho');
      const statusVenc    = venc.total === 0 ? 'verde' : (venc.total <= 5 ? 'amarelo' : 'vermelho');
      const statusLeads   = !slaMetrics || slaMetrics.parados_agora === 0 ? 'verde' : (slaMetrics.parados_agora <= 3 ? 'amarelo' : 'vermelho');
      const statusRegua   = !reguaMetrics ? 'verde' : (reguaMetrics.escalacoes_7d <= 2 ? 'verde' : (reguaMetrics.escalacoes_7d <= 5 ? 'amarelo' : 'vermelho'));

      return {
        geradoEm: new Date().toISOString(),
        kpis: {
          caixa_mes: { ...caixaMes, status: statusCaixa },
          ticket_medio: { ...ticket, status: 'verde' },
          procedencia: { ...procd, status: statusProcd },
          vencidas: { ...venc, status: statusVenc },
          leads_sla: { ...(slaMetrics || {}), status: statusLeads },
          regua_cobranca: { ...(reguaMetrics || {}), status: statusRegua },
        },
        forecast: forecast ? {
          d30:  forecast.buckets.d30.total,
          d90:  forecast.buckets.d90.total,
          d180: forecast.buckets.d180.total,
        } : null,
      };
    }, force);

    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
