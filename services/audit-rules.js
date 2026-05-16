/**
 * Regras de auditoria de uso do AdvBox.
 *
 * Portado de /scripts/audit (Python) — versão Node.js integrada ao dashboard.
 * Cada constante explica o que ela faz e onde é usada.
 */

'use strict';

// ── CADASTRO ─────────────────────────────────────────────────────────────────

// Cadastro de cliente NÃO é problema do advogado.
// Quando o papel "controller" entrar (Alice), reativamos pra ela ver.
const CAMPOS_OBRIGATORIOS_CLIENTE = [];
const CAMPOS_RECOMENDADOS_CLIENTE = [];

const CAMPOS_OBRIGATORIOS_PROCESSO = [
  'responsible_id',
  'customers',
  'stages_id',
  'type_lawsuit_id',
];

const CAMPOS_OBRIGATORIOS_TAREFA = ['users', 'task'];
// Descrição muito curta é ruído (tarefas geradas por bot/sistema ficam com notes vazio).
// Desativado por enquanto.
const EXIGE_DESCRICAO_TAREFA = false;
const TAMANHO_MINIMO_DESCRICAO_TAREFA = 10;

const DIAS_PROCESSO_SEM_MOVIMENTACAO = 60;

// ── WORKFLOW ─────────────────────────────────────────────────────────────────

const META_PETICOES_SEMANA = 5;

// Heurística de petição (portada de petitions.js)
const PREFIXOS_PETICAO = [
  'AJUIZAR', 'PETICIONAR', 'ELABORAR PETICAO',
  'ELABORAR RECURSO', 'RECURSO DE', 'CONTESTACAO',
  'MANIFESTACAO', 'CUMPRIMENTO DE SENTENCA',
  'IMPUGNACAO', 'EMBARGOS',
];

const PREFIXOS_NAO_PETICAO = [
  'PROTOCOLAR ADM', 'COMENTARIO', 'ANALISAR',
  'LIGAR', 'ENVIAR',
];

// SLA por fase normalizada. Fase não listada = não audita.
const SLA_POR_FASE = {
  // Preparação documental (Tammyres)
  'FALTA LAUDO FAZER PREVDOC':                7,
  'FALTA LAUDO':                              7,
  'PREVDOC':                                  7,

  // ADM (Marília)
  'PARA DAR ENTRADA':                         5,
  // 'PROTOCOLADO ADM' — REMOVIDO: espera INSS responder
  // 'PROTOCOLADO' — REMOVIDO: espera INSS responder
  // 'EM ANALISE PERICIAS FEITAS' — REMOVIDO: lógico (espera resultado)
  // 'AUXILIO INCAPACIDADE' — REMOVIDO: lógico (Eduardo confirmou)
  'PROCESSOS SEM LAUDOS':                    14,
  'PROCESSO COM GUARDA BPC':                 30,
  // 'PERICIA MARCADA SEM DATA DE AUDIENCIA' — REMOVIDO: espera passiva
  // 'CANCELADO REQUERIMENTO' — REMOVIDO: Eduardo confirmou que NUNCA é erro
  //   (INSS cancelou, semi-arquivado, cliente decide o que fazer). Sem SLA.
  // SALARIO MATERNIDADE (todas as fases) — REMOVIDO: Eduardo confirmou que é tudo certo
  // 'SALARIO MATERNIDADE GUIA PAGA' / '5 7 MESES' / '3 5 MESES' / '1 A 3 MESES' / 'SALARIO MATERNIDADE'

  // Judicial (Letícia / Alice)
  'ELABORAR PETICAO INICIAL':                10,
  // 'PROTOCOLADO JUDICIAL' — REMOVIDO: espera tribunal
  'COM PRAZO':                                5,
  // 'PERICIA SOCIAL MARCADA' — REMOVIDO: espera passiva (perícia agendada)
  'SENTENCA PROCEDENTE VERIFICAR IMPLANTACAO': 15,
  'SENTENCA IMPROCEDENTE':                   10,
  'PROCEDENTE EM PARTE FAZER RECURSO':       10,
  'IMPROCEDENTE CABE RECURSO':               10,
  'DESENVOLVENDO RECURSO AOS TRIBUNAIS':     15,
  'RECURSO PROTOCOLADO INICIADO':            90,
  'APRESENTADA RESPOSTA A RECURSO':          60,
  // 'AGUARDANDO JULGAMENTO DO RECURSO' — REMOVIDO: espera tribunal
  'RECURSO JULGADO ENTRE EM CONTATO':         7,
  'TRANSITO EM JULGADO NAO CABE RECURSO':    15,
  // 'AGUARDANDO EXPEDICAO DE RPV' — REMOVIDO: espera tribunal expedir
  'FAZER ACAO DE GUARDA':                    15,

  // Compartilhadas
  // 'PERICIA MEDICA MARCADA' — REMOVIDO: espera passiva (perícia agendada)
  // 'PERICIAS MARCADAS' — REMOVIDO: espera passiva

  // Financeiro (Cau) — TODAS REMOVIDAS
  // Essas fases são tratadas pela rota /api/audit/kanban-financeiro
  // (aba "Auditoria" no menu — a antiga, que a Cau já usa).
  // Não duplicar aqui. Cau não vê alerta nenhum nessa Auditoria de Uso.

  // Trabalhista (Eduardo)
  'TRABALHISTA':                             60,
};

