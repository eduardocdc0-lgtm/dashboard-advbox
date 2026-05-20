/**
 * Forecast de caixa — projeção de receita futura combinando:
 *  1. Parcelas a vencer (date_due > hoje, sem date_payment)         — confiança ALTA
 *  2. Sentenças procedentes ainda não implantadas × taxa histórica  — confiança MÉDIA
 *  3. RPVs do mês/próximo mês (fases RPV)                            — confiança MÉDIA
 *  4. Pipeline judicial (peticionar/protocolar) × prob × ticket     — confiança BAIXA
 *
 * Buckets: 30d / 60d / 90d / 180d. Cada bucket retorna soma + breakdown
 * por fonte pra Eduardo entender de onde vem o dinheiro projetado.
 *
 * Cache 15 min. Usa fetchTransactions + fetchLawsuits (que já vêm cacheados).
 */

'use strict';

const { fetchTransactions, fetchLawsuits } = require('./data');
const { parseAdvboxDate } = require('./date-utils');
const { isParcelaValida } = require('./finance-helpers');
const r = require('./audit-rules');
const cache = require('../cache');

cache.define('forecast', 15 * 60 * 1000);

// ── Configuração ─────────────────────────────────────────────────────────────
// Taxas de conversão históricas (default — podem virar config via app_config no futuro)
const CFG = Object.freeze({
  // Sentença procedente → implantação efetiva (INSS implanta na maioria)
  TAXA_IMPLANTACAO:       0.90,
  // Dias médios entre sentença procedente e primeira parcela cair
  DIAS_ATE_IMPLANTACAO:   75,
  // Petição inicial → sentença procedente (taxa de êxito médio do escritório)
  TAXA_PROCEDENCIA_JUD:   0.65,
  DIAS_ATE_SENTENCA:      120,
  // Ticket médio se não der pra calcular do histórico
  TICKET_MEDIO_FALLBACK:  3500,
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(baseISO, n) {
  const d = new Date(baseISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function normFase(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[-–—]/g, ' ').replace(/\s+/g, ' ').trim();
}

function diasEntre(d1ISO, d2ISO) {
  return Math.floor((new Date(d2ISO + 'T00:00:00Z') - new Date(d1ISO + 'T00:00:00Z')) / 86400000);
}

// ── Cálculo de ticket médio histórico (180 dias) ─────────────────────────────

function calcTicketMedio(transactions) {
  const cortISO = addDays(todayISO(), -180);
  const pagas = transactions.filter(t =>
    isParcelaValida(t) &&
    t.date_payment &&
    parseAdvboxDate(t.date_payment)?.toISOString().slice(0,10) >= cortISO
  );
  if (!pagas.length) return CFG.TICKET_MEDIO_FALLBACK;
  // Agrupa por lawsuit_id pra contar caso (não parcela)
  const porCaso = new Map();
  for (const t of pagas) {
    const lid = t.lawsuit_id || t.lawsuits_id;
    if (!lid) continue;
    porCaso.set(lid, (porCaso.get(lid) || 0) + Number(t.amount || 0));
  }
  if (porCaso.size === 0) return CFG.TICKET_MEDIO_FALLBACK;
  const total = [...porCaso.values()].reduce((s, v) => s + v, 0);
  return total / porCaso.size;
}

// ── Fonte 1: parcelas a vencer (confiança ALTA) ──────────────────────────────

function parcelasAVencer(transactions, hojeISO) {
  return transactions
    .filter(t =>
      isParcelaValida(t) &&
      !t.date_payment &&
      t.date_due
    )
    .map(t => {
      const dueISO = parseAdvboxDate(t.date_due)?.toISOString().slice(0, 10);
      if (!dueISO || dueISO < hojeISO) return null; // vencidas vão pra inadimplência, não forecast
      return {
        valor: Number(t.amount || 0),
        dataEsperada: dueISO,
        confianca: 'alta',
        fonte: 'parcela_a_vencer',
        cliente: t.name || t.customer_name || null,
        lawsuit_id: t.lawsuit_id || t.lawsuits_id || null,
      };
    })
    .filter(Boolean);
}

// ── Fonte 2: sentenças procedentes esperando implantação (confiança MÉDIA) ───
// Fases que indicam sentença ganha mas dinheiro ainda não no caixa.

const FASES_AGUARDANDO_IMPLANTACAO = new Set([
  'SENTENCA PROCEDENTE VERIFICAR IMPLANTACAO',
  'BENEFICIO CONCEDIDO AGUARDAR',
  'JUDICIAL IMPLANTADO A RECEBER',
  'ADM IMPLANTADO A RECEBER',
  'SALARIO MATERNIDADE CONCEDIDO',
]);

function sentencasAguardando(lawsuits, hojeISO, ticketMedio) {
  return lawsuits
    .filter(l => FASES_AGUARDANDO_IMPLANTACAO.has(normFase(l.stage)))
    .map(l => {
      // Data esperada = última movimentação + DIAS_ATE_IMPLANTACAO
      const base = l.last_movement_date || l.updated_at || l.created_at;
      const baseISO = parseAdvboxDate(base)?.toISOString().slice(0, 10) || hojeISO;
      const dataEsperada = addDays(baseISO, CFG.DIAS_ATE_IMPLANTACAO);
      // Se já passou da data esperada, projeta pra 30 dias frente (atrasou mas vai sair)
      const dataFinal = dataEsperada < hojeISO ? addDays(hojeISO, 30) : dataEsperada;
      return {
        valor: ticketMedio * CFG.TAXA_IMPLANTACAO,
        dataEsperada: dataFinal,
        confianca: 'media',
        fonte: 'sentenca_implantacao',
        cliente: l.responsible || null,
        lawsuit_id: l.id,
      };
    });
}

// ── Fonte 3: RPVs aguardando pagamento (confiança MÉDIA) ─────────────────────

const FASES_RPV = new Set([
  'RPV DO MES',
  'RPV DO PROXIMO MES',
  'AGUARDANDO EXPEDICAO DE RPV',
]);

function rpvsAguardando(lawsuits, hojeISO, ticketMedio) {
  return lawsuits
    .filter(l => FASES_RPV.has(normFase(l.stage)))
    .map(l => {
      const fase = normFase(l.stage);
      let dias = 30; // RPV do mês = sai esse mês
      if (fase === 'RPV DO PROXIMO MES') dias = 60;
      if (fase === 'AGUARDANDO EXPEDICAO DE RPV') dias = 90;
      return {
        valor: ticketMedio * 1.5, // RPV costuma ser maior que ticket parcelado
        dataEsperada: addDays(hojeISO, dias),
        confianca: 'media',
        fonte: 'rpv',
        cliente: l.responsible || null,
        lawsuit_id: l.id,
      };
    });
}

// ── Fonte 4: pipeline judicial (confiança BAIXA) ─────────────────────────────

const FASES_PIPELINE_JUD = new Set([
  'ELABORAR PETICAO INICIAL',
  'COM PRAZO',
  'PROTOCOLADO JUDICIAL',
]);

function pipelineJudicial(lawsuits, hojeISO, ticketMedio) {
  return lawsuits
    .filter(l => FASES_PIPELINE_JUD.has(normFase(l.stage)))
    .map(l => {
      const dataEsperada = addDays(hojeISO, CFG.DIAS_ATE_SENTENCA + CFG.DIAS_ATE_IMPLANTACAO);
      return {
        valor: ticketMedio * CFG.TAXA_PROCEDENCIA_JUD * CFG.TAXA_IMPLANTACAO,
        dataEsperada,
        confianca: 'baixa',
        fonte: 'pipeline_judicial',
        cliente: l.responsible || null,
        lawsuit_id: l.id,
      };
    });
}

// ── Bucketização ────────────────────────────────────────────────────────────

function bucket(itens, hojeISO) {
  const buckets = {
    d30:  { dias: 30,  total: 0, count: 0, porFonte: {} },
    d60:  { dias: 60,  total: 0, count: 0, porFonte: {} },
    d90:  { dias: 90,  total: 0, count: 0, porFonte: {} },
    d180: { dias: 180, total: 0, count: 0, porFonte: {} },
  };
  const limites = {
    d30:  addDays(hojeISO, 30),
    d60:  addDays(hojeISO, 60),
    d90:  addDays(hojeISO, 90),
    d180: addDays(hojeISO, 180),
  };
  for (const item of itens) {
    const data = item.dataEsperada;
    if (data > limites.d180) continue; // fora do horizonte
    // Identifica o primeiro bucket onde a data cabe
    const alvos = [];
    if (data <= limites.d30) alvos.push('d30', 'd60', 'd90', 'd180');
    else if (data <= limites.d60) alvos.push('d60', 'd90', 'd180');
    else if (data <= limites.d90) alvos.push('d90', 'd180');
    else alvos.push('d180');
    // Cumulativo: cada bucket inclui valores dos buckets menores
    for (const b of alvos) {
      buckets[b].total += item.valor;
      buckets[b].count += 1;
      buckets[b].porFonte[item.fonte] = (buckets[b].porFonte[item.fonte] || 0) + item.valor;
    }
  }
  // Arredonda
  for (const b of Object.values(buckets)) {
    b.total = Number(b.total.toFixed(2));
    for (const k of Object.keys(b.porFonte)) b.porFonte[k] = Number(b.porFonte[k].toFixed(2));
  }
  return buckets;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function getForecast({ force = false } = {}) {
  return cache.getOrFetch('forecast', async () => {
    const hojeISO = todayISO();
    const [transactions, lawsuits] = await Promise.all([
      fetchTransactions(force),
      fetchLawsuits(force),
    ]);
    const ticketMedio = calcTicketMedio(transactions);

    const fontes = {
      parcelas:    parcelasAVencer(transactions, hojeISO),
      sentencas:   sentencasAguardando(lawsuits, hojeISO, ticketMedio),
      rpvs:        rpvsAguardando(lawsuits, hojeISO, ticketMedio),
      pipeline:    pipelineJudicial(lawsuits, hojeISO, ticketMedio),
    };

    const todos = [
      ...fontes.parcelas,
      ...fontes.sentencas,
      ...fontes.rpvs,
      ...fontes.pipeline,
    ];

    const buckets = bucket(todos, hojeISO);

    // Resumo por confiança (alta/media/baixa)
    const porConfianca = { alta: 0, media: 0, baixa: 0 };
    for (const item of todos) porConfianca[item.confianca] += item.valor;
    for (const k of Object.keys(porConfianca)) porConfianca[k] = Number(porConfianca[k].toFixed(2));

    // Top 10 itens por valor (pra Eduardo conferir de perto)
    const topItens = [...todos]
      .sort((a, b) => b.valor - a.valor)
      .slice(0, 10)
      .map(i => ({ ...i, valor: Number(i.valor.toFixed(2)) }));

    return {
      geradoEm: new Date().toISOString(),
      hoje: hojeISO,
      ticketMedio: Number(ticketMedio.toFixed(2)),
      config: CFG,
      buckets,
      porConfianca,
      resumoFontes: {
        parcelas:  { count: fontes.parcelas.length,  total: Number(fontes.parcelas.reduce((s, i) => s + i.valor, 0).toFixed(2)) },
        sentencas: { count: fontes.sentencas.length, total: Number(fontes.sentencas.reduce((s, i) => s + i.valor, 0).toFixed(2)) },
        rpvs:      { count: fontes.rpvs.length,      total: Number(fontes.rpvs.reduce((s, i) => s + i.valor, 0).toFixed(2)) },
        pipeline:  { count: fontes.pipeline.length,  total: Number(fontes.pipeline.reduce((s, i) => s + i.valor, 0).toFixed(2)) },
      },
      topItens,
    };
  }, force);
}

module.exports = { getForecast, CFG };
