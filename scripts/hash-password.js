#!/usr/bin/env node
/**
 * Gera um hash bcrypt cost 12 da senha digitada (sem ecoar no terminal).
 *
 * Uso:
 *   node scripts/hash-password.js
 *
 * Depois cola o hash gerado no Replit Secrets como `<NOME>_HASH`
 * (ex: ADV_USER_MARILIA_HASH, ADMIN_PASS_HASH). Quando todos os
 * usuários estiverem migrados, remover as env vars de texto puro
 * (ex: ADV_USER_MARILIA, ADMIN_PASS).
 */

'use strict';

const bcrypt = require('bcryptjs');

if (!process.stdin.isTTY) {
  console.error('Erro: rode este script num terminal interativo (sem pipe/redirect).');
  process.exit(2);
}

process.stderr.write('Senha (não vai aparecer): ');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');

let pwd = '';

process.stdin.on('data', (chunk) => {
  for (const ch of chunk) {
    const code = ch.charCodeAt(0);
    if (code === 13 || code === 10) {       // Enter
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
      if (!pwd) {
        console.error('Senha vazia — abortando.');
        process.exit(1);
      }
      const hash = bcrypt.hashSync(pwd, 12);
      console.log(hash);
      process.exit(0);
    } else if (code === 3) {                // Ctrl+C
      process.stderr.write('\n^C\n');
      process.exit(130);
    } else if (code === 127 || code === 8) { // Backspace
      pwd = pwd.slice(0, -1);
    } else if (code >= 32) {
      pwd += ch;
    }
  }
});
