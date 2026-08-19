/**
 * Unit tests pra utils/circuitBreaker.js — máquina de estados.
 *
 * Usa um breaker fresh por test pra não compartilhar estado entre suites.
 * resetTimeoutMs baixinho (50ms) pra testar a transição half-open em
 * tempo real sem deixar a suite lenta.
 */

'use strict';

require('../_test-env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { CircuitBreaker } = require('../../utils/circuitBreaker');

const ok    = () => Promise.resolve('success');
const fail  = () => Promise.reject(new Error('boom'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('CircuitBreaker — estado inicial', () => {
  it('começa fechado, calls passam', async () => {
    const br = new CircuitBreaker({ name: 't1' });
    const result = await br.exec(ok);
    assert.equal(result, 'success');
    assert.equal(br.state, 'closed');
    assert.equal(br.metrics.successes, 1);
  });

  it('1 falha não abre', async () => {
    const br = new CircuitBreaker({ name: 't2', failureThreshold: 3 });
    await assert.rejects(br.exec(fail));
    assert.equal(br.state, 'closed');
    assert.equal(br.failureCount, 1);
  });
});

describe('CircuitBreaker — abertura', () => {
  it('abre após failureThreshold falhas consecutivas', async () => {
    const br = new CircuitBreaker({ name: 't3', failureThreshold: 3 });
    for (let i = 0; i < 3; i++) await assert.rejects(br.exec(fail));
    assert.equal(br.state, 'open');
    assert.equal(br.metrics.opens, 1);
  });

  it('quando aberto, rejeita imediatamente sem chamar fn', async () => {
    const br = new CircuitBreaker({ name: 't4', failureThreshold: 1 });
    await assert.rejects(br.exec(fail));
    assert.equal(br.state, 'open');

    let called = false;
    await assert.rejects(
      br.exec(() => { called = true; return Promise.resolve(); }),
      (err) => err.code === 'CIRCUIT_OPEN'
    );
    assert.equal(called, false, 'fn não devia ter rodado');
    assert.equal(br.metrics.rejections, 1);
  });

  it('erro CIRCUIT_OPEN tem retryAfterSec e status 503', async () => {
    const br = new CircuitBreaker({ name: 't5', failureThreshold: 1, resetTimeoutMs: 30000 });
    await assert.rejects(br.exec(fail));
    try {
      await br.exec(ok);
      assert.fail('deveria ter rejected');
    } catch (err) {
      assert.equal(err.code, 'CIRCUIT_OPEN');
      assert.equal(err.status, 503);
      assert.equal(err.breaker, 't5');
      assert.ok(Number.isFinite(err.retryAfterSec));
      assert.ok(err.retryAfterSec > 0);
    }
  });
});

describe('CircuitBreaker — half-open + recovery', () => {
  it('após resetTimeoutMs transiciona pra half-open na próxima call', async () => {
    const br = new CircuitBreaker({ name: 't6', failureThreshold: 1, resetTimeoutMs: 30 });
    await assert.rejects(br.exec(fail));
    assert.equal(br.state, 'open');
    await sleep(50);
    // Próxima call: half-open trial → sucesso → closed
    const result = await br.exec(ok);
    assert.equal(result, 'success');
    assert.equal(br.state, 'closed');
    assert.equal(br.failureCount, 0);
  });

  it('trial em half-open com falha re-abre imediatamente', async () => {
    const br = new CircuitBreaker({ name: 't7', failureThreshold: 1, resetTimeoutMs: 30 });
    await assert.rejects(br.exec(fail));
    await sleep(50);
    await assert.rejects(br.exec(fail));
    assert.equal(br.state, 'open');
    assert.equal(br.metrics.opens, 2);  // contou nova abertura
  });
});

describe('CircuitBreaker — reset() manual', () => {
  it('reset força closed mesmo com falhas', async () => {
    const br = new CircuitBreaker({ name: 't8', failureThreshold: 2 });
    await assert.rejects(br.exec(fail));
    await assert.rejects(br.exec(fail));
    assert.equal(br.state, 'open');
    br.reset();
    assert.equal(br.state, 'closed');
    assert.equal(br.failureCount, 0);
  });
});

describe('CircuitBreaker — status()', () => {
  it('retorna snapshot serializável', async () => {
    const br = new CircuitBreaker({ name: 't9', failureThreshold: 3, resetTimeoutMs: 5000 });
    await br.exec(ok);
    await assert.rejects(br.exec(fail));
    const s = br.status();
    assert.equal(s.name, 't9');
    assert.equal(s.state, 'closed');
    assert.equal(s.failureCount, 1);
    assert.equal(s.metrics.calls, 2);
    assert.equal(s.metrics.successes, 1);
    assert.equal(s.metrics.failures, 1);
    assert.ok(s.lastSuccessAt);
    assert.ok(s.lastFailureAt);
    assert.equal(s.config.failureThreshold, 3);
    assert.equal(s.config.resetTimeoutMs, 5000);
    // serializável?
    assert.doesNotThrow(() => JSON.stringify(s));
  });
});

describe('CircuitBreaker — contadores não param ao abrir', () => {
  it('successes em uma run mista zera o failureCount', async () => {
    const br = new CircuitBreaker({ name: 't10', failureThreshold: 5 });
    await assert.rejects(br.exec(fail));
    await assert.rejects(br.exec(fail));
    await br.exec(ok);  // sucesso!
    assert.equal(br.failureCount, 0);
    // Próximas 5 falhas, em sequência, abrem:
    for (let i = 0; i < 5; i++) await assert.rejects(br.exec(fail));
    assert.equal(br.state, 'open');
  });
});