// Mapa de fase → zona responsável (pra detectar processo no responsável errado).
const RESPONSAVEL_POR_FASE = {
  // MARILIA
  'PROCESSOS SEM LAUDOS': 'MARILIA',
  'PERICIA MARCADA SEM DATA DE AUDIENCIA': 'MARILIA',
  'PARA DAR ENTRADA': 'MARILIA',
  'PROTOCOLADO ADM': 'MARILIA',
  'PROTOCOLADO': 'MARILIA',
  'AUXILIO INCAPACIDADE': 'MARILIA',
  'PROCESSO COM GUARDA BPC': 'MARILIA',
  'EM ANALISE PERICIAS FEITAS': 'MARILIA',
  'SALARIO MATERNIDADE GUIA PAGA': 'MARILIA',
  'SALARIO MATERNIDADE 5 7 MESES': 'MARILIA',
  'SALARIO MATERNIDADE 3 5 MESES': 'MARILIA',
  'SALARIO MATERNIDADE 1 A 3 MESES': 'MARILIA',
  'SALARIO MATERNIDADE': 'MARILIA',
  // 'CANCELADO REQUERIMENTO' — REMOVIDO: INSS que cancelou, semi-arquivado, sem
  // responsável obrigatório. Cada caso vai depender de decisão do cliente.
  // LETICIA_OU_ALICE
  'ELABORAR PETICAO INICIAL': 'LETICIA_OU_ALICE',
  'SENTENCA PROCEDENTE VERIFICAR IMPLANTACAO': 'LETICIA_OU_ALICE',
  'PERICIA SOCIAL MARCADA': 'LETICIA_OU_ALICE',
  'COM PRAZO': 'LETICIA_OU_ALICE',
  'SENTENCA IMPROCEDENTE': 'LETICIA_OU_ALICE',
  'PROTOCOLADO JUDICIAL': 'LETICIA_OU_ALICE',
  'AGUARDANDO EXPEDICAO DE RPV': 'LETICIA_OU_ALICE',
  'FAZER ACAO DE GUARDA': 'LETICIA_OU_ALICE',
  // Recursos — movidos pra RESPONSAVEL_POR_FASE_MULTI (Marília E Letícia/Alice
  // ambos válidos, porque recurso pode ser ADM ou Judicial).
  // CAU
  'SALARIO MATERNIDADE PARCELADO': 'CAU',
  'JUDICIAL PARCELADO': 'CAU',
  'ADM PARCELADO': 'CAU',
  'RPV DO MES': 'CAU',
  'RPV DO PROXIMO MES': 'CAU',
  'JUDICIAL IMPLANTADO A RECEBER': 'CAU',
  'ADM IMPLANTADO A RECEBER': 'CAU',
  'SALARIO MATERNIDADE CONCEDIDO': 'CAU',
  'BENEFICIO CONCEDIDO AGUARDAR': 'CAU',
  // TAMMYRES
  'FALTA LAUDO FAZER PREVDOC': 'TAMMYRES',
  'FALTA LAUDO': 'TAMMYRES',
  'PREVDOC': 'TAMMYRES',
  // EDUARDO
  'TRABALHISTA': 'EDUARDO',
};

