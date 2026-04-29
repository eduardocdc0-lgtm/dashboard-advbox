const { Router }  = require('express');
const multer       = require('multer');
const mammoth      = require('mammoth');
const { requireAdmin } = require('../../../middleware/auth');
const { fetchLawsuits }= require('../../../services/data');
const { query: dbQuery } = require('../../../services/db');

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ── Fases válidas ─────────────────────────────────────────────────────────────

const FASES_ADM = [
  'PERICIAS MARCADAS','EM ANALISE PERICIAS FEITAS','PROCESSOS SEM LAUDOS',
  'PERICIA MARCADA SEM DATA DE AUDIENCIA','PERICIA MARCADA SEM DATA','PROTOCOLADO ADM',
  'AUXILIO INCAPACIDADE','PROCESSO COM GUARDA BPC','PROCESSO COM GUARDA',
  'PERICIA MEDICA MARCADA',
];

const FASES_CONCLUIDO = {
  JUDICIAL:     ['ELABORAR PETICAO INICIAL','PERICIA MEDICA MARCADA','SENTENCA PROCEDENTE VERIFICAR IMPLANTACAO','PERICIA SOCIAL MARCADA','COM PRAZO','SENTENCA IMPROCEDENTE','PROTOCOLADO JUDICIAL','AGUARDANDO EXPEDICAO DE RPV','FAZER ACAO DE GUARDA','BENEFICIO CONCEDIDO AGUARDAR','ANALISADO E NAO DISTRIBUIDO','PROCEDENTE EM PARTE FAZER RECURSO','IMPROCEDENTE CABE RECURSO','DESENVOLVENDO RECURSO AOS TRIBUNAIS','RECURSO PROTOCOLADO INICIADO','APRESENTADA RESPOSTA A RECURSO','AGUARDANDO JULGAMENTO DO RECURSO','RECURSO JULGADO ENTRE EM CONTATO','TRANSITO EM JULGADO NAO CABE RECURSO'],
  FINANCEIRO:   ['SALARIO MATERNIDADE PARCELADO','JUDICIAL PARCELADO','ADM PARCELADO','RPV DO MES','RPV DO PROXIMO MES','JUDICIAL IMPLANTADO A RECEBER','ADM IMPLANTADO A RECEBER','SALARIO MATERNIDADE CONCEDIDO'],
  ARQUIVAMENTO: ['ARQUIVADO IMPROCEDENTE','ARQUIVADO PROCEDENTE','ARQUIVADO POR DETERMINACAO JUDICIAL','IGNORAR ESSA ETAPA','CANCELADO REQUERIMENTO','ARQUIVADO ENCERRADO'],
};
const FASES_CONCLUIDO_FLAT = Object.values(FASES_CONCLUIDO).flat();

// ── Normalização de texto ─────────────────────────────────────────────────────

function norm(s) {
  return (s || '').toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function normFase(s) { return norm(s); }

function faseValida(stage, category) {
  const sn = normFase(stage);
  if (category === 'ANALISE' || category === 'EXIGENCIA') {
    return FASES_ADM.some(f => { const fn = norm(f); return sn === fn || sn.startsWith(fn) || fn.startsWith(sn); });
  }
  if (category === 'CONCLUIDO') {
    return FASES_CONCLUIDO_FLAT.some(f => { const fn = norm(f); return sn === fn || sn.startsWith(fn) || fn.startsWith(sn); });
  }
  return false;
}

function grupoFaseConcluido(stage) {
  const sn = normFase(stage);
  for (const [grupo, fases] of Object.entries(FASES_CONCLUIDO)) {
    if (fases.some(f => { const fn = norm(f); return sn === fn || sn.startsWith(fn) || fn.startsWith(sn); })) return grupo;
  }
  return null;
}

// ── Parsear .docx → lista de nomes ───────────────────────────────────────────

const CPF_RE = /^\d{3}[.\s]\d{3}[.\s]\d{3}[-\s]\d{2}$/;

async function parseDocxNames(buffer) {
  if (!buffer || !buffer.length) return [];
  const { value } = await mammoth.extractRawText({ buffer });
  const lines = value.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const names = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\s+/g, ' ').trim();
    if (CPF_RE.test(line) && i > 0) {
      const candidate = lines[i - 1].trim();
      // Nome deve estar em maiúsculas ou conter letras maiúsculas predominantemente
      if (candidate && candidate.length > 4 && /[A-ZÁÉÍÓÚÀÂÊÔÃÕ]/.test(candidate)) {
        names.push(candidate.toUpperCase());
      }
    }
  }
  return [...new Set(names)]; // deduplica
}

// ── Matching de nomes ─────────────────────────────────────────────────────────

