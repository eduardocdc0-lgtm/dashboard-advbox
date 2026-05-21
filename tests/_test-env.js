/**
 * Env setup compartilhado entre testes.
 *
 * Define os mínimos necessários pra que require('../config') não dê fatal
 * em testes que tocam módulos do app (validate.js → errorHandler → config,
 * access-log → db → config, advbox-client → config, etc).
 *
 * Mantém os testes rodáveis em qualquer máquina sem precisar de .env real.
 * NÃO sobrescreve valores que já existem na env (X || default) — assim CI
 * ou dev pode setar overrides quando preciso.
 *
 * IMPORTANTE: este arquivo precisa ser required ANTES de qualquer outro
 * require que possa pegar config indirectly. Padrão:
 *
 *   require('../_test-env');   // <-- linha 1
 *   const { describe, it } = require('node:test');
 *   const { foo } = require('../../utils/foo');
 */

'use strict';

process.env.SESSION_SECRET      = process.env.SESSION_SECRET      || 'test-only-session-secret-not-for-prod-32bytes-min';
process.env.NODE_ENV            = process.env.NODE_ENV            || 'development';
process.env.AUTH_REQUIRE_BCRYPT = process.env.AUTH_REQUIRE_BCRYPT || 'false';
// DATABASE_URL fica vazio propositalmente — testes unitários não devem bater no DB.
