// ========================================
// Dashboard AdvBox — Entry Point
// ========================================

const express       = require('express');
const path          = require('path');
const cookieSession = require('cookie-session');

const { errorHandler } = require('../../middleware/errorHandler');
const { migrate }  = require('../../services/db');
const apiRoutes    = require('./routes/index');

const app  = express();
const PORT = process.env.PORT || 5000;

const USERS = {
  [process.env.ADMIN_USER || 'eduardo']: { password: process.env.ADMIN_PASS || '', role: 'admin' },
  [process.env.TEAM_USER  || 'time']:    { password: process.env.TEAM_PASS  || '', role: 'team'  },
};

app.use(cookieSession({
  name:     'advsess',
  secret:   process.env.SESSION_SECRET || 'advbox-sess-secret-2025',
  maxAge:   12 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));

// ── Auth: login / logout / me ─────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = USERS[username];
  if (!user || user.password === '' || user.password !== password) {
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
  req.session.user = { username, role: user.role };
  res.json({ ok: true, role: user.role });
});

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

// ── Protege /api/* ────────────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  const open = ['/login', '/logout', '/me', '/webhooks/chatguru'];
  if (open.includes(req.path)) return next();
  if (req.session?.user) return next();
  res.status(401).json({ error: 'Não autenticado.' });
});

// ── Cache status / invalidação (admin) ───────────────────────────────────────
app.get('/api/cache-status', (req, res) => {
  if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Restrito.' });
  res.json(require('../../cache').status());
});

app.post('/api/cache-invalidate', (req, res) => {
  if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Restrito.' });
  const cache = require('../../cache');
  const { key } = req.body || {};
  if (key) cache.invalidate(key);
  else     cache.invalidateAll();
  res.json({ ok: true, invalidated: key || 'all' });
});

// ── Rotas da API ──────────────────────────────────────────────────────────────
app.use('/api', apiRoutes);
app.use(errorHandler);

migrate().then(() => {
  app.listen(PORT, () => {
    console.log(`Dashboard rodando em http://localhost:${PORT}`);
    if (!process.env.ADVBOX_TOKEN)   console.warn('ATENÇÃO: ADVBOX_TOKEN não configurado.');
    if (!process.env.DATABASE_URL)   console.warn('ATENÇÃO: DATABASE_URL não configurado — leads desativados.');
  });
});
