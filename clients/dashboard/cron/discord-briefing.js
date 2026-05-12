/**
 * Cron de briefing diário no Discord.
 *
 * Roda às 7h30 (America/Recife), seg-sex. Manda um embed com:
 *  - tarefas vencidas, vencendo hoje/amanhã
 *  - inadimplência %
 *  - a receber / a pagar
 *  - top devedores
 *
 * Desabilitar: env BRIEFING_ENABLED=false
 * Mudar horário: env BRIEFING_CRON (ex: "0 8 * * 1-5" pra 8h seg-sex)
 */

'use strict';

const cron = require('node-cron');

const DEFAULT_CRON = '30 7 * * 1-5'; // 7h30 seg-sex
const TZ = 'America/Recife';

function startBriefingCron({ logger = console } = {}) {
  if (process.env.BRIEFING_ENABLED === 'false') {
    logger.info('[Cron Briefing] Desabilitado via env BRIEFING_ENABLED=false.');
    return null;
  }
  if (!process.env.DISCORD_WEBHOOK_URL) {
    logger.warn('[Cron Briefing] DISCORD_WEBHOOK_URL não configurado — briefing não vai rodar.');
    return null;
  }

  const cronExpr = process.env.BRIEFING_CRON || DEFAULT_CRON;
  const job = cron.schedule(cronExpr, async () => {
    try {
      const { sendBriefing } = require('../../../services/discord-briefing');
      logger.info('[Cron Briefing] Disparando briefing...');
      const result = await sendBriefing({ logger });
      logger.info(`[Cron Briefing] OK — ${JSON.stringify(result.summary)}`);
    } catch (err) {
      logger.error(`[Cron Briefing] Erro: ${err.message}`);
    }
  }, { timezone: TZ });

  logger.info(`[Cron Briefing] Agendado: "${cronExpr}" ${TZ}`);
  return job;
}

module.exports = { startBriefingCron };
