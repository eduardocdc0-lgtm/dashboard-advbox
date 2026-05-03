/**
 * Dashboard AdvBox — Entry Point
 *
 * Refatorações vs. versão anterior:
 *   ✓ CORS com allowlist (não mais "*")
 *   ✓ Cookie session com flag `secure` em produção
 *   ✓ Rate limit no /api/login (anti-brute-force)
 *   ✓ Helmet com CSP customizado
 *   ✓ Comparação timing-safe da X-Api-Key
 *   ✓ Logger estruturado (pino) + request ID
 *   ✓ Cron extraído pra módulo separado
 *   ✓ Config centralizado em ../../config
 */

'use strict';

const express       = require('express');
const path          = require('path');
const cookieSession = require('cookie-session');

const { config, warnings } = require('../../config');
const { logger, requestLogger } = require('../../middleware/logger');
const {
  errorHandler, notFoundHandler, asyncHandler,
  AuthenticationError, AuthorizationError,
} = require('../../middleware/errorHandler');
const {
  helmetMiddleware, corsMiddleware, loginLimiter, apiLimiter,
} = require('../../middleware/security');
const { safeCompare } = require('../../utils/safeCompare');
const { migrate }     = require('../../services/db');
const cache           = require('../../cache');
const apiRoutes       = require('./routes');
const { startBirthdayCron } = require('./cron/birthday');

const app = express();
app.set('trust proxy', 1);    // necessário em PaaS (Replit/Heroku) pra rate-limit ler IP correto

// ── Logger + Request ID (PRIMEIRA coisa) ─────────────────────────────────────
app.use(requestLogger);

// ── Segurança ────────────────────────────────────────────────────────────────
app.use(helmetMiddleware());
app.use(corsMiddleware());
app.use(express.json({ limit: config.limits.bodyJson }));

// ── Sessão ───────────────────────────────────────────────────────────────────
app.use(cookieSession({
  name:     'advsess',
  secret:   config.session.secret,
  maxAge:   config.session.maxAgeMs,
  httpOnly: true,
  sameSite: 'lax',
  secure:   config.session.secure,
}));

// ── Static (frontend) ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));

// ── Auth: login / logout / me ────────────────────────────────────────────────
const USERS = {
  [config.users.admin.username]: { password: config.users.admin.password, role: 'admin' },
  [config.users.team.username]:  { password: config.users.team.password,  role: 'team'  },
};

app.post('/api/login', loginLimiter, asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  const user = USERS[username];
  // Sempre faz a comparação para não vazar timing por "usuário existe ou não"
  const expected = user?.password || '';
  const ok = !!user && expected.length > 0 && safeCompare(String(password || ''), expected);
  if (!ok) throw new AuthenticationError('Usuário ou senha incorretos.');
  req.session.user = { username, role: user.role };
  res.json({ ok: true, role: user.role });
}));

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (req.session?.user) {
    return res.json({ loggedIn: true, role: req.session.user.role, username: req.session.user.username });
  }
  res.json({ loggedIn: false });
});

// ── Health check (sem auth) ──────────────────────────────────────────────────
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), env: config.env });
});

// ── Rate limit geral aplicado a /api/* ───────────────────────────────────────
app.use('/api', apiLimiter);

// ── Auth gate para /api/* (com fallback X-Api-Key timing-safe) ───────────────
const OPEN_ROUTES = new Set(['/login', '/logout', '/me', '/webhooks/chatguru']);

app.use('/api', (req, res, next) => {
  if (OPEN_ROUTES.has(req.path)) return next();

  // X-Api-Key (somente GET; modifica nada)
  if (req.method === 'GET' && config.readApiKey) {
    const provided = String(req.headers['x-api-key'] || '');
    if (provided && safeCompare(provided, config.readApiKey)) {
      logger.info({ reqId: req.id, ip: req.ip, path: req.path }, '[API Key] auth OK');
      req.session.user = { username: 'api-key', role: 'admin' };
      return next();
    }
  }

  if (req.session?.user) return next();
  return next(new AuthenticationError());
});

// ── Cache admin (status / invalidate) ────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session?.user?.role !== 'admin') return next(new AuthorizationError());
  next();
}

app.get('/api/cache-status', requireAdmin, (req, res) => {
  res.json(cache.status());
});

app.post('/api/cache-invalidate', requireAdmin, (req, res) => {
  const { key } = req.body || {};
  if (key) cache.invalidate(key);
  else     cache.invalidateAll();
  res.json({ ok: true, invalidated: key || 'all' });
});

// ── Rotas da API ─────────────────────────────────────────────────────────────
app.use('/api', apiRoutes);

// ── 404 + error handler ──────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ── Boot ─────────────────────────────────────────────────────────────────────
warnings().forEach(w => logger.warn(w));

migrate()
  .catch(err => logger.error({ err: err.message }, '[DB] Migrate falhou (continua)'))
  .finally(() => {
    app.listen(config.port, () => {
      logger.info(`Dashboard rodando em http://localhost:${config.port} (env: ${config.env})`);
      startBirthdayCron({ logger });
    });
  });

// ── Hardening: process-level handlers ────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: reason instanceof Error ? reason.message : reason }, 'unhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'uncaughtException — encerrando');
  process.exit(1);
});

module.exports = app;
