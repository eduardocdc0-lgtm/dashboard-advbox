/**
 * Cron de envio de mensagens Discord agendadas.
 *
 * Roda a cada 1 minuto. Verifica mensagens com send_at <= NOW() ainda
 * não enviadas e dispara via webhook.
 *
 * Desativável via DISCORD_SCHEDULER_ENABLED=false.
 */

'use strict';

const cron = require('node-cron');

function startDiscordSchedulerCron({ logger = console } = {}) {
  if (process.env.DISCORD_SCHEDULER_ENABLED === 'false') {
    logger.info('[Cron Discord] Desabilitado via env.');
    return null;
  }

  // A cada minuto, no segundo 30 (pra evitar bater com cron :15 e cron :0)
  const job = cron.schedule('30 * * * * *', async () => {
    try {
      const { runDueMessages } = require('../../../services/discord-scheduler');
      const result = await runDueMessages({ logger });
      if (result.enviadas > 0 || result.erros > 0) {
        logger.info({ result }, '[Cron Discord] Ciclo concluído.');
      }
    } catch (err) {
      logger.error({ err: err.message }, '[Cron Discord] Falha no ciclo.');
    }
  }, { timezone: 'America/Recife' });

  logger.info('[Cron Discord] Agendado: a cada minuto (America/Recife).');
  return job;
}

module.exports = { startDiscordSchedulerCron };
