/**
 * Inadimplentes — relatório agregado por cliente.
 *
 * Diferente de `finance.js → calcInadimplenciaMes` (que olha 1 mês),
 * aqui agregamos TODAS as parcelas atrasadas (date_due < hoje, sem
 * date_payment) e classificamos cada cliente em 2 buckets:
 *
 *   - CRÍTICO RECENTE: 1 parcela atrasada, atraso ≤ 60 dias
 *   - ACUMULADO: ≥2 parcelas E soma ≥ R$ 1.000, OU atraso > 60 dias
 *
 * Regra discutida com Eduardo: valor isolado NÃO desempata (pagamento
 * único de R$ 10k atrasado 30d ainda é "recente"). Só o ACÚMULO de
 * dívida ou tempo de atraso elevam o caso.
 */

'use strict';

const { fetchTransactions } = require('./data');

// ── Configuração ─────────────────────────────────────────────────────────────
const CFG = Object.freeze({
  DIAS_LIMITE: 60,             // > 60 dias = acumulado
  MIN_PARCELAS_ACUMULADO: 2,   // ≥ 2 parcelas
  MIN_VALOR_SOMA: 1000,        // E soma ≥ R$ 1.000 (junto com ≥2)
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function isParcelaValida(t) {
  if (t.entry_type !== 'income') return false;
  const amt = Number(t.amount || 0);
  if (amt < 1) return false; // placeholders 0.01
  const desc = String(t.description || t.notes || '').toUpperCase();
  if (desc.includes('EXCLUIR')) return false;
  if (desc.includes('ARQUIVADO')) return false;
  return true;
}

function isAtrasada(t, hojeISO) {
  if (t.date_payment) return false;     // já paga
  if (!t.date_due) return false;        // sem vencimento, ignora
  return String(t.date_due) < hojeISO;
}

function diasEntre(dateStr, hoje) {
  if (!dateStr) return null;
  const d = new Date(String(dateStr) + 'T12:00:00Z');
  if (isNaN(d)) return null;
  return Math.max(0, Math.floor((hoje.getTime() - d.getTime()) / 86_400_000));
}

function normNome(s) {
  return String(s || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

// ── Classificação por cliente ────────────────────────────────────────────────

/**
 * Recebe um "cluster" do cliente (várias parcelas atrasadas dele) e
 * retorna 'critico' | 'acumulado'.
 */
function classificar(cluster) {
  const { parcelas, valorTotal, diasAtraso } = cluster;

  // 1. Atraso > 60 dias → acumulado (independente do resto)
  if (diasAtraso != null && diasAtraso > CFG.DIAS_LIMITE) return 'acumulado';

  // 2. ≥ 2 parcelas E soma ≥ R$ 1.000 → acumulado
  if (parcelas >= CFG.MIN_PARCELAS_ACUMULADO && valorTotal >= CFG.MIN_VALOR_SOMA) {
    return 'acumulado';
  }

  // 3. Caso contrário → crítico recente
  return 'critico';
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function getInadimplentes({ force = false } = {}) {
  const transactions = await fetchTransactions(force);
  const hoje = new Date();
  const hojeISO = hoje.toISOString().slice(0, 10);

  // Agrupa por cliente (chave: nome normalizado)
  const byCliente = new Map();
  for (const t of transactions) {
    if (!isParcelaValida(t)) continue;
    if (!isAtrasada(t, hojeISO)) continue;

    const nomeNorm = normNome(t.name || t.customer_name || '(sem nome)');
    let cluster = byCliente.get(nomeNorm);
    if (!cluster) {
      cluster = {
        cliente: t.name || t.customer_name || '(sem nome)',
        cpf: null,
        parcelas: 0,
        valorTotal: 0,
        primeiraAtraso: null,  // data da parcela mais antiga
        ultimaAtraso: null,
        diasAtraso: null,      // dias desde a primeira atrasada
        lawsuits: new Map(),   // lawsuit_id -> process_number
        transactions: [],
      };
      byCliente.set(nomeNorm, cluster);
    }
    cluster.parcelas += 1;
    cluster.valorTotal += Number(t.amount || 0);
    if (!cluster.primeiraAtraso || t.date_due < cluster.primeiraAtraso) {
      cluster.primeiraAtraso = t.date_due;
    }
    if (!cluster.ultimaAtraso || t.date_due > cluster.ultimaAtraso) {
      cluster.ultimaAtraso = t.date_due;
    }
    if (t.identification) cluster.cpf = t.identification;
    const lid = t.lawsuit_id || t.lawsuits_id;
    if (lid) cluster.lawsuits.set(String(lid), t.process_number || null);
    cluster.transactions.push({
      date_due: t.date_due,
      amount: Number(t.amount || 0),
      category: t.category || null,
      lawsuit_id: lid || null,
      process_number: t.process_number || null,
    });
  }

  // Calcula diasAtraso e classifica
  const criticosRecentes = [];
  const acumulados = [];
  for (const cluster of byCliente.values()) {
    cluster.diasAtraso = diasEntre(cluster.primeiraAtraso, hoje);
    cluster.valorTotal = Number(cluster.valorTotal.toFixed(2));
    cluster.lawsuits = [...cluster.lawsuits.entries()].map(([id, pn]) => ({ id: Number(id), process_number: pn }));
    const bucket = classificar(cluster);
    cluster.categoria = bucket;
    if (bucket === 'critico') criticosRecentes.push(cluster);
    else acumulados.push(cluster);
  }

  // Ordena: mais grave primeiro (acumulados por dias, críticos por valor)
  criticosRecentes.sort((a, b) => b.valorTotal - a.valorTotal);
  acumulados.sort((a, b) => (b.diasAtraso || 0) - (a.diasAtraso || 0));

  const totais = {
    totalDevedores: byCliente.size,
    totalDevido: Number([...byCliente.values()].reduce((s, c) => s + c.valorTotal, 0).toFixed(2)),
    totalParcelasAtrasadas: [...byCliente.values()].reduce((s, c) => s + c.parcelas, 0),
    qtdCriticos: criticosRecentes.length,
    qtdAcumulados: acumulados.length,
    valorCriticos: Number(criticosRecentes.reduce((s, c) => s + c.valorTotal, 0).toFixed(2)),
    valorAcumulados: Number(acumulados.reduce((s, c) => s + c.valorTotal, 0).toFixed(2)),
  };

  return {
    geradoEm: new Date().toISOString(),
    config: CFG,
    totais,
    criticosRecentes,
    acumulados,
  };
}

module.exports = { getInadimplentes, classificar, CFG };
