/**
 * Middlewares de segurança centralizados:
 *  - helmet (HTTP security headers + CSP)
 *  - rate-limit (login + API geral)
 *  - CORS com allowlist
 */

'use strict';

const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const { config }  = require('../config');

// ── Helmet com CSP ajustado pro Chart.js (CDN) ───────────────────────────────
function helmetMiddleware() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:    ["'self'"],
        scriptSrc:     ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        scriptSrcAttr: ["'unsafe-inline'"], // permite onclick="..." inline (dashboard inteiro usa)
        styleSrc:      ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc:     ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc:      ["'self'", 'data:', 'https:'],
        connectSrc:  ["'self'", 'https://app.advbox.com.br', 'https://graph.facebook.com'],
        frameAncestors: ["'none'"],
        objectSrc:   ["'none'"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,    // CDN do Chart.js
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
}

// ── CORS com allowlist (substitui o "Access-Control-Allow-Origin: *") ────────
function corsMiddleware() {
  const allowed = config.corsOrigins;

  return (req, res, next) => {
    const origin = req.headers.origin;

    // Sem origin = same-origin ou ferramenta sem CORS (curl, postman) → libera
    if (!origin) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, Authorization');
      res.setHeader('Access-Control-Max-Age', '86400');
      if (req.method === 'OPTIONS') return res.status(204).end();
      return next();
    }

    // Em dev, sem allowlist configurada, libera localhost*
    const allowedNow = allowed.length
      ? allowed
      : (config.isProd ? [] : [origin].filter(o => /^https?:\/\/localhost(:\d+)?$/.test(o)));

    if (allowedNow.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, Authorization');
      res.setHeader('Access-Control-Max-Age', '86400');
    }

    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
}

// ── Rate limit do /api/login (anti-brute-force) ──────────────────────────────
const loginLimiter = rateLimit({
  windowMs: config.limits.rateLoginWindowMs,
  max:      config.limits.rateLoginMax,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Muitas tentativas de login. Tente novamente em alguns minutos.' },
  skipSuccessfulRequests: true,   // só conta tentativas que falharam
});

// ── Rate limit geral da API (anti-abuse) ─────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: config.limits.rateApiWindowMs,
  max:      config.limits.rateApiMax,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Limite de requisições atingido. Tente novamente em instantes.' },
  // Não conta requests autenticados por API key (back-office tem fluxos batch)
  skip: (req) => !!req.headers['x-api-key'] && req.headers['x-api-key'] === config.readApiKey,
});

module.exports = {
  helmetMiddleware,
  corsMiddleware,
  loginLimiter,
  apiLimiter,
};
