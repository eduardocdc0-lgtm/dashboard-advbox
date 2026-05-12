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
const jobsRegistry = require('../../../services/jobs-registry');

const CRON_EXPR = '15 * * * *';
const TZ = 'America/Recife';
const JOB_NAME = 'auto-workflow';

function startAutoWorkflowCron({ logger = console } = {}) {
  if (process.env.AUTO_WORKFLOW_ENABLED === 'false') {
    logger.info('[Cron Auto-Workflow] Desabilitado via env AUTO_WORKFLOW_ENABLED=false.');
    jobsRegistry.register(JOB_NAME, { status: 'disabled', reason: 'AUTO_WORKFLOW_ENABLED=false' });
    return null;
  }

  // A cada hora no minuto 15 (pra não bater junto com outros crons)
  const job = cron.schedule(CRON_EXPR, async () => {
    try {
      const { runCycle } = require('../../../services/auto-workflow');
      logger.info('[Cron Auto-Workflow] Iniciando ciclo...');
      const result = await runCycle({ logger, dryRun: false, forceRefresh: true });
      logger.info({ result }, '[Cron Auto-Workflow] Ciclo concluído.');
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, '[Cron Auto-Workflow] Falha no ciclo.');
    }
  }, { timezone: TZ });

  logger.info('[Cron Auto-Workflow] Agendado: a cada hora :15 (timezone America/Recife).');
  jobsRegistry.register(JOB_NAME, { status: 'running', cronExpr: CRON_EXPR, timezone: TZ });
  return job;
}

module.exports = { startAutoWorkflowCron };
