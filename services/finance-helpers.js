/**
 * Helpers financeiros — FONTE ÚNICA pra validações de dinheiro.
 *
 * Centraliza: isParcelaValida (antes duplicada em finance.js e inadimplentes.js),
 * validações de entrada (parcela), e sanitização de valores monetários
 * recebidos do ASAAS via webhook.
 *
 * Quando precisar mudar regra de "o que é parcela válida" ou ajustar limites,
 * EDITAR APENAS AQUI. Toda a área financeira consome desse módulo.
 */

'use strict';

// ── Limites de sanity check (anti-typo, anti-fraude) ─────────────────────────
const MAX_PARCELA_VALUE   = 1_000_000;   // R$ 1M por parcela
const MAX_TOTAL_PARCELAS  = 60;          // 5 anos de parcelamento
const MAX_PAYMENT_VALUE   = 10_000_000;  // R$ 10M por evento ASAAS (sanity)
const MIN_PARCELA_VALUE   = 1;           // ignora placeholders 0.01

// ── 1. Filtro de parcela válida (descarta lixo da API AdvBox) ────────────────

function isParcelaValida(t) {
  if (t.entry_type !== 'income') return false;
  const amt = Number(t.amount || 0);
  if (amt < MIN_PARCELA_VALUE) return false;  // 0.01 placeholder = "EXCLUIR/ARQUIVADO"
  const desc = String(t.description || t.notes || '').toUpperCase();
  if (desc.includes('EXCLUIR')) return false;
  if (desc.includes('ARQUIVADO')) return false;
  return true;
}

// ── 2. Validação de input do POST /finance/entries ───────────────────────────
// Retorna array de erros (vazio = ok). Pega typos antes de virar lançamento.

function validateEntryInput(b) {
  const errs = [];
  const pv = Number(b.parcela_value);
  if (!pv || pv <= 0) {
    errs.push('parcela_value inválido');
  } else if (pv > MAX_PARCELA_VALUE) {
    errs.push(`parcela_value de R$ ${pv.toLocaleString('pt-BR')} excede teto de R$ ${MAX_PARCELA_VALUE.toLocaleString('pt-BR')}. Confirme se não é typo.`);
  }
  const tp = Number(b.total_parcelas);
  if (b.kind === 'parcelado') {
    if (!tp || tp < 1) errs.push('total_parcelas obrigatório quando kind=parcelado');
    else if (tp > MAX_TOTAL_PARCELAS) errs.push(`total_parcelas (${tp}) excede ${MAX_TOTAL_PARCELAS}. Typo?`);
  }
  // E-mail (se passado) — validação leve
  if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email).trim())) {
    errs.push('email inválido');
  }
  return errs;
}

// ── 3. Sanitização de valor monetário do ASAAS (webhook) ─────────────────────
// Retorna número válido (≥ 0, ≤ MAX_PAYMENT_VALUE, finite) ou null.

function validatePaymentValue(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;                    // refunds NÃO tratados aqui
  if (n > MAX_PAYMENT_VALUE) return null;    // anomalia, ignora silenciosamente
  return n;
}

// ── 4. Validação leve de CPF/CNPJ (presença + tamanho) ───────────────────────
// Não valida dígito verificador (TODO futuro) — só estrutura.

function sanitizeCpfCnpj(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 || digits.length === 14) return digits;
  return null;  // inválido
}

module.exports = {
  isParcelaValida,
  validateEntryInput,
  validatePaymentValue,
  sanitizeCpfCnpj,
  MAX_PARCELA_VALUE,
  MAX_TOTAL_PARCELAS,
  MAX_PAYMENT_VALUE,
};
