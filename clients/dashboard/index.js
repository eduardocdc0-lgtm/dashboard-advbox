// ========================================
// Dashboard AdvBox — Entry Point
// ========================================

const express       = require('express');
const path          = require('path');
const cookieSession = require('cookie-session');

const cron       = require('node-cron');
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

// ── CORS: permite X-Api-Key em cross-origin requests ─────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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
// Autenticação alternativa via X-Api-Key (somente GET).
// Se o header bater com READ_API_KEY → autentica como admin sem cookie de sessão.
// Fluxo normal de sessão continua funcionando para todos os outros requests.
app.use('/api', (req, res, next) => {
  const open = ['/login', '/logout', '/me', '/webhooks/chatguru'];
  if (open.includes(req.path)) return next();

  // ── API Key (GET somente, não modifica dados) ─────────────────────────────
  if (req.method === 'GET') {
    const READ_API_KEY = process.env.READ_API_KEY;
    const provided     = req.headers['x-api-key'];
    if (provided && READ_API_KEY && provided === READ_API_KEY) {
      console.log(`[API Key] ${new Date().toISOString()} | ${req.ip} | ${req.path}`);
      req.session.user = { username: 'api-key', role: 'admin' };
      return next();
    }
  }

  // ── Sessão normal ─────────────────────────────────────────────────────────
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

  // ── Cron: mensagens de aniversário — 09:00 America/Recife (desativado por padrão) ──
  cron.schedule('0 9 * * *', async () => {
    try {
      const { getConfig, processarAniversariantesHoje } = require('../../services/birthday');
      const { fetchCustomers } = require('../../services/data');
      const enabled = await getConfig();
      if (!enabled) {
        console.log('[Cron Birthday] Envio automático desativado — pulando.');
        return;
      }
      console.log('[Cron Birthday] Iniciando envio de aniversários...');
      const customers = await fetchCustomers();
      const resultados = await processarAniversariantesHoje(customers);
      const ok   = resultados.filter(r => r.status === 'sent').length;
      const fail = resultados.filter(r => r.status === 'failed').length;
      console.log(`[Cron Birthday] Concluído — ${ok} enviados, ${fail} falhas.`);
    } catch (err) {
      console.error('[Cron Birthday] Erro:', err.message);
    }
  }, { timezone: 'America/Recife' });

  console.log('[Cron Birthday] Agendado para 09:00 America/Recife (ativar via painel).');
});
