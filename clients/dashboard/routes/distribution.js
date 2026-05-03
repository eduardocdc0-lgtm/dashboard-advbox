/**
 * Rota de distribuição por responsável.
 *
 * Bug fix: removido o `fetchLawsuits(true)` que forçava refresh em
 * toda chamada — defetiva o cache de `lawsuits` (TTL 20min). Agora
 * respeita o cache; passa `?force=1` se quiser invalidar.
 */

'use strict';

const { Router } = require('express');
const { fetchLawsuits } = require('../../../services/data');
const cache = require('../../../cache');
const { asyncHandler } = require('../../../middleware/errorHandler');

cache.define('distribution', 20 * 60 * 1000);

const STAGES_ARQUIVO = ['IGNORAR', 'ARQUIV', 'CANCELADO', 'AGUARDAR DATA', 'NÃO DISTRIBUÍDO'];
const ENTIDADES_NAO_PESSOAIS = /INSS|INSTITUTO NACIONAL|PREVIDENCIA|ESTADO|MUNICIPIO|UNIAO FEDERAL/i;

function norm(str) {
  return (str || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function isArquivado(stage) {
  const up = (stage || '').toUpperCase();
  return STAGES_ARQUIVO.some(k => up.includes(k));
}

function pickPersonalCustomer(customers) {
  const arr = Array.isArray(customers) ? customers : [];
  return arr.find(c => c.name && !ENTIDADES_NAO_PESSOAIS.test(norm(c.name))) || arr[0] || {};
}

function buildDistribution(lawsuits) {
  const grouped = {};

  for (const l of lawsuits) {
    const resp = (l.responsible || 'SEM RESPONSÁVEL').trim();
    if (!grouped[resp]) grouped[resp] = { responsible: resp, processes: [] };

    const grupo = (l.exit_production || l.exit_execution || isArquivado(l.stage))
      ? 'encerrado' : 'ativo';

    const personal = pickPersonalCustomer(l.customers);

    grouped[resp].processes.push({
      id:         l.id,
      processo:   l.process_number || l.protocol_number || `#${l.id}`,
      cliente:    personal.name || '',
      tipo:       l.type  || '',
      fase:       l.stage || '',
      etapa:      l.step  || '',
      created_at: l.created_at || '',
      grupo,
    });
  }

  // Ordena: mais antigo primeiro
  for (const g of Object.values(grouped)) {
    g.processes.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }

  // Ordena responsáveis por #ativos desc
  const responsaveis = Object.values(grouped).sort((a, b) => {
    const aCount = a.processes.filter(p => p.grupo === 'ativo').length;
    const bCount = b.processes.filter(p => p.grupo === 'ativo').length;
    return bCount - aCount;
  });

  const total = responsaveis.reduce(
    (s, r) => s + r.processes.filter(p => p.grupo === 'ativo').length,
    0
  );

  return { responsaveis, total, cachedAt: new Date().toISOString() };
}

const router = Router();

router.get('/distribution', asyncHandler(async (req, res) => {
  const force = req.query.force === '1';
  const data = await cache.getOrFetch('distribution', async () => {
    const all = await fetchLawsuits(force);   // ← respeita cache; só força se request pediu
    return buildDistribution(all);
  }, force);

  res.json(data);
}));

module.exports = router;
