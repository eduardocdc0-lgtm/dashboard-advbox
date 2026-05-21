/**
 * Unit tests pra middleware/access-log.js — buffer in-memory.
 *
 * Testa enqueue + overflow + getStats. NÃO testa o flush real (esse precisa
 * de DB ou de mock invasivo do db.query) — fica pra integration test.
 */

'use strict';

require('../_test-env');

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const { accessLog, getStats } = require('../../middleware/access-log');

// Mock do (req, res, next) — só os campos que o middleware lê
function makeReq({ method = 'GET', path = '/api/lawsuits', session } = {}) {
  return { method, path, session };
}
const dummyRes = {};
const dummyNext = () => {};

describe('accessLog middleware — entry filtering', () => {
  it('NÃO enfileira POST', () => {
    const before = getStats().bufferedTotal;
    accessLog(makeReq({ method: 'POST', path: '/api/finance/entries' }), dummyRes, dummyNext);
    assert.equal(getStats().bufferedTotal, before);
  });

  it('NÃO enfileira rotas fora de /api/*', () => {
    const before = getStats().bufferedTotal;
    accessLog(makeReq({ path: '/static/app.js' }), dummyRes, dummyNext);
    assert.equal(getStats().bufferedTotal, before);
  });

  it('NÃO enfileira paths do SKIP_PATHS', () => {
    const before = getStats().bufferedTotal;
    accessLog(makeReq({ path: '/api/healthz' }),     dummyRes, dummyNext);
    accessLog(makeReq({ path: '/api/me' }),          dummyRes, dummyNext);
    accessLog(makeReq({ path: '/api/cache-status' }), dummyRes, dummyNext);
    assert.equal(getStats().bufferedTotal, before);
  });

  it('enfileira GET /api/* normal', () => {
    const before = getStats().bufferedTotal;
    accessLog(makeReq({ path: '/api/lawsuits' }), dummyRes, dummyNext);
    assert.equal(getStats().bufferedTotal, before + 1);
  });

  it('sempre chama next() — não bloqueia a request', () => {
    let called = false;
    accessLog(makeReq(), dummyRes, () => { called = true; });
    assert.equal(called, true);
  });

  it('não quebra se req.session for undefined', () => {
    assert.doesNotThrow(() => accessLog(makeReq({ session: undefined }), dummyRes, dummyNext));
  });
});

describe('getStats() shape', () => {
  it('tem os campos esperados', () => {
    const s = getStats();
    assert.ok('bufferSize' in s);
    assert.ok('bufferCap' in s);
    assert.ok('bufferedTotal' in s);
    assert.ok('flushedTotal' in s);
    assert.ok('droppedTotal' in s);
    assert.ok('lastFlushAt' in s);
    assert.ok('lastFlushError' in s);
    assert.ok('consecutiveFlushFailures' in s);
    assert.ok('flushIntervalSec' in s);
  });

  it('bufferSize ≤ bufferCap', () => {
    const s = getStats();
    assert.ok(s.bufferSize <= s.bufferCap);
  });

  it('é serializável (sem ciclos, sem funções)', () => {
    assert.doesNotThrow(() => JSON.stringify(getStats()));
  });
});

describe('Overflow behavior', () => {
  it('quando excede bufferCap, droppedTotal incrementa', () => {
    const initial = getStats();
    const headroom = initial.bufferCap - initial.bufferSize;
    const overflow = 50; // sufficient pra forçar drops
    const totalToPush = headroom + overflow;

    for (let i = 0; i < totalToPush; i++) {
      accessLog(makeReq({ path: `/api/test-overflow-${i}` }), dummyRes, dummyNext);
    }

    const final = getStats();
    assert.equal(final.bufferSize, final.bufferCap);
    assert.ok(final.droppedTotal >= initial.droppedTotal + overflow);
  });
});
