/**
 * Unit tests pra services/advbox-client.js — detecção de truncamento.
 *
 * Stub do `request` direto na instância pra não bater na API real.
 * Verifica que truncamento é detectado APENAS quando o loop sai pelo cap
 * com a última página cheia (não quando termina natural).
 */

'use strict';

require('../_test-env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const AdvBoxClient = require('../../services/advbox-client');
const { getPaginationStats } = AdvBoxClient;

// Stub-friendly subclass — sobreescreve request() pra retornar páginas controladas
function makeClient(pageResponses) {
  const client = new AdvBoxClient('dummy-token', {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  let pageIndex = 0;
  client.request = async () => pageResponses[pageIndex++] ?? [];
  return client;
}

describe('getAllLawsuits — saída natural (sem truncamento)', () => {
  it('para quando recebe página vazia', async () => {
    const client = makeClient([
      Array(500).fill({ id: 1, stage: 'X' }),    // página cheia
      [],                                          // página vazia → para
    ]);
    const before = getPaginationStats().lawsuits?.count || 0;
    const result = await client.getAllLawsuits(500, 10);
    assert.equal(result.length, 500);
    const after = getPaginationStats().lawsuits?.count || 0;
    assert.equal(after, before, 'NÃO devia ter contado truncamento');
  });

  it('para quando recebe página parcial', async () => {
    const client = makeClient([
      Array(500).fill({ id: 1 }),
      Array(123).fill({ id: 2 }),                 // < pageSize → fim natural
    ]);
    const before = getPaginationStats().lawsuits?.count || 0;
    const result = await client.getAllLawsuits(500, 10);
    assert.equal(result.length, 623);
    const after = getPaginationStats().lawsuits?.count || 0;
    assert.equal(after, before);
  });
});

describe('getAllLawsuits — truncamento por cap', () => {
  it('detecta quando sai pelo maxPages com última página CHEIA', async () => {
    const fullPages = Array.from({ length: 5 }, () => Array(500).fill({ id: 1 }));
    const client = makeClient(fullPages);
    const before = getPaginationStats().lawsuits?.count || 0;
    const result = await client.getAllLawsuits(500, 5);  // cap = 5, todas cheias
    assert.equal(result.length, 2500);
    const after = getPaginationStats().lawsuits;
    assert.equal(after.count, before + 1, 'deveria ter incrementado truncamento');
    assert.equal(after.lastFetched, 2500);
    assert.equal(after.lastMaxPages, 5);
    assert.equal(after.lastPageSize, 500);
    assert.equal(after.envVarToBump, 'ADVBOX_MAX_PAGES_LAWSUITS');
    assert.ok(after.lastAt);
  });
});

describe('getAllTransactions — dedup break vs truncamento', () => {
  it('NÃO conta truncamento quando o break é por API ignorando offset (added=0)', async () => {
    const t1 = { id: 1 };
    const t2 = { id: 2 };
    const client = makeClient([
      [t1, t2],                                    // 2 itens, added=2
      [t1, t2],                                    // mesmos itens, added=0 → break por dedup
    ]);
    const before = getPaginationStats().transactions?.count || 0;
    const result = await client.getAllTransactions(2, 10);
    assert.equal(result.length, 2);
    const after = getPaginationStats().transactions?.count || 0;
    assert.equal(after, before, 'dedup break NÃO é truncamento');
  });
});

describe('getPaginationStats() shape', () => {
  it('retorna objeto vazio ou com chaves de recursos', () => {
    const s = getPaginationStats();
    assert.equal(typeof s, 'object');
    // Cada entrada (se existir) tem os campos esperados
    for (const [resource, stat] of Object.entries(s)) {
      assert.ok(['lawsuits', 'transactions', 'customers'].includes(resource));
      assert.ok('count' in stat);
      assert.ok('envVarToBump' in stat);
    }
  });

  it('é serializável', () => {
    assert.doesNotThrow(() => JSON.stringify(getPaginationStats()));
  });
});
