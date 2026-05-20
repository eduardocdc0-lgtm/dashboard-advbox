/**
 * Cron de SLA de leads.
 *
 * Roda a cada 30 minutos. Detecta leads em TRIAGEM parados há > SLA_LEADS_HORAS
 * e cria tarefa de cobrança no AdvBox pra Thiago/Tammyres.
 *
 * Desabilitar: env SLA_LEADS_ENABLED=false
 */

'use strict';

const cron = require('node-cron');
const jobsRegistry = require('../../../services/jobs-registry');

const CRON_EXPR = '*/30 * * * *';
const TZ = 'America/Recife';
const JOB_NAME = 'sla-leads';

function startSlaLeadsCron({ logger = console } = {}) {
  if (process.env.SLA_LEADS_ENABLED === 'false') {
    logger.info('[Cron SLA-Leads] Desabilitado via SLA_LEADS_ENABLED=false.');
    jobsRegistry.register(JOB_NAME, { status: 'disabled', reason: 'SLA_LEADS_ENABLED=false' });
    return null;
  }

  const job = cron.schedule(CRON_EXPR, async () => {
    try {
      const { runCycle } = require('../../../services/sla-leads');
      logger.info('[Cron SLA-Leads] Iniciando ciclo...');
      const result = await runCycle({ logger });
      logger.info({ result }, '[Cron SLA-Leads] Ciclo concluído.');
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, '[Cron SLA-Leads] Falha no ciclo.');
    }
  }, { timezone: TZ });

  logger.info('[Cron SLA-Leads] Agendado: a cada 30 minutos (timezone America/Recife).');
  jobsRegistry.register(JOB_NAME, { status: 'running', cronExpr: CRON_EXPR, timezone: TZ });
  return job;
}

module.exports = { startSlaLeadsCron };
