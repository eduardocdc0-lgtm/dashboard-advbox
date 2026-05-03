/**
 * Logger estruturado (pino) + middleware de request ID.
 *
 * - Cada request ganha um `req.id` único (UUID curto).
 * - Logs incluem método, URL, status, duração e ID.
 * - Em dev: pretty-print colorido (pino-pretty). Em prod: JSON puro pra ingestão.
 */

'use strict';

const crypto = require('crypto');
const pino   = require('pino');
const { config } = require('../config');

const logger = pino({
  level: config.isProd ? 'info' : 'debug',
  ...(config.isDev && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    },
  }),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'req.headers.cookie',
      'password',
      '*.password',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
});

function shortId() {
  return crypto.randomBytes(6).toString('hex');
}

function requestLogger(req, res, next) {
  req.id = req.headers['x-request-id'] || shortId();
  res.setHeader('X-Request-Id', req.id);

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durMs = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? 'error'
                : res.statusCode >= 400 ? 'warn'
                : 'info';
    logger[level]({
      reqId:    req.id,
      method:   req.method,
      url:      req.originalUrl || req.url,
      status:   res.statusCode,
      durMs:    Math.round(durMs),
      ip:       req.ip,
      ua:       req.headers['user-agent'],
    }, `${req.method} ${req.url} ${res.statusCode} ${Math.round(durMs)}ms`);
  });

  next();
}

module.exports = { logger, requestLogger };
