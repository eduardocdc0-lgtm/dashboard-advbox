/**
 * Cron de sincronização DJEN → AdvBox.
 *
 * Roda 1x ao dia, 6h30 America/Recife (antes da equipe começar).
 * Pode ser desabilitado via DJEN_SYNC_ENABLED=false.
 */

'use strict';

const cron = require('node-cron');

function startDjenSyncCron({ logger = console } = {}) {
  if (process.env.DJEN_SYNC_ENABLED === 'false') {
    logger.info('[Cron DJEN] Desabilitado via env.');
    return null;
  }

  // 6h30 todos os dias
  const job = cron.schedule('30 6 * * *', async () => {
    try {
      const { syncCycle } = require('../../../services/djen-sync');
      logger.info('[Cron DJEN] Iniciando ciclo diário...');
      const result = await syncCycle({ days: 3, logger });
      logger.info({ result }, '[Cron DJEN] Ciclo concluído.');
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, '[Cron DJEN] Falha.');
    }
  }, { timezone: 'America/Recife' });

  logger.info('[Cron DJEN] Agendado: 06:30 America/Recife (diário).');
  return job;
}

module.exports = { startDjenSyncCron };
