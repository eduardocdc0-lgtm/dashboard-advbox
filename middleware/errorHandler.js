function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  console.error(`[Error] ${req.method} ${req.path} → ${err.message}`);
  if (!res.headersSent) {
    res.status(status).json({ error: err.message || 'Erro interno do servidor.' });
  }
}

module.exports = errorHandler;
