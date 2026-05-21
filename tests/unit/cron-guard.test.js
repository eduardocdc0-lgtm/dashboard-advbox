/**
 * Unit tests pra services/jobs-registry.js — cronGuard wrapper.
 *
 * Mantém DISCORD_WEBHOOK_URL desligado pra que sendCronAlert no-op
 * (evita HTTP real e simplifica os asserts).
 */

'use strict';

require('../_test-env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Garante que sendCronAlert seja no-op
delete process.env.DISCORD_WEBHOOK_URL;

const { register, snapshot, cronGuard } = require('../../services/jobs-registry');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function getJob(name) {
  return snapshot().find(j => j.name === name);
}

describe('cronGuard — happy path', () => {
  it('executa fn e retorna result em sucesso', async () => {
    register('guard-test-1', { status: 'running' });
    const result = await cronGuard('guard-test-1', async () => 'ok', { logger: silentLogger });
    assert.equal(result, 'ok');
    const j = getJob('guard-test-1');
    assert.equal(j.consecutiveFailures, 0);
    assert.equal(j.totalRuns, 1);
    assert.ok(j.lastSuccessAt);
  });
});

describe('cronGuard — failure tracking', () => {
  it('1 falha incrementa consecutiveFailures mas não alerta', async () => {
    register('guard-test-2', { status: 'running' });
    await cronGuard('guard-test-2', async () => { throw new Error('boom'); }, { logger: silentLogger, alertAfter: 2 });
    const j = getJob('guard-test-2');
    assert.equal(j.consecutiveFailures, 1);
    assert.equal(j.totalFailures, 1);
    assert.ok(j.lastFailureAt);
    assert.match(j.lastError, /boom/);
  });

  it('falhas consecutivas continuam acumulando', async () => {
    register('guard-test-3', { status: 'running' });
    for (let i = 0; i < 5; i++) {
      await cronGuard('guard-test-3', async () => { throw new Error('boom'); }, { logger: silentLogger });
    }
    const j = getJob('guard-test-3');
    assert.equal(j.consecutiveFailures, 5);
    assert.equal(j.totalFailures, 5);
    assert.equal(j.totalRuns, 5);
  });

  it('NÃO re-throwa o erro pro caller', async () => {
    register('guard-test-4', { status: 'running' });
    // Se re-throwasse, este await rejeitaria
    await assert.doesNotReject(
      cronGuard('guard-test-4', async () => { throw new Error('boom'); }, { logger: silentLogger })
    );
  });
});

describe('cronGuard — recovery', () => {
  it('sucesso após falhas zera consecutiveFailures mas mantém totalFailures', async () => {
    register('guard-test-5', { status: 'running' });
    await cronGuard('guard-test-5', async () => { throw new Error('x'); }, { logger: silentLogger });
    await cronGuard('guard-test-5', async () => { throw new Error('x'); }, { logger: silentLogger });
    await cronGuard('guard-test-5', async () => 'ok',                    { logger: silentLogger });

    const j = getJob('guard-test-5');
    assert.equal(j.consecutiveFailures, 0);
    assert.equal(j.totalFailures, 2);
    assert.equal(j.totalRuns, 3);
  });
});

describe('cronGuard — job desconhecido', () => {
  it('não quebra se cronGuard rodar antes de register()', async () => {
    // Não registramos 'guard-orphan' propositalmente
    await assert.doesNotReject(
      cronGuard('guard-orphan', async () => 'ok', { logger: silentLogger })
    );
    // Também não quebra em falha
    await assert.doesNotReject(
      cronGuard('guard-orphan', async () => { throw new Error('x'); }, { logger: silentLogger })
    );
  });
});

describe('cronGuard — alertAfter customizado', () => {
  it('aceita alertAfter override (não verifica alert real porque DISCORD_WEBHOOK_URL=desligado)', async () => {
    register('guard-test-6', { status: 'running' });
    // Só checa que aceita o param e não explode
    await cronGuard('guard-test-6', async () => { throw new Error('x'); }, { logger: silentLogger, alertAfter: 10 });
    const j = getJob('guard-test-6');
    assert.equal(j.consecutiveFailures, 1);
  });
});
