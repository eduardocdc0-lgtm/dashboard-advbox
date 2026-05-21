/**
 * Error handler centralizado — classes de erro + handler global.
 *
 * Diferenças vs. versão anterior:
 *  - Inclui `req.id` no log
 *  - Stack trace só em dev
 *  - Distingue erros operacionais (esperados) de programáticos
 */

'use strict';

const { config } = require('../config');
const { logger } = require('./logger');

class AppError extends Error {
  constructor(message, status = 500, details = null) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.details = details;
    this.isOperational = true;   // erros de negócio, não bugs
    Error.captureStackTrace(this, this.constructor);
  }
}

// `code` é uma chave estável (não-i18n) pra clients fazerem branch sem regex
// no `error.message`. Aparece em response.code via errorHandler.
class ValidationError extends AppError {
  constructor(message = 'Dados inválidos.', details = null) {
    super(message, 400, details);
    this.code = 'VALIDATION';
  }
}
class AuthenticationError extends AppError {
  constructor(message = 'Não autenticado.') {
    super(message, 401);
    this.code = 'UNAUTHENTICATED';
  }
}
class AuthorizationError extends AppError {
  constructor(message = 'Acesso negado.') {
    super(message, 403);
    this.code = 'FORBIDDEN';
  }
}
class NotFoundError extends AppError {
  constructor(message = 'Recurso não encontrado.') {
    super(message, 404);
    this.code = 'NOT_FOUND';
  }
}
class ExternalServiceError extends AppError {
  constructor(service, message, details = null) {
    super(`${service}: ${message}`, 502, details);
    this.code = 'EXTERNAL_SERVICE';
  }
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function notFoundHandler(req, res, next) {
  next(new NotFoundError(`Rota não encontrada: ${req.method} ${req.path}`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const isOperational = err.isOperational === true;

  // Log: erros 5xx ou não operacionais sempre com stack; 4xx só warn
  const logPayload = {
    reqId:  req.id,
    method: req.method,
    url:    req.originalUrl || req.url,
    status,
    err: {
      name:    err.name,
      message: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(config.isDev || !isOperational ? { stack: err.stack } : {}),
      ...(err.details ? { details: err.details } : {}),
    },
  };

  if (status >= 500) logger.error(logPayload, err.message);
  else               logger.warn(logPayload,  err.message);

  if (res.headersSent) return;

  // CIRCUIT_OPEN: o breaker de utils/circuitBreaker.js anexa retryAfterSec.
  // Padrão HTTP: header Retry-After com inteiro em segundos (RFC 7231 §7.1.3).
  // Cliente bem-feito honra isso antes de tentar de novo.
  if (err.code === 'CIRCUIT_OPEN' && Number.isFinite(err.retryAfterSec)) {
    res.setHeader('Retry-After', String(err.retryAfterSec));
  }

  // Contexto enriquecido em TODA resposta de erro — útil pro suporte ao usar
  // o requestId pra cruzar com os logs.
  const body = {
    error:     err.message || 'Erro interno do servidor.',
    timestamp: new Date().toISOString(),
    path:      req.originalUrl || req.url,
    method:    req.method,
  };
  if (err.code)    body.code    = err.code;       // 'CIRCUIT_OPEN' | 'VALIDATION' | etc — útil pra clients que querem branch sem regex no message
  if (err.details) body.details = err.details;    // ValidationError carrega [{field, message}]
  if (req.id)      body.requestId = req.id;
  if (config.isDev && status >= 500) body.stack = err.stack;

  res.status(status).json(body);
}

module.exports = {
  errorHandler,
  asyncHandler,
  notFoundHandler,
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ExternalServiceError,
};
