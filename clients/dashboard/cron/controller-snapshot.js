/**
 * Cron de snapshot diário do Controller.
 *
 * Roda 23h America/Recife, todos os dias. Grava em controller_snapshots a foto
 * de cada categoria (total, estourados, dias_medios, sla_pct). Daí dá pra:
 *  - calcular delta vs ontem (saiu/entrou da fila)
 *  - mostrar tendência semanal no pódio
 *  - estimar produtividade real do setor
 *
 * Desabilitar: env CONTROLLER_SNAPSHOT_ENABLED=false
 * Mudar horário: env CONTROLLER_SNAPSHOT_CRON (ex: "30 22 * * *")
 */

'use strict';

const cron = require('node-cron');
const jobsRegistry = require('../../../services/jobs-registry');

const DEFAULT_CRON = '0 23 * * *'; // 23h todos os dias
const TZ = 'America/Recife';
const JOB_NAME = 'controller-snapshot';

function startControllerSnapshotCron({ logger = console } = {}) {
  if (process.env.CONTROLLER_SNAPSHOT_ENABLED === 'false') {
    logger.info('[Cron Snapshot] Desabilitado via env.');
    jobsRegistry.register(JOB_NAME, { status: 'disabled', reason: 'CONTROLLER_SNAPSHOT_ENABLED=false' });
    return null;
  }

  const cronExpr = process.env.CONTROLLER_SNAPSHOT_CRON || DEFAULT_CRON;
  const job = cron.schedule(cronExpr, async () => {
    try {
      const { saveSnapshot } = require('../../../services/controller');
      logger.info('[Cron Snapshot] Salvando snapshot do Controller...');
      const result = await saveSnapshot({ force: true });
      logger.info(`[Cron Snapshot] OK — ${result.saved}/${result.total} cats em ${result.date}`);
    } catch (err) {
      logger.error(`[Cron Snapshot] Erro: ${err.message}`);
    }
  }, { timezone: TZ });

  logger.info(`[Cron Snapshot] Agendado: "${cronExpr}" ${TZ}`);
  jobsRegistry.register(JOB_NAME, { status: 'running', cronExpr, timezone: TZ });
  return job;
}

module.exports = { startControllerSnapshotCron };
