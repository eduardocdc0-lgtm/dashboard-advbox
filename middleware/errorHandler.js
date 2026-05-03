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

class ValidationError extends AppError {
  constructor(message = 'Dados inválidos.', details = null) { super(message, 400, details); }
}
class AuthenticationError extends AppError {
  constructor(message = 'Não autenticado.') { super(message, 401); }
}
class AuthorizationError extends AppError {
  constructor(message = 'Acesso negado.') { super(message, 403); }
}
class NotFoundError extends AppError {
  constructor(message = 'Recurso não encontrado.') { super(message, 404); }
}
class ExternalServiceError extends AppError {
  constructor(service, message, details = null) {
    super(`${service}: ${message}`, 502, details);
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
      ...(config.isDev || !isOperational ? { stack: err.stack } : {}),
      ...(err.details ? { details: err.details } : {}),
    },
  };

  if (status >= 500) logger.error(logPayload, err.message);
  else               logger.warn(logPayload,  err.message);

  if (res.headersSent) return;

  const body = { error: err.message || 'Erro interno do servidor.' };
  if (err.details) body.details = err.details;
  if (config.isDev && status >= 500) body.stack = err.stack;
  if (req.id) body.requestId = req.id;

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
