/**
 * Registry simples de jobs (crons) — cada cron registra seu estado no boot e
 * cada execução atualiza estatísticas runtime via cronGuard.
 *
 * Permite que /api/healthz/jobs reporte:
 *   - se cada cron realmente subiu, foi desabilitado por env, ou abortou
 *     por falta de secret
 *   - última execução com sucesso / com falha
 *   - quantas falhas consecutivas (alerta no Discord ao bater threshold)
 *
 * Status:
 *   running   — cron agendado e ativo
 *   disabled  — desligado intencionalmente via env
 *   skipped   — não subiu por dependência ausente (ex: webhook não configurado)
 */

'use strict';

const fetch = require('node-fetch');

const jobs = new Map();

function register(name, info) {
  jobs.set(name, {
    name,
    status:        info.status || 'unknown',
    cronExpr:      info.cronExpr || null,
    timezone:      info.timezone || null,
    reason:        info.reason || null,
    registered_at: new Date().toISOString(),
    // Runtime — atualizado por cronGuard a cada tick:
    lastSuccessAt:       null,
    lastFailureAt:       null,
    lastError:           null,
    consecutiveFailures: 0,
    totalRuns:           0,
    totalFailures:       0,
  });
}

function snapshot() {
  return [...jobs.values()];
}

function _recordSuccess(name) {
  const j = jobs.get(name);
  if (!j) return 0;
  const prevFailures = j.consecutiveFailures;
  j.lastSuccessAt       = new Date().toISOString();
  j.consecutiveFailures = 0;
  j.totalRuns++;
  return prevFailures;
}

function _recordFailure(name, err) {
  const j = jobs.get(name);
  if (!j) return 1;
  j.lastFailureAt = new Date().toISOString();
  j.lastError     = (err.message || String(err)).slice(0, 500);
  j.consecutiveFailures++;
  j.totalRuns++;
  j.totalFailures++;
  return j.consecutiveFailures;
}

/**
 * Posta uma mensagem no webhook do Discord. Best-effort: nunca propaga erro.
 *
 * LIMITAÇÃO CONHECIDA: usa o mesmo DISCORD_WEBHOOK_URL do briefing. Se o
 * próprio Discord/webhook estiver fora, o alerta morre silencioso (mas o
 * logger.error em cronGuard ainda registra). Pra alta-disponibilidade real
 * de alertas, configurar um segundo canal (PagerDuty/email/SMS) — fora do
 * escopo desta correção.
 */
async function sendCronAlert(content) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;  // sem webhook = sem alerta (já logamos no console)
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!resp.ok) {
      console.error(`[CronGuard] Discord alert falhou: HTTP ${resp.status}`);
    }
  } catch (e) {
    console.error(`[CronGuard] Discord alert falhou: ${e.message}`);
  }
}

/**
 * Wrapper pra callbacks de cron. Loga erros, atualiza runtime stats no
 * registry, e dispara alerta no Discord ao bater `alertAfter` falhas
 * consecutivas. Notifica também a recuperação.
 *
 * Política de alerta:
 *   - Alert disparado EXATAMENTE 1x quando consecutiveFailures atinge
 *     alertAfter (default 2). Falhas adicionais NÃO geram novos alerts —
 *     evita spammar Discord. /api/healthz/jobs mostra o estado atual.
 *   - Recovery alert disparado se prevFailures > 0 ao ter sucesso.
 *
 * NÃO re-throwa: o erro já foi logado e (se aplicável) alertado. node-cron
 * só perderia o tempo numa promise rejeitada que ninguém usa.
 *
 * @param {string} name      Mesmo nome usado em register() (ex: 'auto-workflow')
 * @param {function} fn      async () => any
 * @param {object} [opts]
 * @param {object} [opts.logger]      pino-like (info, warn, error)
 * @param {number} [opts.alertAfter]  threshold de falhas consecutivas (default 2)
 */
async function cronGuard(name, fn, { logger = console, alertAfter = 2 } = {}) {
  try {
    const result = await fn();
    const prevFailures = _recordSuccess(name);
    if (prevFailures > 0) {
      logger.info(`[CronGuard:${name}] Recuperou após ${prevFailures} falha(s).`);
      sendCronAlert(`✅ Cron \`${name}\` recuperou após ${prevFailures} falha(s) consecutiva(s).`)
        .catch(() => {});
    }
    return result;
  } catch (err) {
    const count = _recordFailure(name, err);
    logger.error({ err: err.message, stack: err.stack }, `[CronGuard:${name}] Falha #${count}`);
    if (count === alertAfter) {
      sendCronAlert(
        `🚨 Cron \`${name}\` falhou **${count}x consecutivas**\n` +
        `Última: \`${(err.message || String(err)).slice(0, 500)}\`\n` +
        `Detalhes em \`/api/healthz/jobs\`.`
      ).catch(() => {});
    }
    // Não re-throw — evita unhandledRejection e ruído no log do node-cron.
  }
}

module.exports = { register, snapshot, cronGuard, sendCronAlert };
