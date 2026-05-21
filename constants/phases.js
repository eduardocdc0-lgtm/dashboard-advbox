/**
 * Nomes de fases (stages) do AdvBox usados em MAIS DE UM lugar no código.
 *
 * Por que isto existe: o nome da fase é a chave que vincula o auditor
 * (services/audit-rules.js) ao Controller (services/controller.js) e à
 * Esteira (constants/esteira.js). Quando esses strings divergiam por typo,
 * um deles parava de auditar a fase sem dar nenhum erro. Centralizar evita
 * essa classe de bug.
 *
 * CONVENÇÃO:
 *   - Chave  = nome do código, MAIÚSCULO com underscore (UPPER_SNAKE_CASE)
 *   - Valor  = string EXATA esperada do AdvBox (normalmente já em CAIXA-ALTA
 *              sem acento, porque o normalizeStage() em audit-rules.js
 *              strip-a acentos antes de comparar)
 *   - Variantes (com/sem acento) ficam no consumidor — alguns endpoints
 *     do AdvBox retornam acentuado, outros não.
 *
 * QUANDO ADICIONAR aqui: a fase é referenciada em DOIS ou mais arquivos.
 * Fases usadas apenas em audit-rules.js (a maioria das chaves do SLA_POR_FASE)
 * NÃO precisam vir pra cá — audit-rules é o ponto canônico delas.
 */

'use strict';

const PHASES = Object.freeze({
  // ── ADM (Marília) ──────────────────────────────────────────────────────────
  PARA_DAR_ENTRADA:            'PARA DAR ENTRADA',
  PROTOCOLAR_ADM:              'PROTOCOLAR ADM',
  PARA_DAR_ENTRADA_ADM:        'PARA DAR ENTRADA ADM',
  EM_EXIGENCIA:                'EM EXIGENCIA',
  EM_EXIGENCIA_ACENTUADO:      'EM EXIGÊNCIA',  // variante acentuada
  PROCESSOS_SEM_LAUDOS:        'PROCESSOS SEM LAUDOS',

  // ── Preparação documental (Tammyres) ───────────────────────────────────────
  PROCESSO_SEM_LAUDO:          'PROCESSO SEM LAUDO',
  FALTA_LAUDO:                 'FALTA LAUDO',
  FALTA_LAUDO_FAZER_PREVDOC:   'FALTA LAUDO - FAZER PREVDOC',
  FALTA_LAUDO_FAZER_PREVDOC_SEM_HIFEN: 'FALTA LAUDO FAZER PREVDOC', // variante usada em audit-rules
  PREVDOC:                     'PREVDOC',

  // ── Judicial (Letícia / Alice) ─────────────────────────────────────────────
  ELABORAR_PETICAO_INICIAL:           'ELABORAR PETICAO INICIAL',
  ELABORAR_PETICAO_INICIAL_ACENTUADO: 'ELABORAR PETIÇÃO INICIAL',
  COM_PRAZO:                          'COM PRAZO',
});

module.exports = { PHASES };
