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
  // SESSION_KEYS (CSV) ou SESSION_SECRET (legacy single string).
  // Preferir SESSION_KEYS pra rotação gradual sem invalidar sessões existentes:
  //   1. Gera nova key: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  //   2. SESSION_KEYS=NOVA,ANTIGA  (nova entra na frente — cookie-session assina com a primeira, valida com todas)
  //   3. Espera 12h (maxAge default) — todas as sessões antigas expiraram naturalmente
  //   4. SESSION_KEYS=NOVA  (remove a antiga)
  // Cadência recomendada: trimestral, OU imediato após saída de membro de equipe com acesso ao Replit.
  session: (() => {
    const keysList = listOpt('SESSION_KEYS', []);
    if (keysList.length > 0) {
      return { keys: keysList, maxAgeMs: intOpt('SESSION_MAX_AGE_MS', 12 * 60 * 60 * 1000), secure: isProd };
    }
    // Fallback: SESSION_SECRET single (legacy)
    const single = required('SESSION_SECRET', 'gerar com `node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"` — ou usar SESSION_KEYS (CSV) pra suportar rotação');
    return { keys: [single], maxAgeMs: intOpt('SESSION_MAX_AGE_MS', 12 * 60 * 60 * 1000), secure: isProd };
  })(),

  // ── Auth / senhas ───────────────────────────────────────────────────────────
  // requireBcrypt: quando true, login só aceita *_PASS_HASH (bcrypt). Senhas
  // em texto puro (*_PASS, ADV_USER_<NOME>) são IGNORADAS — verifyPassword
  // ainda gasta o tempo do bcrypt contra dummy pra não vazar timing, mas
  // retorna false. Default: true em prod, false em dev (pra rodar local sem
  // gerar hash). Override via AUTH_REQUIRE_BCRYPT=true|false.
  //
  // Migração: `node scripts/hash-password.js` → cola em *_HASH (Replit Secrets).
  // Boot vai FALHAR (throw) se requireBcrypt=true e algum *_PASS estiver
  // setado sem o *_HASH correspondente — força a migração antes do deploy.
  auth: {
    requireBcrypt: (() => {
      const raw = process.env.AUTH_REQUIRE_BCRYPT;
      if (raw === 'true')  return true;
      if (raw === 'false') return false;
      return isProd;
    })(),
  },

  // ── Usuários ────────────────────────────────────────────────────────────────
  // Perfis genéricos (admin/team) — herdados da época pré-multi-user.
  // Em prod: setar APENAS *_HASH (gerar com scripts/hash-password.js).
  // Em dev: pode usar *_PASS direto enquanto AUTH_REQUIRE_BCRYPT=false.
  users: {
    admin: {
      username:     optional('ADMIN_USER', 'eduardo'),
      password:     optional('ADMIN_PASS', ''),
      passwordHash: optional('ADMIN_PASS_HASH', ''),
    },
    team: {
      username:     optional('TEAM_USER', 'time'),
      password:     optional('TEAM_PASS', ''),
      passwordHash: optional('TEAM_PASS_HASH', ''),
    },
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

  // ── RPV ─────────────────────────────────────────────────────────────────────
  // Valor uniforme atribuído à fase "RPV DO MÊS" no relatório de auditoria.
  // Reajustado anualmente (piso federal). Default 6648 reflete tabela 2026.
  rpv: {
    valorFixoMes: intOpt('RPV_VALOR_FIXO_MES', 6648),
  },

  // ── Banco ───────────────────────────────────────────────────────────────────
  // poolMax default 15: dimensionado pra suportar (a) 1 conexão dedicada do
  // advisory lock do auto-workflow durante ciclos longos, (b) 2-3 conexões dos
  // outros crons (briefing, snapshot) rodando em paralelo, (c) ~10 requests
  // concorrentes da equipe sem timeout. Em containers muito pequenos pode
  // baixar pra 10; abaixo disso o boot emite WARN porque histórico mostrou
  // timeouts sob carga moderada.
  db: {
    url:     optional('DATABASE_URL', ''),
    poolMax: intOpt('DB_POOL_MAX', 15),
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

// ── Validação FATAL de auth (executa no require, antes do boot) ─────────────
// Quando AUTH_REQUIRE_BCRYPT=true, qualquer credencial em texto puro sem o
// hash correspondente é fatal — o processo nem chega a abrir porta. Isso
// impede deploy acidental com .env legado.
(function validateAuth() {
  if (!config.auth.requireBcrypt) return;

  const violations = [];
  if (config.users.admin.password && !config.users.admin.passwordHash) {
    violations.push('ADMIN_PASS está setado em texto puro mas ADMIN_PASS_HASH não está.');
  }
  if (config.users.team.password && !config.users.team.passwordHash) {
    violations.push('TEAM_PASS está setado em texto puro mas TEAM_PASS_HASH não está.');
  }
  if (violations.length > 0) {
    throw new Error(
      `[config] AUTH_REQUIRE_BCRYPT=true mas credenciais em texto puro foram detectadas:\n` +
      violations.map(v => `  • ${v}`).join('\n') +
      `\n\nPara corrigir:\n` +
      `  1. Gere um hash bcrypt: node scripts/hash-password.js\n` +
      `  2. Cole o hash em *_PASS_HASH (Replit > Secrets, ou .env local)\n` +
      `  3. Remova a env var em texto puro (*_PASS)\n` +
      `  4. Reinicie o app\n\n` +
      `Em desenvolvimento (NODE_ENV=development) plaintext é tolerado por default.`
    );
  }
})();

// ── Avisos não-fatais no boot ────────────────────────────────────────────────
function warnings() {
  const w = [];
  if (!config.advbox.token)      w.push('ADVBOX_TOKEN não configurado — endpoints AdvBox vão retornar erro.');
  if (!config.db.url)            w.push('DATABASE_URL não configurado — leads/aniversários/auditoria desativados.');
  if (config.db.url && config.db.poolMax < 10) {
    w.push(`DB_POOL_MAX=${config.db.poolMax} é baixo — crons + requests podem competir e gerar timeouts. Recomendado: 15.`);
  }
  if (!config.readApiKey)        w.push('READ_API_KEY não configurada — autenticação por API Key desativada.');

  const hasAdminCred = config.users.admin.passwordHash || (!config.auth.requireBcrypt && config.users.admin.password);
  const hasTeamCred  = config.users.team.passwordHash  || (!config.auth.requireBcrypt && config.users.team.password);
  if (!hasAdminCred && !hasTeamCred) {
    w.push('Nenhuma credencial de usuário genérico configurada (*_PASS_HASH ou *_PASS em dev) — só usuários individuais conseguirão logar.');
  }

  // Aviso em dev quando alguém está rodando com plaintext (lembrete pra não deployar assim).
  if (!config.auth.requireBcrypt && (config.users.admin.password || config.users.team.password)) {
    w.push('AUTH_REQUIRE_BCRYPT=false — *_PASS em texto puro aceito (OK em dev, FATAL em prod). Migre antes de deployar.');
  }

  if (!config.isProd && config.corsOrigins.length === 0) {
    w.push('CORS_ORIGINS vazio em modo dev — usando localhost:5000 e :3000.');
  }
  return w;
}

module.exports = { config, warnings };
