/**
 * Cron da régua de cobrança escalonada.
 *
 * Roda 1x por dia, 09:30 America/Recife. Detecta inadimplentes e dispara
 * a etapa correspondente (D+1 / D+7 / D+15 / D+30) com cooldown anti-spam.
 *
 * Desabilitar: REGUA_COBRANCA_ENABLED=false
 * Dry-run global: REGUA_COBRANCA_DRY=true
 */

'use strict';

const cron = require('node-cron');
const jobsRegistry = require('../../../services/jobs-registry');

const CRON_EXPR = '30 9 * * 1-6'; // segunda a sábado às 09:30
const TZ = 'America/Recife';
const JOB_NAME = 'regua-cobranca';

function startReguaCobrancaCron({ logger = console } = {}) {
  if (process.env.REGUA_COBRANCA_ENABLED === 'false') {
    logger.info('[Cron Régua-Cobrança] Desabilitado via REGUA_COBRANCA_ENABLED=false.');
    jobsRegistry.register(JOB_NAME, { status: 'disabled', reason: 'REGUA_COBRANCA_ENABLED=false' });
    return null;
  }

  const job = cron.schedule(CRON_EXPR, async () => {
    try {
      const { runCycle } = require('../../../services/regua-cobranca');
      logger.info('[Cron Régua-Cobrança] Iniciando ciclo...');
      const result = await runCycle({ logger });
      logger.info({ result }, '[Cron Régua-Cobrança] Ciclo concluído.');
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, '[Cron Régua-Cobrança] Falha no ciclo.');
    }
  }, { timezone: TZ });

  logger.info('[Cron Régua-Cobrança] Agendado: 09:30 seg–sáb (timezone America/Recife).');
  jobsRegistry.register(JOB_NAME, { status: 'running', cronExpr: CRON_EXPR, timezone: TZ });
  return job;
}

module.exports = { startReguaCobrancaCron };
