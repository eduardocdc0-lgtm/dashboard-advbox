/**
 * Configuração da Esteira Financeira — fases do CRM Financeiro do AdvBox.
 *
 * Cada stage é uma fase visível na esteira financeira (separada das fases
 * de processo do auditor). Cada um tem um modo de tratamento:
 *
 *   parcela_fixa  → cada cliente paga UMA parcela fixa por mês (ex: 30% SM)
 *   em_aberto     → valor variável (calculado caso a caso, ex: implantado)
 *
 * Antes ficava inline em clients/dashboard/routes/esteira.js — mover pra cá
 * permite reuso (futuro) e mantém o route file só com lógica de handler.
 *
 * Quando o valor da parcela mudar (ex: novo piso de SM), editar APENAS aqui.
 * RPVs foram intencionalmente removidos — sua lógica fica no /api/audit/kanban-financeiro.
 */

'use strict';

const ESTEIRA_STAGES = Object.freeze([
  'SALARIO MATERNIDADE PARCELADO',
  'JUDICIAL PARCELADO',
  'ADM PARCELADO',
  'JUDICIAL IMPLANTADO A RECEBER',
  'ADM IMPLANTADO A RECEBER',
]);

// 30% SM (1 SM = R$ 1.621) = R$ 486,30
const ESTEIRA_RULES = Object.freeze({
  'SALARIO MATERNIDADE PARCELADO': { mode: 'parcela_fixa', valor: 486.30 },
  'JUDICIAL PARCELADO':            { mode: 'parcela_fixa', valor: 486.30 },
  'ADM PARCELADO':                 { mode: 'parcela_fixa', valor: 500 },
  'JUDICIAL IMPLANTADO A RECEBER': { mode: 'em_aberto' },
  'ADM IMPLANTADO A RECEBER':      { mode: 'em_aberto' },
});

module.exports = { ESTEIRA_STAGES, ESTEIRA_RULES };
