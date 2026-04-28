/**
 * SmartCache — cache em memória com TTLs por chave, invalidação manual e deduplicação de requests concorrentes.
 *
 * Uso:
 *   cache.define('lawsuits', 20 * 60 * 1000);
 *   const data = await cache.getOrFetch('lawsuits', fetcher, force);
 *   cache.invalidate('lawsuits');
 *   cache.status();
 */

class CacheEntry {
  constructor(ttlMs) {
    this.ttlMs     = ttlMs;
    this.data      = null;
    this.fetchedAt = null;
    this.promise   = null;
  }

  isStale() {
    if (!this.fetchedAt || this.data === null) return true;
    return Date.now() - this.fetchedAt > this.ttlMs;
  }

  set(data) {
    this.data      = data;
    this.fetchedAt = Date.now();
    this.promise   = null;
    return data;
  }

  invalidate() {
    this.data      = null;
    this.fetchedAt = null;
    this.promise   = null;
  }
}

class SmartCache {
  constructor() {
    this._store = {};
  }

  define(key, ttlMs) {
    if (!this._store[key]) this._store[key] = new CacheEntry(ttlMs);
    return this;
  }

  _entry(key, ttlMs = 0) {
    if (!this._store[key]) this._store[key] = new CacheEntry(ttlMs);
    return this._store[key];
  }

  isStale(key) { return this._entry(key).isStale(); }
  getData(key) { return this._entry(key).data; }

  set(key, data) { return this._entry(key).set(data); }

  invalidate(key) {
    this._entry(key).invalidate();
    return this;
  }

  invalidateAll() {
    Object.values(this._store).forEach(e => e.invalidate());
    return this;
  }

  invalidatePattern(prefix) {
    Object.keys(this._store)
      .filter(k => k.startsWith(prefix))
      .forEach(k => this._store[k].invalidate());
    return this;
  }

  /**
   * Busca dado do cache ou executa o fetcher.
   * Deduplica requests concorrentes: se já há uma promise pendente, aguarda ela.
   */
  async getOrFetch(key, fetcher, force = false) {
    const entry = this._entry(key);

    if (!force && !entry.isStale() && entry.data !== null) {
      return entry.data;
    }

    if (entry.promise) return entry.promise;

    entry.promise = Promise.resolve()
      .then(() => fetcher())
      .then(data => entry.set(data))
      .catch(err => {
        entry.promise = null;
        throw err;
      });

    return entry.promise;
  }

  status() {
    const out = {};
    for (const [key, e] of Object.entries(this._store)) {
      out[key] = {
        stale:     e.isStale(),
        fetchedAt: e.fetchedAt ? new Date(e.fetchedAt).toISOString() : null,
        ttlMin:    Math.round(e.ttlMs / 60000),
        pending:   !!e.promise,
      };
    }
    return out;
  }
}

module.exports = new SmartCache();
