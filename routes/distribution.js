const { Router } = require('express');
const { fetchLawsuits } = require('../services/data');
const cache = require('../services/cache');

cache.define('distribution', 20 * 60 * 1000);

function norm(str) {
  return (str || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const STAGES_ARQUIVO = ['IGNORAR', 'ARQUIV', 'CANCELADO', 'AGUARDAR DATA', 'NÃO DISTRIBUÍDO'];

const router = Router();

router.get('/distribution', async (req, res, next) => {
  try {
    const force = req.query.force === '1';
    const data = await cache.getOrFetch('distribution', async () => {
      const all = await fetchLawsuits(true);

      const grouped = {};
      for (const l of all) {
        const resp = (l.responsible || 'SEM RESPONSÁVEL').trim();
        if (!grouped[resp]) grouped[resp] = { responsible: resp, processes: [] };

        const stageUp     = (l.stage || '').toUpperCase();
        const isArquivado = STAGES_ARQUIVO.some(k => stageUp.includes(k));
        const grupo       = (l.exit_production || l.exit_execution || isArquivado) ? 'encerrado' : 'ativo';

        const clientsArr = Array.isArray(l.customers) ? l.customers : [];
        const personal   = clientsArr.find(c =>
          c.name && !/INSS|INSTITUTO NACIONAL|PREVIDENCIA|ESTADO|MUNICIPIO|UNIAO FEDERAL/i.test(norm(c.name))
        );
        const clientName = (personal || clientsArr[0] || {}).name || '';

        grouped[resp].processes.push({
          id:         l.id,
          processo:   l.process_number || l.protocol_number || `#${l.id}`,
          cliente:    clientName,
          tipo:       l.type  || '',
          fase:       l.stage || '',
          etapa:      l.step  || '',
          created_at: l.created_at || '',
          grupo,
        });
      }

      Object.values(grouped).forEach(g =>
        g.processes.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      );

      const responsaveis = Object.values(grouped).sort((a, b) => {
        const aA = a.processes.filter(p => p.grupo === 'ativo').length;
        const bA = b.processes.filter(p => p.grupo === 'ativo').length;
        return bA - aA;
      });

      const total = responsaveis.reduce((s, r) =>
        s + r.processes.filter(p => p.grupo === 'ativo').length, 0);

      return { responsaveis, total, cachedAt: new Date().toISOString() };
    }, force);

    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
