#!/usr/bin/env node
/**
 * Verifica que o advisory lock do auto-workflow funciona como esperado.
 *
 * Cenário testado:
 *   1. Adquire pg_advisory_lock(902301) em uma sessão de teste (paralela).
 *   2. Chama runCycle({ dryRun: true }) — deve detectar o lock ocupado
 *      e retornar { skipped: true, reason: 'lock_held' } sem fazer nada.
 *   3. Libera o lock.
 *
 * O que isso prova: dois ciclos concorrentes nunca executam simultaneamente.
 * Se runCycle proceder mesmo com o lock ocupado, este script falha e sai com
 * código != 0 — protege contra regressões futuras na lógica de locking.
 *
 * O que isso NÃO prova: o caminho feliz (lock livre → ciclo roda). Esse é
 * exercitado em produção a cada hora pelo cron — não precisa de teste extra.
 *
 * Uso:
 *   DATABASE_URL=... node scripts/verify-advisory-lock.js
 *   # ou:
 *   node --env-file=.env scripts/verify-advisory-lock.js
 *
 * Exit codes:
 *   0 = PASS
 *   1 = FAIL (lock não foi detectado, ou outro problema funcional)
 *   2 = ENV ERROR (DATABASE_URL ausente, etc.)
 */

'use strict';

const LOCK_ID = 902301; // espelha AUTO_WORKFLOW_LOCK_ID em services/auto-workflow.js

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERRO: DATABASE_URL não está setada. Rode com --env-file=.env ou exporte a var antes.');
    process.exit(2);
  }

  // Imports tardios pra que a checagem de env acima dispare antes do require
  // tentar construir o pool com URL vazia.
  const { pool } = require('../services/db');
  const { runCycle, ensureTables } = require('../services/auto-workflow');

  console.log('[1/4] Garantindo que as tabelas do auto-workflow existem...');
  await ensureTables();

  console.log(`[2/4] Adquirindo pg_advisory_lock(${LOCK_ID}) em sessão de teste...`);
  const blocker = await pool.connect();
  let blockerHoldsLock = false;
  try {
    const r = await blocker.query('SELECT pg_try_advisory_lock($1) AS got', [LOCK_ID]);
    blockerHoldsLock = r.rows[0].got;
    if (!blockerHoldsLock) {
      console.error(
        `FALHA: lock ${LOCK_ID} já está ocupado por outra sessão. ` +
        `Algum runCycle está em execução? Pare o cron, espere terminar, ou abra ` +
        `psql e veja: SELECT * FROM pg_locks WHERE locktype='advisory';`
      );
      process.exit(1);
    }
    console.log(`     ✓ Lock ${LOCK_ID} adquirido pela sessão de teste`);

    console.log('[3/4] Chamando runCycle({ dryRun: true }) — deve abandonar...');
    const result = await runCycle({ dryRun: true, logger: silentLogger });

    const ok = result && result.skipped === true && result.reason === 'lock_held';
    if (!ok) {
      console.error(
        `FALHA: runCycle não detectou o lock ocupado.\n` +
        `       Resultado recebido: ${JSON.stringify(result, null, 2)}\n` +
        `       Esperado: { skipped: true, reason: 'lock_held', ... }`
      );
      process.exit(1);
    }
    console.log(`     ✓ runCycle retornou { skipped: true, reason: 'lock_held' }`);

  } finally {
    console.log('[4/4] Liberando lock e fechando pool...');
    if (blockerHoldsLock) {
      await blocker.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(err => {
        console.warn(`     ⚠ Falha ao liberar lock: ${err.message} (sessão vai fechar mesmo assim)`);
      });
    }
    blocker.release();
    await pool.end().catch(() => {});
  }

  console.log('\n✅ PASS — proteção contra ciclos concorrentes do auto-workflow está funcionando.');
}

main().catch(err => {
  console.error('FALHA (exceção não tratada):', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
