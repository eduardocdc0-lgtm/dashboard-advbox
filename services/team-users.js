/**
 * Mapeamento de usuários do dashboard ↔ usuários do AdvBox.
 *
 * Cada entrada permite que esse usuário logue no dashboard e veja
 * APENAS os problemas atribuídos a ele no AdvBox.
 *
 * Senhas vêm de variáveis de ambiente (.env) pra não ficarem no git.
 *   ADV_USER_MARILIA=senha-forte-aqui
 *   ADV_USER_LETICIA=senha-forte-aqui
 *   ...
 *
 * advboxUserId: ID do usuário no AdvBox (settings.users[].id).
 * Pra descobrir: GET /api/settings ou no Python `from advbox_api import AdvBoxAPI; AdvBoxAPI().settings()['users']`.
 */

'use strict';

// EDITE AQUI conforme o time do escritório.
// O `username` é o que a pessoa digita no login.
// O `advboxUserId` precisa bater com settings.users[].id no AdvBox.
const TEAM_USERS = [
  // { username: 'marilia',  password: process.env.ADV_USER_MARILIA,  advboxUserId: 213554, role: 'team', name: 'Ana Marília' },
  // { username: 'leticia',  password: process.env.ADV_USER_LETICIA,  advboxUserId: 0,      role: 'team', name: 'Letícia Stephany' },
  // { username: 'alice',    password: process.env.ADV_USER_ALICE,    advboxUserId: 0,      role: 'team', name: 'Alice' },
  // { username: 'cau',      password: process.env.ADV_USER_CAU,      advboxUserId: 0,      role: 'team', name: 'Claudiana' },
  // { username: 'tammyres', password: process.env.ADV_USER_TAMMYRES, advboxUserId: 0,      role: 'team', name: 'Tammyres' },
  // { username: 'eduardo',  password: process.env.ADV_USER_EDUARDO,  advboxUserId: 198347, role: 'admin', name: 'Eduardo Rodrigues' },
];

/**
 * Retorna objeto user se username/password baterem. Null caso contrário.
 */
function findTeamUser(username, password) {
  if (!username || !password) return null;
  const u = TEAM_USERS.find(x => x.username === username);
  if (!u) return null;
  if (!u.password) return null; // env var não setada
  if (u.password !== password) return null;
  return u;
}

/**
 * Retorna o user_id do AdvBox associado ao session.user, ou null se admin global.
 */
function advboxUserIdFromSession(sessionUser) {
  if (!sessionUser) return null;
  if (sessionUser.role === 'admin') return null; // admin vê tudo, sem filtro
  return sessionUser.advboxUserId || null;
}

module.exports = { TEAM_USERS, findTeamUser, advboxUserIdFromSession };