const RESPONSAVEL_POR_FASE_MULTI = {
  'PERICIA MEDICA MARCADA': ['MARILIA', 'LETICIA_OU_ALICE'],
  'PERICIAS MARCADAS': ['MARILIA', 'LETICIA_OU_ALICE'],
  // Recursos — podem ser ADM (Marília) ou Judicial (Letícia/Alice)
  'PROCEDENTE EM PARTE FAZER RECURSO': ['MARILIA', 'LETICIA_OU_ALICE'],
  'IMPROCEDENTE CABE RECURSO':         ['MARILIA', 'LETICIA_OU_ALICE'],
  'DESENVOLVENDO RECURSO AOS TRIBUNAIS': ['MARILIA', 'LETICIA_OU_ALICE'],
  'RECURSO PROTOCOLADO INICIADO':      ['MARILIA', 'LETICIA_OU_ALICE'],
  'APRESENTADA RESPOSTA A RECURSO':    ['MARILIA', 'LETICIA_OU_ALICE'],
  'AGUARDANDO JULGAMENTO DO RECURSO':  ['MARILIA', 'LETICIA_OU_ALICE'],
  'RECURSO JULGADO ENTRE EM CONTATO':  ['MARILIA', 'LETICIA_OU_ALICE'],
  'TRANSITO EM JULGADO NAO CABE RECURSO': ['MARILIA', 'LETICIA_OU_ALICE'],
};

const FASES_IGNORADAS_RESPONSAVEL = new Set([
  'IGNORAR ESSA ETAPA',
  'ARQUIVADO IMPROCEDENTE',
  'ARQUIVADO PROCEDENTE',
  'ARQUIVADO POR DETERMINACAO JUDICIAL',
  'ARQUIVADO ENCERRADO',
  // INSS cancelou — qualquer responsável é aceitável, cliente que decide
  'CANCELADO REQUERIMENTO',
]);

// Fases que indicam processo INATIVO. Usado pra contar "processos ativos".
// IMPORTANTE: o campo `status_closure` da API do AdvBox NÃO indica
// encerramento — fica preenchido mesmo em processos ativos. Filtramos só pela fase.
const FASES_INATIVAS = new Set([
  'ARQUIVADO - PROCEDENTE',
  'ARQUIVADO - IMPROCEDENTE',
  'ARQUIVADO/ENCERRADO',
  'ARQUIVADO POR DETERMINACAO JUDICIAL',
  'IGNORAR ESSA ETAPA',
  'CANCELADO REQUERIMENTO',
]);

const ZONAS_QUE_PETICIONAM = new Set(['LETICIA_OU_ALICE', 'EDUARDO']);

// ── Labels humanos das zonas (pra exibição) ──────────────────────────────────
const ZONE_LABELS = {
  MARILIA:          'Ana Marília',
  LETICIA_OU_ALICE: 'Letícia ou Alice',
  CAU:              'Claudiana (Cau)',
  TAMMYRES:         'Tammyres',
  EDUARDO:          'Eduardo',
};

