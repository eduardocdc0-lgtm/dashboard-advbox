/**
 * Placar de Sentenças — quantos processos viraram procedente/improcedente
 * num período (hoje / mês / ano).
 *
 * Fonte: AdvBox lawsuits[].stage + lawsuits[].stage_date.
 *
 * ⚠️ Limitação importante: stage_date é "quando entrou na fase ATUAL".
 * Se um processo já passou por PROCEDENTE e foi movido pra outra fase
 * (ex: ARQUIVADO/ENCERRADO), perdemos a referência temporal — esse processo
 * NÃO aparece no placar do dia que virou procedente. Pra histórico completo
 * vai precisar do snapshot diário (cron 23h) salvando estado no Postgres.
 *
 * Mapeamento de fase → categoria:
 *   PROCEDENTE:
 *     - ARQUIVADO - PROCEDENTE                           (já encerrado, vitorioso)
 *     - SENTENÇA PROCEDENTE VERIFICAR IMPLANTAÇÃO        (sentença saiu, aguarda INSS)
 *   IMPROCEDENTE:
 *     - ARQUIVADO - IMPROCEDENTE                         (perdeu, sem recurso)
 *     - SENTENÇA IMPROCEDENTE                            (perdeu, ainda em fase de recurso)
 *   PROCEDENTE_PARCIAL:
 *     - PROCEDENTE EM PARTE - FAZER RECURSO              (ganhou pedaço, vai recorrer)
 */

'use strict';

const { Router } = require('express');
const { requireAuth } = require('../../../middleware/auth');
const { fetchLawsuits } = require('../../../services/data');
const cache = require('../../../cache');

const router = Router();

cache.define('sentencas_placar', 15 * 60 * 1000); // 15 min — barato pq só agrupa

// Normaliza nome de fase pra comparação resiliente (acento/case/hífen)
function normFase(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const FASES_PROCEDENTE = [
  'ARQUIVADO PROCEDENTE',
  'SENTENCA PROCEDENTE VERIFICAR IMPLANTACAO',
].map(normFase);

const FASES_IMPROCEDENTE = [
  'ARQUIVADO IMPROCEDENTE',
  'SENTENCA IMPROCEDENTE',
].map(normFase);

const FASES_PARCIAL = [
  'PROCEDENTE EM PARTE FAZER RECURSO',
].map(normFase);

function classificar(stage) {
  const s = normFase(stage);
  if (FASES_PROCEDENTE.includes(s)) return 'procedente';
  if (FASES_IMPROCEDENTE.includes(s)) return 'improcedente';
  if (FASES_PARCIAL.includes(s)) return 'parcial';
  return null;
}

/**
 * Calcula timestamps de início pra cada janela em America/Recife (-03:00).
 * Extrai y/m/d via Intl no fuso do escritório (servidor Replit roda em UTC —
 * sem isso "hoje" começaria à meia-noite UTC = 21h do dia anterior em Recife).
 */
function rangesFromNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Recife', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const y = Number(parts.find(p => p.type === 'year').value);
  const m = Number(parts.find(p => p.type === 'month').value) - 1;
  const d = Number(parts.find(p => p.type === 'day').value);
  // America/Recife = UTC-3 fixo (sem DST). ISO com offset explícito converte
  // corretamente pra UTC ms sem depender do fuso do servidor.
  const midnight = (yr, mo, da) =>
    new Date(`${yr}-${String(mo + 1).padStart(2, '0')}-${String(da).padStart(2, '0')}T00:00:00-03:00`).getTime();
  return {
    hoje: midnight(y, m, d),
    mes:  midnight(y, m, 1),
    ano:  midnight(y, 0, 1),
  };
}

/**
 * Parse de stage_date robusto. AdvBox às vezes manda ISO, às vezes "dd/mm/yyyy",
 * às vezes vazio. Retorna timestamp ou NaN.
 */
function parseStageDate(raw) {
  if (!raw) return NaN;
  const s = String(raw);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s).getTime();
  if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) {
    const [d, m, y] = s.slice(0, 10).split('/').map(Number);
    return new Date(y, m - 1, d).getTime();
  }
  return NaN;
}

/**
 * GET /api/sentencas/placar
 *   Retorna placar agregado dos 3 períodos (hoje / mês / ano) numa chamada só.
 *   Não aceita query — front-end já recebe tudo pronto pra pintar 3 colunas.
 *
 *   Query params:
 *     force=1  → ignora cache
 *
 * Response shape:
 *   {
 *     periodos: {
 *       hoje: { procedente, improcedente, parcial, total },
 *       mes:  { ... },
 *       ano:  { ... },
 *     },
 *     totalAtivos: <total de lawsuits considerados>,
 *     geradoEm: <ISO>,
 *   }
 */
router.get('/sentencas/placar', requireAuth, async (req, res, next) => {
  try {
    const force = req.query.force === '1';
    const data = await cache.getOrFetch('sentencas_placar', async () => {
      const lawsuits = await fetchLawsuits();
      const ranges = rangesFromNow();
      const zerados = () => ({ procedente: 0, improcedente: 0, parcial: 0, total: 0 });
      const periodos = { hoje: zerados(), mes: zerados(), ano: zerados() };

      for (const l of lawsuits) {
        const cat = classificar(l.stage || l.step || '');
        if (!cat) continue;

        const ts = parseStageDate(l.stage_date || l.stage_at || l.updated_at);
        if (isNaN(ts)) continue;

        for (const periodo of ['hoje', 'mes', 'ano']) {
          if (ts >= ranges[periodo]) {
            periodos[periodo][cat]++;
            periodos[periodo].total++;
          }
        }
      }

      return {
        periodos,
        totalAtivos: lawsuits.length,
        geradoEm: new Date().toISOString(),
      };
    }, force);

    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
