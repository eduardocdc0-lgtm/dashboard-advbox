/**
 * Telemetria de uso de rota — buffer in-memory + flush batched periódico.
 *
 * Loga cada GET /api/* (path sem query) na tabela route_access_log pra
 * Eduardo conseguir auditar O QUE A EQUIPE REALMENTE USA depois de 7-14 dias.
 *
 * Arquitetura (V2 — antes era fire-and-forget per-request):
 *   - Cada request faz UMA operação síncrona: push em array em memória.
 *     Latência da request = ~0ms (vs ~1-5ms da INSERT direta).
 *   - Timer flush a cada 60s: drena o buffer e faz UM INSERT batched.
 *   - DB caiu? Reinsere as entradas no buffer e tenta no próximo flush
 *     (sem perder dados, exceto se buffer encher).
 *   - Buffer cap 1000: protege contra crescimento descontrolado se DB ficar
 *     fora por horas. Overflow descarta as ENTRADAS MAIS ANTIGAS (FIFO).
 *   - SIGTERM/SIGINT: flush síncrono final antes de sair (best-effort —
 *     a Promise é awaitada com timeout pequeno; SIGKILL/OOM perdem dados).
 *
 * Regras:
 *   - Só GET (POSTs já têm seu rastreamento próprio nas tabelas de negócio)
 *   - Só /api/* (estáticos não contam)
 *   - Não loga healthcheck, /api/me, /api/cache-status, /api/admin/route-usage
 *   - Sem query params (podem ter dado sensível tipo CID)
 *
 * Métricas via getStats() — surfaceadas em /api/cache-status.
 */

'use strict';

const { query } = require('../services/db');

const SKIP_PATHS = new Set([
  '/api/healthz',
  '/api/healthz/jobs',
  '/api/admin/route-usage',  // não loga o leitor (poluiria a base)
  '/api/me',                  // chamada em cada page-load — ruído puro
  '/api/cache-status',
]);

const MAX_BUFFER       = 1000;
const FLUSH_INTERVAL_MS = 60 * 1000;
const FLUSH_BATCH_MAX  = 500;     // bound por INSERT pra não estourar packet size

// ── Estado do buffer ─────────────────────────────────────────────────────────
const buffer = [];                // [{ route, userId, accessedAt: Date }]
let flushTimer    = null;
let flushing      = false;        // mutex pra evitar flushes paralelos
const stats = {
  bufferedTotal:  0,    // total já enfileirado (cumulativo)
  flushedTotal:   0,    // total efetivamente persistido
  droppedTotal:   0,    // descartado por overflow do buffer
  lastFlushAt:    null,
  lastFlushError: null,
  consecutiveFlushFailures: 0,
};

function _enqueue(entry) {
  if (buffer.length >= MAX_BUFFER) {
    // Ring behavior: descarta o MAIS ANTIGO. Mantém os recentes (mais úteis).
    buffer.shift();
    stats.droppedTotal++;
  }
  buffer.push(entry);
  stats.bufferedTotal++;
}

async function flush() {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  // Drena até FLUSH_BATCH_MAX; deixa o resto pra próximo ciclo.
  const batch = buffer.splice(0, FLUSH_BATCH_MAX);
  try {
    // Constrói VALUES ($1,$2,$3),($4,$5,$6),... — 3 params por linha.
    const placeholders = [];
    const values = [];
    let i = 1;
    for (const e of batch) {
      placeholders.push(`($${i++}, $${i++}, $${i++})`);
      values.push(e.route, e.userId, e.accessedAt);
    }
    await query(
      `INSERT INTO route_access_log(route, user_id, accessed_at) VALUES ${placeholders.join(',')}`,
      values
    );
    stats.flushedTotal              += batch.length;
    stats.lastFlushAt                = new Date().toISOString();
    stats.lastFlushError             = null;
    stats.consecutiveFlushFailures   = 0;
  } catch (err) {
    // Re-insere as entradas no FRENTE do buffer pra preservar ordem.
    // Mas respeita o cap — se o buffer encheu enquanto flush rodava, sobra
    // vai pro chão (já entrou no droppedTotal indiretamente — entradas
    // novas começam a ser dropadas no próximo _enqueue).
    const headroom = MAX_BUFFER - buffer.length;
    const reinsert = batch.slice(0, headroom);
    const dropped  = batch.length - reinsert.length;
    if (reinsert.length > 0) buffer.unshift(...reinsert);
    if (dropped > 0)         stats.droppedTotal += dropped;

    stats.lastFlushError            = err.message.slice(0, 200);
    stats.consecutiveFlushFailures++;
    // Loga 1x a cada 5 falhas pra evitar spam (60s × 5 = 5min).
    if (stats.consecutiveFlushFailures === 1 || stats.consecutiveFlushFailures % 5 === 0) {
      console.error(`[access-log] flush falhou (consecutivos: ${stats.consecutiveFlushFailures}, buffer: ${buffer.length}): ${err.message}`);
    }
  } finally {
    flushing = false;
  }
}

function _startFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flush().catch(() => {}); }, FLUSH_INTERVAL_MS);
  // unref pra que o timer não impeça o processo de sair quando outras coisas
  // terminam (importante em testes e em scripts curtos).
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

// ── Shutdown handlers ────────────────────────────────────────────────────────
// Tentativa síncrona-like: trigger flush e aguarda até 5s. Best-effort —
// pg não tem API síncrona, então isso é o melhor possível sem dar fork.
let shuttingDown = false;
async function _shutdownFlush(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (buffer.length > 0) {
    console.log(`[access-log] ${signal}: flushing ${buffer.length} entradas pendentes...`);
    const timeout = new Promise(r => setTimeout(r, 5000));
    await Promise.race([flush(), timeout]).catch(() => {});
    if (buffer.length > 0) {
      console.warn(`[access-log] ${signal}: ${buffer.length} entradas não flushaadas (timeout ou erro)`);
    }
  }
}
process.once('SIGTERM', () => _shutdownFlush('SIGTERM'));
process.once('SIGINT',  () => _shutdownFlush('SIGINT'));

// ── Middleware ───────────────────────────────────────────────────────────────
function accessLog(req, res, next) {
  try {
    if (req.method !== 'GET') return next();
    if (!req.path.startsWith('/api/')) return next();
    if (SKIP_PATHS.has(req.path)) return next();

    const userId = req.session && req.session.userId
      ? Number(req.session.userId)
      : null;

    _enqueue({ route: req.path, userId, accessedAt: new Date() });
  } catch (_) { /* nunca quebra a request */ }
  next();
}

function getStats() {
  return {
    bufferSize:                       buffer.length,
    bufferCap:                        MAX_BUFFER,
    bufferedTotal:                    stats.bufferedTotal,
    flushedTotal:                     stats.flushedTotal,
    droppedTotal:                     stats.droppedTotal,
    lastFlushAt:                      stats.lastFlushAt,
    lastFlushError:                   stats.lastFlushError,
    consecutiveFlushFailures:         stats.consecutiveFlushFailures,
    flushIntervalSec:                 FLUSH_INTERVAL_MS / 1000,
  };
}

// Inicia o timer no module-load.
_startFlushTimer();

module.exports = { accessLog, getStats, _flush: flush };