// ── Normalização única de fase ────────────────────────────────────────────────
// Versão agressiva: NFD + strip acento + upper + non-alphanumeric→espaço.
// Importante pra bater fases tipo "Procedente em parte - Fazer recurso" contra
// chaves "PROCEDENTE EM PARTE FAZER RECURSO".
function normalizeStage(s) {
  return (s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Mapas pré-normalizados pra lookup O(1)
const _RESPONSAVEL_NORMALIZED = {};
for (const [stage, zone] of Object.entries(RESPONSAVEL_POR_FASE)) {
  _RESPONSAVEL_NORMALIZED[normalizeStage(stage)] = zone;
}
const _MULTI_NORMALIZED = {};
for (const [stage, zones] of Object.entries(RESPONSAVEL_POR_FASE_MULTI)) {
  _MULTI_NORMALIZED[normalizeStage(stage)] = zones;
}
const _SKIP_NORMALIZED = new Set();
for (const stage of FASES_IGNORADAS_RESPONSAVEL) {
  _SKIP_NORMALIZED.add(normalizeStage(stage));
}

// ── Helpers de zona/responsável ───────────────────────────────────────────────
// (lookup que aceita variações de pontuação na fase, com fallback de prefixo)

function getResponsavelZone(stage) {
  const n = normalizeStage(stage);
  if (_RESPONSAVEL_NORMALIZED[n]) return _RESPONSAVEL_NORMALIZED[n];
  // Fallback: prefixo (4 primeiras palavras) ou startsWith bidirecional
  const nW4 = n.split(' ').slice(0, 4).join(' ');
  for (const [mapped, zone] of Object.entries(_RESPONSAVEL_NORMALIZED)) {
    const mW4 = mapped.split(' ').slice(0, 4).join(' ');
    if (nW4 === mW4 && nW4.length > 5) return zone;
    if (n.startsWith(mapped) || mapped.startsWith(n)) return zone;
  }
  return null;
}

function getResponsavelZonesMulti(stage) {
  const n = normalizeStage(stage);
  if (_MULTI_NORMALIZED[n]) return _MULTI_NORMALIZED[n];
  for (const [mapped, zones] of Object.entries(_MULTI_NORMALIZED)) {
    if (n.startsWith(mapped) || mapped.startsWith(n)) return zones;
  }
  return null;
}

function isStageSkippedForResponsavel(stage) {
  return _SKIP_NORMALIZED.has(normalizeStage(stage));
}

function getZoneForResp(responsibleName) {
  const n = normalizeStage(responsibleName);
  if (n.includes('MARILIA'))                        return 'MARILIA';
  if (n.includes('LETICIA') || n.includes('ALICE')) return 'LETICIA_OU_ALICE';
  if (n.includes('CLAUDIANA') || n.includes('CAU')) return 'CAU';
  if (n.includes('TAMMYRES'))                       return 'TAMMYRES';
  if (n.includes('EDUARDO'))                        return 'EDUARDO';
  return null;
}

// Palavras-chave que indicam que um responsável (nome real no AdvBox)
// pertence a uma zona. Ex: zona LETICIA_OU_ALICE aceita nomes que
// contenham "LETICIA" ou "ALICE".
const ZONA_KEYWORDS = {
  MARILIA:          ['MARILIA'],
  LETICIA_OU_ALICE: ['LETICIA', 'ALICE'],
  CAU:              ['CAU', 'CLAUDIANA'],
  TAMMYRES:         ['TAMMYRES'],
  EDUARDO:          ['EDUARDO'],
};

// ── QUALIDADE ────────────────────────────────────────────────────────────────

const LIMITE_VERDE = 90.0;
const LIMITE_AMARELO = 70.0;

module.exports = {
  CAMPOS_OBRIGATORIOS_CLIENTE,
  CAMPOS_RECOMENDADOS_CLIENTE,
  CAMPOS_OBRIGATORIOS_PROCESSO,
  CAMPOS_OBRIGATORIOS_TAREFA,
  EXIGE_DESCRICAO_TAREFA,
  TAMANHO_MINIMO_DESCRICAO_TAREFA,
  DIAS_PROCESSO_SEM_MOVIMENTACAO,
  META_PETICOES_SEMANA,
  PREFIXOS_PETICAO,
  PREFIXOS_NAO_PETICAO,
  SLA_POR_FASE,
  RESPONSAVEL_POR_FASE,
  RESPONSAVEL_POR_FASE_MULTI,
  FASES_IGNORADAS_RESPONSAVEL,
  FASES_INATIVAS,
  ZONAS_QUE_PETICIONAM,
  ZONA_KEYWORDS,
  ZONE_LABELS,
  LIMITE_VERDE,
  LIMITE_AMARELO,
  // Helpers — fonte única pra qualquer consumer (audit.js, auditor.js, etc)
  normalizeStage,
  getResponsavelZone,
  getResponsavelZonesMulti,
  isStageSkippedForResponsavel,
  getZoneForResp,
};
