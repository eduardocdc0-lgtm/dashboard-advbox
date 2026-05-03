/**
 * Cron de mensagens de aniversário — extraído do entry point.
 *
 * Roda 09:00 America/Recife. Só dispara mensagens se o config no DB
 * (`birthday_auto_enabled`) estiver = 'true'. Default = false (seguro).
 */

'use strict';

const cron = require('node-cron');

function startBirthdayCron({ logger = console } = {}) {
  const job = cron.schedule('0 9 * * *', async () => {
    try {
      // require lazy pra não puxar dependências de DB se cron desabilitado
      const { getConfig, processarAniversariantesHoje } = require('../../../services/birthday');
      const { fetchCustomers } = require('../../../services/data');

      const enabled = await getConfig();
      if (!enabled) {
        logger.info('[Cron Birthday] Envio automático desativado — pulando.');
        return;
      }

      logger.info('[Cron Birthday] Iniciando envio...');
      const customers  = await fetchCustomers();
      const resultados = await processarAniversariantesHoje(customers);
      const ok   = resultados.filter(r => r.status === 'sent').length;
      const fail = resultados.filter(r => r.status === 'failed').length;
      logger.info({ ok, fail }, `[Cron Birthday] Concluído — ${ok} OK, ${fail} falhas`);
    } catch (err) {
      logger.error({ err: err.message }, '[Cron Birthday] Erro');
    }
  }, { timezone: 'America/Recife' });

  logger.info('[Cron Birthday] Agendado: 09:00 America/Recife (ativar via /birthday/config).');
  return job;
}

module.exports = { startBirthdayCron };
