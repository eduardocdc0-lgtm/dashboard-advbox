/**
 * SmartCache — cache em memória com TTL por chave, deduplicação de requests
 * concorrentes, invalidação manual e métricas.
 *
 * Melhorias vs versão anterior:
 *   - Limite de chaves (LRU simples por uso) — evita crescimento infinito
 *   - Métricas: hit/miss/refresh
 *   - status() inclui contadores
 *   - getOrFetch propaga rejeição mas reseta promise (sem cache de erro)
 */

'use strict';

const DEFAULT_MAX_KEYS = 200;

class CacheEntry {
  constructor(ttlMs) {
    this.ttlMs     = ttlMs;
    this.data      = null;
    this.fetchedAt = null;
    this.lastUsed  = null;
    this.promise   = null;
  }

  isStale() {
    if (!this.fetchedAt || this.data === null) return true;
    return Date.now() - this.fetchedAt > this.ttlMs;
  }

  set(data) {
    this.data      = data;
    this.fetchedAt = Date.now();
    this.lastUsed  = Date.now();
    this.promise   = null;
    return data;
  }

  touch() {
    this.lastUsed = Date.now();
  }

  invalidate() {
    this.data      = null;
    this.fetchedAt = null;
    this.promise   = null;
  }
}

class SmartCache {
  constructor({ maxKeys = DEFAULT_MAX_KEYS } = {}) {
    this._store     = new Map();
    this.maxKeys    = maxKeys;
    this.metrics    = { hits: 0, misses: 0, refreshes: 0, errors: 0, evictions: 0 };
  }

  define(key, ttlMs) {
    if (!this._store.has(key)) this._store.set(key, new CacheEntry(ttlMs));
    return this;
  }

  _entry(key, ttlMs = 0) {
    if (!this._store.has(key)) {
      this._evictIfNeeded();
      this._store.set(key, new CacheEntry(ttlMs));
    }
    return this._store.get(key);
  }

  _evictIfNeeded() {
    if (this._store.size < this.maxKeys) return;
    // Evita LRU: descarta a chave com `lastUsed` mais antigo
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, e] of this._store) {
      const t = e.lastUsed || 0;
      if (t < oldestTime) { oldestTime = t; oldestKey = k; }
    }
    if (oldestKey) {
      this._store.delete(oldestKey);
      this.metrics.evictions++;
    }
  }

  isStale(key)  { return this._entry(key).isStale(); }

  getData(key) {
    const e = this._entry(key);
    if (e.data !== null) e.touch();
    return e.data;
  }

  set(key, data) { return this._entry(key).set(data); }

  invalidate(key) {
    if (this._store.has(key)) this._store.get(key).invalidate();
    return this;
  }

  invalidateAll() {
    for (const e of this._store.values()) e.invalidate();
    return this;
  }

  invalidatePattern(prefix) {
    for (const [k, e] of this._store) {
      if (k.startsWith(prefix)) e.invalidate();
    }
    return this;
  }

  async getOrFetch(key, fetcher, force = false) {
    const entry = this._entry(key);

    if (!force && !entry.isStale() && entry.data !== null) {
      this.metrics.hits++;
      entry.touch();
      return entry.data;
    }

    if (entry.promise) {
      // Outra request já está buscando — aguarda a mesma promise (dedup)
      return entry.promise;
    }

    if (force) this.metrics.refreshes++;
    else       this.metrics.misses++;

    entry.promise = Promise.resolve()
      .then(() => fetcher())
      .then(data => entry.set(data))
      .catch(err => {
        this.metrics.errors++;
        entry.promise = null;
        throw err;
      });

    return entry.promise;
  }

  status() {
    const entries = {};
    for (const [key, e] of this._store) {
      entries[key] = {
        stale:     e.isStale(),
        fetchedAt: e.fetchedAt ? new Date(e.fetchedAt).toISOString() : null,
        lastUsed:  e.lastUsed  ? new Date(e.lastUsed).toISOString()  : null,
        ttlMin:    Math.round(e.ttlMs / 60000),
        pending:   !!e.promise,
        sizeApprox: e.data ? approximateSize(e.data) : 0,
      };
    }
    return {
      entries,
      metrics: { ...this.metrics },
      size:    this._store.size,
      maxKeys: this.maxKeys,
    };
  }
}

function approximateSize(obj) {
  try { return JSON.stringify(obj).length; }
  catch { return -1; }
}

module.exports = new SmartCache();
module.exports.SmartCache = SmartCache;
