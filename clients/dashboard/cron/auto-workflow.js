/**
 * Cron de auto-workflow.
 *
 * Roda de hora em hora. Detecta mudanças de fase nos lawsuits do AdvBox
 * e cria automaticamente as tarefas dos templates correspondentes.
 *
 * Pode ser desabilitado via env var AUTO_WORKFLOW_ENABLED=false.
 */

'use strict';

const cron = require('node-cron');

function startAutoWorkflowCron({ logger = console } = {}) {
  if (process.env.AUTO_WORKFLOW_ENABLED === 'false') {
    logger.info('[Cron Auto-Workflow] Desabilitado via env AUTO_WORKFLOW_ENABLED=false.');
    return null;
  }

  // A cada hora no minuto 15 (pra não bater junto com outros crons)
  const job = cron.schedule('15 * * * *', async () => {
    try {
      const { runCycle } = require('../../../services/auto-workflow');
      logger.info('[Cron Auto-Workflow] Iniciando ciclo...');
      const result = await runCycle({ logger, dryRun: false, forceRefresh: true });
      logger.info({ result }, '[Cron Auto-Workflow] Ciclo concluído.');
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, '[Cron Auto-Workflow] Falha no ciclo.');
    }
  }, { timezone: 'America/Recife' });

  logger.info('[Cron Auto-Workflow] Agendado: a cada hora :15 (timezone America/Recife).');
  return job;
}

module.exports = { startAutoWorkflowCron };
