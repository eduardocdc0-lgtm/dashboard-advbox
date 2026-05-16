/**
 * Telemetria de uso de rota — fire-and-forget.
 *
 * Loga cada GET /api/* (path sem query) na tabela route_access_log pra
 * Eduardo conseguir auditar O QUE A EQUIPE REALMENTE USA depois de 7-14 dias.
 *
 * Regras:
 *   - Só GET (POSTs já têm seu rastreamento próprio nas tabelas de negócio)
 *   - Só /api/* (estáticos não contam)
 *   - Não loga healthcheck (poluiria base) nem o próprio endpoint de leitura
 *   - Fire-and-forget: nunca bloqueia request, nunca quebra se DB cair
 *   - Sem query params (podem ter dado sensível tipo CID)
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

function accessLog(req, res, next) {
  try {
    if (req.method !== 'GET') return next();
    if (!req.path.startsWith('/api/')) return next();
    if (SKIP_PATHS.has(req.path)) return next();

    const userId = req.session && req.session.userId
      ? Number(req.session.userId)
      : null;

    // Fire-and-forget — não aguarda, não propaga erro
    query(
      'INSERT INTO route_access_log(route, user_id) VALUES($1, $2)',
      [req.path, userId]
    ).catch(() => { /* silencioso */ });
  } catch (_) { /* nunca quebra a request */ }
  next();
}

module.exports = { accessLog };
