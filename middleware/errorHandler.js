class AppError extends Error {
  constructor(message, status = 500, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

class ValidationError extends AppError {
  constructor(message = 'Dados inválidos.', details = null) {
    super(message, 400, details);
  }
}

class AuthenticationError extends AppError {
  constructor(message = 'Não autenticado.') {
    super(message, 401);
  }
}

class AuthorizationError extends AppError {
  constructor(message = 'Acesso negado.') {
    super(message, 403);
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Recurso não encontrado.') {
    super(message, 404);
  }
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function notFoundHandler(req, res, next) {
  next(new NotFoundError(`Rota não encontrada: ${req.method} ${req.path}`));
}

function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  console.error(`[Error] ${req.method} ${req.path} → ${status} ${err.message}`);
  if (!res.headersSent) {
    const body = { error: err.message || 'Erro interno do servidor.' };
    if (err.details) body.details = err.details;
    res.status(status).json(body);
  }
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
};
