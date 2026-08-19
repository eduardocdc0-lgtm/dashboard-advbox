/**
 * Mapeamento de usuários do dashboard ↔ usuários do AdvBox + verificação de senha.
 *
 * MIGRAÇÃO bcrypt (concluída — gate em config.auth.requireBcrypt):
 *   - Em prod (AUTH_REQUIRE_BCRYPT=true): só ADV_USER_<NOME>_HASH funciona.
 *     Plaintext (ADV_USER_<NOME>) é ignorado e o boot FALHA se setado sem hash.
 *   - Em dev (AUTH_REQUIRE_BCRYPT=false): plaintext aceito com warning.
 *
 * Geração de hash: `node scripts/hash-password.js`  (prompt interativo).
 *
 * advboxUserId: ID do usuário no AdvBox (settings.users[].id).
 * Pra descobrir: GET /api/settings.
 */

'use strict';

const bcrypt = require('bcryptjs');
const { safeCompare } = require('../utils/safeCompare');
const { config } = require('../config');

const REQUIRE_BCRYPT = config.auth.requireBcrypt;

// Hash dummy com cost 12 — usado pra manter o tempo de resposta constante
// quando username não existe ou env var não está setada. Sem isso, atacante
// pode descobrir quais usernames são válidos só medindo a latência.
const DUMMY_HASH = '$2b$12$qEz3f8w1lp/1iIS1.5lQK.gnkiAXsSdhIYVUPR102jG1xTmHcwsYS';

const TEAM_USERS = [
  { username: 'eduardo',  envBase: 'ADV_USER_EDUARDO',  advboxUserId: 198347, role: 'admin',   name: 'Eduardo Rodrigues' },
  { username: 'marilia',  envBase: 'ADV_USER_MARILIA',  advboxUserId: 213554, role: 'team',    name: 'Ana Marília' },
  { username: 'leticia',  envBase: 'ADV_USER_LETICIA',  advboxUserId: 214014, role: 'team',    name: 'Letícia Stephany' },
  { username: 'alice',    envBase: 'ADV_USER_ALICE',    advboxUserId: 252099, role: 'team',    name: 'Maria Alice' },
  { username: 'cau',      envBase: 'ADV_USER_CAU',      advboxUserId: 236523, role: 'finance', name: 'Claudiana' },
  { username: 'tammyres', envBase: 'ADV_USER_TAMMYRES', advboxUserId: 267371, role: 'team',    name: 'Tammyres' },
  { username: 'thiago',   envBase: 'ADV_USER_THIAGO',   advboxUserId: 224040, role: 'team',    name: 'Thiago Tavares' },
];

function getCredential(envBase) {
  const hash = process.env[`${envBase}_HASH`];
  if (hash) return { kind: 'hash', value: hash };
  // Em prod (requireBcrypt): NÃO aceita texto puro. Trata como "sem credencial".
  if (REQUIRE_BCRYPT) return null;
  const plain = process.env[envBase];
  if (plain) return { kind: 'plain', value: plain };
  return null;
}

// ── Validação FATAL no module load ──────────────────────────────────────────
// Mesma política do config/index.js mas aplicada às vars ADV_USER_*. Roda
// uma vez quando o módulo é required (acontece cedo no boot do dashboard).
(function validateTeamCredentials() {
  if (!REQUIRE_BCRYPT) return;
  const violations = [];
  for (const u of TEAM_USERS) {
    const hasPlain = !!process.env[u.envBase];
    const hasHash  = !!process.env[`${u.envBase}_HASH`];
    if (hasPlain && !hasHash) {
      violations.push(`${u.envBase} (texto puro detectado, ${u.envBase}_HASH ausente)`);
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `[team-users] AUTH_REQUIRE_BCRYPT=true mas há credenciais individuais em texto puro:\n` +
      violations.map(v => `  • ${v}`).join('\n') +
      `\n\nGere os hashes com 'node scripts/hash-password.js', cole em ${'<NOME>_HASH'} (Replit Secrets), e remova as vars em texto puro.`
    );
  }
})();

/**
 * Verifica `password` contra (passwordHash || plaintext) de forma timing-safe.
 * Sempre chama bcrypt.compare uma vez (mesmo no caminho-de-erro) pra que o
 * tempo de resposta não revele se o user existe ou se há credencial setada.
 */
async function verifyPassword(provided, plainEnv, hashEnv) {
  const pwd = String(provided || '');

  if (hashEnv) {
    return bcrypt.compare(pwd, hashEnv);
  }

  // Sem hash setado: gasta o mesmo tempo do bcrypt contra dummy pra não vazar
  // timing, depois checa o plaintext em constant-time (se houver).
  await bcrypt.compare(pwd, DUMMY_HASH);
  if (!plainEnv) return false;
  return safeCompare(pwd, String(plainEnv));
}

/**
 * Retorna o user da equipe se username/password baterem. Null caso contrário.
 * SEMPRE async — caller precisa await.
 */
async function findTeamUser(username, password) {
  const u = TEAM_USERS.find(x => x.username === username);
  const cred = u ? getCredential(u.envBase) : null;

  if (!u || !cred) {
    // Timing-safe path: gasta o mesmo bcrypt do happy path.
    await bcrypt.compare(String(password || ''), DUMMY_HASH);
    return null;
  }

  const ok = await verifyPassword(password, cred.kind === 'plain' ? cred.value : null,
                                            cred.kind === 'hash'  ? cred.value : null);
  if (!ok) return null;

  if (cred.kind === 'plain') {
    // eslint-disable-next-line no-console
    console.warn(`[Auth] Login OK pra '${u.username}' usando ${u.envBase} em TEXTO PURO. Gere ${u.envBase}_HASH com 'node scripts/hash-password.js' e migre.`);
  }
  return u;
}

function advboxUserIdFromSession(sessionUser) {
  if (!sessionUser) return null;
  if (sessionUser.role === 'admin') return null;
  return sessionUser.advboxUserId || null;
}

module.exports = { TEAM_USERS, findTeamUser, verifyPassword, advboxUserIdFromSession };
