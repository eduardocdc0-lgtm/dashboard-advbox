/**
 * Comparação de strings em tempo constante — defesa contra timing attacks.
 *
 * Uso: validar tokens, API keys, secrets de webhook, etc.
 *
 *   if (safeCompare(received, expected)) { ... }
 */

'use strict';

const crypto = require('crypto');

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual exige buffers do mesmo tamanho — se tamanhos diferem,
  // ainda fazemos a comparação (com buffer dummy) pra manter o tempo constante
  if (bufA.length !== bufB.length) {
    // executa um compare dummy para gastar o mesmo tempo
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { safeCompare };
