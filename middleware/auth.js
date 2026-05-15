function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: 'Não autenticado.' });
}

function requireAdmin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Não autenticado.' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito a administradores.' });
  next();
}

function requireFinance(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Não autenticado.' });
  if (!['admin', 'finance'].includes(req.session.user.role)) return res.status(403).json({ error: 'Acesso restrito ao financeiro.' });
  next();
}

module.exports = { requireAuth, requireAdmin, requireFinance };