function matchNome(inssName, lookup) {
  const n = norm(inssName);
  if (lookup.has(n)) return { match: lookup.get(n), tipo: 'exato' };
  // Parcial: todas as palavras do nome menor estão no nome maior
  for (const [key, val] of lookup) {
    const wordsN = n.split(' ');
    const wordsK = key.split(' ');
    const [shorter, longer] = wordsN.length <= wordsK.length ? [wordsN, wordsK] : [wordsK, wordsN];
    if (shorter.length >= 2 && shorter.every(w => w.length > 2 && longer.includes(w))) {
      return { match: val, tipo: 'parcial' };
    }
  }
  return null;
}

// ── Rota principal ────────────────────────────────────────────────────────────

router.post('/inss-conference/run', requireAdmin,
  upload.fields([
    { name: 'analise',   maxCount: 1 },
    { name: 'exigencia', maxCount: 1 },
    { name: 'concluidos',maxCount: 1 },
  ]),
  async (req, res, next) => {
    try {
      const files = req.files || {};

      // Parse nomes de cada arquivo
      const [nomesAnalise, nomesExigencia, nomesConcluidos] = await Promise.all([
        files.analise?.[0]   ? parseDocxNames(files.analise[0].buffer)    : [],
        files.exigencia?.[0] ? parseDocxNames(files.exigencia[0].buffer)  : [],
        files.concluidos?.[0]? parseDocxNames(files.concluidos[0].buffer) : [],
      ]);

      // Buscar todos os processos do AdvBox
      const rawData  = await fetchLawsuits();
      const lawsuits = Array.isArray(rawData) ? rawData : (rawData.data || []);

      // Montar lookup: nomaNormalizado → [{ cliente, stage, responsible, id }]
      const lookup = new Map();
      for (const l of lawsuits) {
        const customers = Array.isArray(l.customers) ? l.customers : [];
        for (const c of customers) {
          if (!c.name) continue;
          const key = norm(c.name);
          if (!lookup.has(key)) lookup.set(key, []);
          lookup.get(key).push({
            cliente:     c.name,
            stage:       l.stage || l.step || '',
            responsible: l.responsible || '',
            id:          l.id,
            link:        `https://app.advbox.com.br/lawsuit/${l.id}`,
          });
        }
      }

      // Processar cada categoria
      function processCategoria(nomes, category) {
        return nomes.map(inssNome => {
          const result = matchNome(inssNome, lookup);
          if (!result) return { inssNome, category, status: 'NAO_ENCONTRADO', matchTipo: null, advbox: null };
          const advbox = result.match[0]; // pegar o processo mais recente (primeiro)
          const valido = faseValida(advbox.stage, category);
          return {
            inssNome, category,
            status:    valido ? 'CORRETO' : 'DIVERGENTE',
            matchTipo: result.tipo,
            advbox,
          };
        });
      }

      const todos = [
        ...processCategoria(nomesAnalise,   'ANALISE'),
        ...processCategoria(nomesExigencia,  'EXIGENCIA'),
        ...processCategoria(nomesConcluidos, 'CONCLUIDO'),
      ];

      const totalAnalisados  = todos.length;
      const coerentes        = todos.filter(r => r.status === 'CORRETO').length;
      const divergentes      = todos.filter(r => r.status === 'DIVERGENTE').length;
      const naoEncontrados   = todos.filter(r => r.status === 'NAO_ENCONTRADO').length;

      // Gravar histórico
      await dbQuery(
        `INSERT INTO inss_conference_log (total, coerentes, divergentes, nao_encontrados, detalhes)
         VALUES ($1, $2, $3, $4, $5)`,
        [totalAnalisados, coerentes, divergentes, naoEncontrados,
         JSON.stringify({ arquivos: { analise: nomesAnalise.length, exigencia: nomesExigencia.length, concluidos: nomesConcluidos.length } })]
      );

      // Montar fases sugeridas por categoria
      function fasesSugeridas(category) {
        if (category === 'ANALISE' || category === 'EXIGENCIA') return FASES_ADM.slice(0,7).join(', ');
        return 'Qualquer fase Judicial, Financeiro ou Arquivamento';
      }

      const itens = todos.map(r => ({
        ...r,
        fasesSugeridas: fasesSugeridas(r.category),
        grupoAdvbox:    r.advbox ? grupoFaseConcluido(r.advbox.stage) : null,
      }));

      res.json({
        resumo: { totalAnalisados, coerentes, divergentes, naoEncontrados },
        itens,
        arquivos: { analise: nomesAnalise.length, exigencia: nomesExigencia.length, concluidos: nomesConcluidos.length },
        geradoEm: new Date().toISOString(),
      });

    } catch (err) { next(err); }
  }
);

// ── Histórico ─────────────────────────────────────────────────────────────────

router.get('/inss-conference/history', requireAdmin, async (req, res, next) => {
  try {
    const result = await dbQuery(
      `SELECT id, total, coerentes, divergentes, nao_encontrados, detalhes, conferido_em
       FROM inss_conference_log ORDER BY conferido_em DESC LIMIT 50`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

module.exports = router;
