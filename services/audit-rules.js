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
  'PROTOCOLADO ADM':                         90,
  'PROTOCOLADO':                             90,
  'EM ANALISE PERICIAS FEITAS':              30,
  'AUXILIO INCAPACIDADE':                    30,
  'PROCESSOS SEM LAUDOS':                    14,
  'PROCESSO COM GUARDA BPC':                 30,
  'PERICIA MARCADA SEM DATA DE AUDIENCIA':   45,
  'CANCELADO REQUERIMENTO':                  10,
  'SALARIO MATERNIDADE GUIA PAGA':           15,
  'SALARIO MATERNIDADE 5 7 MESES':           30,
  'SALARIO MATERNIDADE 3 5 MESES':           30,
  'SALARIO MATERNIDADE 1 A 3 MESES':         30,
  'SALARIO MATERNIDADE':                     30,

  // Judicial (Letícia / Alice)
  'ELABORAR PETICAO INICIAL':                10,
  'PROTOCOLADO JUDICIAL':                    60,
  'COM PRAZO':                                5,
  'PERICIA SOCIAL MARCADA':                  45,
  'SENTENCA PROCEDENTE VERIFICAR IMPLANTACAO': 15,
  'SENTENCA IMPROCEDENTE':                   10,
  'PROCEDENTE EM PARTE FAZER RECURSO':       10,
  'IMPROCEDENTE CABE RECURSO':               10,
  'DESENVOLVENDO RECURSO AOS TRIBUNAIS':     15,
  'RECURSO PROTOCOLADO INICIADO':            90,
  'APRESENTADA RESPOSTA A RECURSO':          60,
  'AGUARDANDO JULGAMENTO DO RECURSO':       120,
  'RECURSO JULGADO ENTRE EM CONTATO':         7,
  'TRANSITO EM JULGADO NAO CABE RECURSO':    15,
  'AGUARDANDO EXPEDICAO DE RPV':             60,
  'FAZER ACAO DE GUARDA':                    15,

  // Compartilhadas
  'PERICIA MEDICA MARCADA':                  45,
  'PERICIAS MARCADAS':                       45,

  // Financeiro (Cau)
  'BENEFICIO CONCEDIDO AGUARDAR':            30,
  'SALARIO MATERNIDADE CONCEDIDO':           30,
  'IMPLANTADO A RECEBER':                    30,
  'JUDICIAL IMPLANTADO A RECEBER':           30,
  'ADM IMPLANTADO A RECEBER':                30,
  'JUDICIAL PARCELADO':                      30,
  'ADM PARCELADO':                           30,
  'SALARIO MATERNIDADE PARCELADO':           30,
  'RPV DO MES':                              30,
  'RPV DO PROXIMO MES':                      60,

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
  'CANCELADO REQUERIMENTO': 'MARILIA',
  // LETICIA_OU_ALICE
  'ELABORAR PETICAO INICIAL': 'LETICIA_OU_ALICE',
  'SENTENCA PROCEDENTE VERIFICAR IMPLANTACAO': 'LETICIA_OU_ALICE',
  'PERICIA SOCIAL MARCADA': 'LETICIA_OU_ALICE',
  'COM PRAZO': 'LETICIA_OU_ALICE',
  'SENTENCA IMPROCEDENTE': 'LETICIA_OU_ALICE',
  'PROTOCOLADO JUDICIAL': 'LETICIA_OU_ALICE',
  'AGUARDANDO EXPEDICAO DE RPV': 'LETICIA_OU_ALICE',
  'FAZER ACAO DE GUARDA': 'LETICIA_OU_ALICE',
  'PROCEDENTE EM PARTE FAZER RECURSO': 'LETICIA_OU_ALICE',
  'IMPROCEDENTE CABE RECURSO': 'LETICIA_OU_ALICE',
  'DESENVOLVENDO RECURSO AOS TRIBUNAIS': 'LETICIA_OU_ALICE',
  'RECURSO PROTOCOLADO INICIADO': 'LETICIA_OU_ALICE',
  'APRESENTADA RESPOSTA A RECURSO': 'LETICIA_OU_ALICE',
  'AGUARDANDO JULGAMENTO DO RECURSO': 'LETICIA_OU_ALICE',
  'RECURSO JULGADO ENTRE EM CONTATO': 'LETICIA_OU_ALICE',
  'TRANSITO EM JULGADO NAO CABE RECURSO': 'LETICIA_OU_ALICE',
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
};

const FASES_IGNORADAS_RESPONSAVEL = new Set([
  'IGNORAR ESSA ETAPA',
  'ARQUIVADO IMPROCEDENTE',
  'ARQUIVADO PROCEDENTE',
  'ARQUIVADO POR DETERMINACAO JUDICIAL',
  'ARQUIVADO ENCERRADO',
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
  LIMITE_VERDE,
  LIMITE_AMARELO,
};
