/**
 * Templates de auto-workflow.
 *
 * Quando a fase de um processo muda no AdvBox pra uma das fases mapeadas
 * abaixo, o engine `auto-workflow.js` cria automaticamente as tarefas
 * definidas aqui via POST /posts.
 *
 * Replica a ideia de "workflow nativo" do AdvBox, mas com auto-disparo
 * (que o AdvBox não tem — workflows nativos são só templates manuais).
 */

'use strict';

// IDs dos usuários do AdvBox (settings.users[].id)
const USERS = {
  EDUARDO:  198347,
  MARILIA:  213554,
  LETICIA:  214014,
  ALICE:    252099,
  CAU:      236523,  // Claudiana Maria Francisco
  TAMMYRES: 267371,
  THIAGO:   224040,
};

// Helper pra calcular date_deadline
function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Mapa: fase NORMALIZADA (maiúsculo, sem acento) → workflow.
 *
 * Cada workflow tem:
 *   - name: identificador único (usado pra deduplicar)
 *   - tasks: array de { task, user_id, prazo_dias }
 */
const TEMPLATES = {
  // ── Pós-laudo (transição da Tammyres) ────────────────────────────────────
  // Quando processo entra em "PARA DAR ENTRADA" (caminho ADM)
  'PARA DAR ENTRADA': {
    name: 'NOVO CASO ADM (auto)',
    tasks: [
      { task: 'PROTOCOLAR ADM',         user_id: USERS.MARILIA, prazo_dias: 2 },
    ],
  },
  // Quando processo entra em "ELABORAR PETICAO INICIAL" (caminho Judicial)
  'ELABORAR PETICAO INICIAL': {
    name: 'NOVO CASO JUDICIAL (auto)',
    tasks: [
      { task: 'ELABORAR PETIÇÃO INICIAL', user_id: USERS.LETICIA, prazo_dias: 3 },
      { task: 'PETICIONAR E PROTOCOLAR JUDICIAL', user_id: USERS.LETICIA, prazo_dias: 3 },
    ],
  },

  // ── Sentença ─────────────────────────────────────────────────────────────
  'SENTENCA PROCEDENTE VERIFICAR IMPLANTACAO': {
    name: 'SENTENÇA PROCEDENTE 100%',
    tasks: [
      { task: 'VERIFICAR IMPLANTAÇÃO NO INSS',           user_id: USERS.ALICE, prazo_dias: 90 },
      { task: 'CONFIRMAR IMPLANTAÇÃO + COBRAR HONORÁRIOS', user_id: USERS.CAU,   prazo_dias: 97 },
    ],
  },
  'PROCEDENTE EM PARTE FAZER RECURSO': {
    name: 'SENTENÇA PROCEDENTE PARCIAL',
    tasks: [
      { task: 'ANALISAR SENTENÇA + IDENTIFICAR PONTOS PRA RECURSO', user_id: USERS.ALICE,   prazo_dias: 2 },
      { task: 'PREPARAR RECURSO INOMINADO',                         user_id: USERS.LETICIA, prazo_dias: 9 },
      { task: 'PROTOCOLAR RECURSO',                                 user_id: USERS.LETICIA, prazo_dias: 10 },
    ],
  },
  'IMPROCEDENTE CABE RECURSO': {
    name: 'SENTENÇA IMPROCEDENTE - RECURSO',
    tasks: [
      { task: 'ANALISAR IMPROCEDÊNCIA + DECIDIR RECURSO', user_id: USERS.ALICE,   prazo_dias: 2 },
      { task: 'PREPARAR RECURSO',                         user_id: USERS.LETICIA, prazo_dias: 9 },
      { task: 'PROTOCOLAR RECURSO',                       user_id: USERS.LETICIA, prazo_dias: 10 },
    ],
  },

  // ── Financeiro (Cau) ─────────────────────────────────────────────────────
  // Tu disse: quem passa pra Cau é Marília (sal mat + implantado)
  // ou Alice (RPV).
  'SALARIO MATERNIDADE CONCEDIDO': {
    name: 'SAL. MATERNIDADE CONCEDIDO',
    tasks: [
      { task: 'PASSAR CASO PRA CAU (concessão + cliente)',  user_id: USERS.MARILIA, prazo_dias: 1 },
      { task: 'AGUARDAR PRIMEIRA GUIA PAGA',                user_id: USERS.CAU,     prazo_dias: 30 },
      { task: 'MOVER PROCESSO PRA SAL. MAT. PARCELADO',     user_id: USERS.CAU,     prazo_dias: 31 },
    ],
  },
  'JUDICIAL IMPLANTADO A RECEBER': {
    name: 'IMPLANTADO A RECEBER (Judicial)',
    tasks: [
      { task: 'PASSAR CASO PRA CAU (anexar dados/valores)', user_id: USERS.MARILIA, prazo_dias: 1 },
      { task: 'NEGOCIAR PARCELAMENTO',                      user_id: USERS.CAU,     prazo_dias: 6 },
      { task: 'CRIAR CONTRATO + LANÇAMENTOS',               user_id: USERS.CAU,     prazo_dias: 9 },
      { task: 'MOVER PROCESSO PRA PARCELADO',               user_id: USERS.CAU,     prazo_dias: 10 },
    ],
  },
  'ADM IMPLANTADO A RECEBER': {
    name: 'IMPLANTADO A RECEBER (ADM)',
    tasks: [
      { task: 'PASSAR CASO PRA CAU (anexar dados/valores)', user_id: USERS.MARILIA, prazo_dias: 1 },
      { task: 'NEGOCIAR PARCELAMENTO',                      user_id: USERS.CAU,     prazo_dias: 6 },
      { task: 'CRIAR CONTRATO + LANÇAMENTOS',               user_id: USERS.CAU,     prazo_dias: 9 },
      { task: 'MOVER PROCESSO PRA PARCELADO',               user_id: USERS.CAU,     prazo_dias: 10 },
    ],
  },
  'RPV DO MES': {
    name: 'RPV DO MÊS',
    tasks: [
      { task: 'PASSAR CASO PRA CAU (RPV + valor + tribunal)', user_id: USERS.ALICE, prazo_dias: 1 },
      { task: 'VERIFICAR PAGAMENTO NO TRIBUNAL',              user_id: USERS.CAU,   prazo_dias: 8 },
      { task: 'COBRAR HONORÁRIOS',                            user_id: USERS.CAU,   prazo_dias: 11 },
    ],
  },
  'SALARIO MATERNIDADE PARCELADO': {
    name: 'COBRANÇA PARCELADA - SAL. MAT.',
    tasks: [
      { task: 'VERIFICAR PAGAMENTO DA PARCELA DO MÊS', user_id: USERS.CAU, prazo_dias: 30 },
      { task: 'COBRAR VIA WHATSAPP SE ATRASOU',         user_id: USERS.CAU, prazo_dias: 35 },
    ],
  },
  'JUDICIAL PARCELADO': {
    name: 'COBRANÇA PARCELADA - JUDICIAL',
    tasks: [
      { task: 'VERIFICAR PAGAMENTO DA PARCELA DO MÊS', user_id: USERS.CAU, prazo_dias: 30 },
      { task: 'COBRAR VIA WHATSAPP SE ATRASOU',         user_id: USERS.CAU, prazo_dias: 35 },
    ],
  },
  'ADM PARCELADO': {
    name: 'COBRANÇA PARCELADA - ADM',
    tasks: [
      { task: 'VERIFICAR PAGAMENTO DA PARCELA DO MÊS', user_id: USERS.CAU, prazo_dias: 30 },
      { task: 'COBRAR VIA WHATSAPP SE ATRASOU',         user_id: USERS.CAU, prazo_dias: 35 },
    ],
  },
};

module.exports = { TEMPLATES, USERS, daysFromNow };
