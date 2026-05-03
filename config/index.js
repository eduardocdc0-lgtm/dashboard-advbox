/**
 * Config central — leitura e validação de todas as variáveis de ambiente.
 * Falha rápido no boot se algo crítico estiver faltando.
 */

'use strict';

function required(name, hint = '') {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`[config] Variável obrigatória ausente: ${name}${hint ? ` — ${hint}` : ''}`);
  }
  return v;
}

function optional(name, fallback = '') {
  return process.env[name] ?? fallback;
}

function intOpt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function listOpt(name, fallback = []) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

const NODE_ENV = optional('NODE_ENV', 'development');
const isProd   = NODE_ENV === 'production';

const config = Object.freeze({
  env:        NODE_ENV,
  isProd,
  isDev:      !isProd,

  port:       intOpt('PORT', 5000),

  // ── Sessão ──────────────────────────────────────────────────────────────────
  session: {
    secret:    required('SESSION_SECRET', 'gerar com `node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"`'),
    maxAgeMs:  intOpt('SESSION_MAX_AGE_MS', 12 * 60 * 60 * 1000),
    secure:    isProd,
  },

  // ── Usuários ────────────────────────────────────────────────────────────────
  users: {
    admin: { username: optional('ADMIN_USER', 'eduardo'), password: optional('ADMIN_PASS', '') },
    team:  { username: optional('TEAM_USER',  'time'),    password: optional('TEAM_PASS',  '') },
  },

  // ── API Key (acesso somente-leitura admin) ──────────────────────────────────
  readApiKey: optional('READ_API_KEY', ''),

  // ── CORS — lista de origens permitidas, separadas por vírgula ───────────────
  // Em dev: aceita qualquer localhost por padrão. Em prod: só o que estiver na env.
  corsOrigins: listOpt('CORS_ORIGINS', isProd ? [] : ['http://localhost:5000', 'http://localhost:3000']),

  // ── AdvBox ──────────────────────────────────────────────────────────────────
  advbox: {
    token:   optional('ADVBOX_TOKEN', ''),
    baseUrl: optional('ADVBOX_BASE_URL', 'https://app.advbox.com.br/api/v1'),
  },

  // ── Meta Ads ────────────────────────────────────────────────────────────────
  meta: {
    token:     optional('META_TOKEN', ''),
    adAccount: optional('META_AD_ACCOUNT', ''),
    apiVersion: optional('META_API_VERSION', 'v19.0'),
  },

  // ── ChatGuru ────────────────────────────────────────────────────────────────
  chatguru: {
    baseUrl:    optional('CHATGURU_BASE_URL', 'https://s22.chatguru.app/api/v1'),
    accountId:  optional('CHATGURU_ACCOUNT_ID', ''),
    phoneId:    optional('CHATGURU_PHONE_ID', ''),
    apiKey:     optional('CHATGURU_API_KEY', ''),
    webhookSecret: optional('CHATGURU_WEBHOOK_SECRET', ''),
  },

  // ── Banco ───────────────────────────────────────────────────────────────────
  db: {
    url:     optional('DATABASE_URL', ''),
    poolMax: intOpt('DB_POOL_MAX', 10),
  },

  // ── Limites ─────────────────────────────────────────────────────────────────
  limits: {
    bodyJson:        optional('LIMIT_BODY_JSON', '1mb'),
    uploadFileBytes: intOpt('LIMIT_UPLOAD_BYTES', 15 * 1024 * 1024),
    rateLoginMax:    intOpt('RATE_LOGIN_MAX', 5),
    rateLoginWindowMs: intOpt('RATE_LOGIN_WINDOW_MS', 15 * 60 * 1000),
    rateApiMax:      intOpt('RATE_API_MAX', 600),
    rateApiWindowMs: intOpt('RATE_API_WINDOW_MS', 60 * 1000),
  },
});

// ── Avisos não-fatais no boot ────────────────────────────────────────────────
function warnings() {
  const w = [];
  if (!config.advbox.token)      w.push('ADVBOX_TOKEN não configurado — endpoints AdvBox vão retornar erro.');
  if (!config.db.url)            w.push('DATABASE_URL não configurado — leads/aniversários/auditoria desativados.');
  if (!config.readApiKey)        w.push('READ_API_KEY não configurada — autenticação por API Key desativada.');
  if (!config.users.admin.password && !config.users.team.password) {
    w.push('Nenhuma senha de usuário configurada (ADMIN_PASS / TEAM_PASS) — login não funcionará.');
  }
  if (!config.isProd && config.corsOrigins.length === 0) {
    w.push('CORS_ORIGINS vazio em modo dev — usando localhost:5000 e :3000.');
  }
  return w;
}

module.exports = { config, warnings };
