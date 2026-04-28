/**
 * Cliente da API AdvBox com retry, rate limiting e error handling robusto
 */

const fetch = require('node-fetch');

class AdvBoxClient {
  constructor(token, options = {}) {
    this.token = token;
    this.baseURL = 'https://app.advbox.com.br/api/v1';
    this.maxRetries = options.maxRetries || 3;
    this.baseDelay = options.baseDelay || 1000;
    this.timeout = options.timeout || 30000;
    this.minInterval = options.minInterval || 120;
    this._lastReq = 0;
  }

  async _rateLimit() {
    const wait = this.minInterval - (Date.now() - this._lastReq);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this._lastReq = Date.now();
  }

  async request(endpoint, opts = {}) {
    if (!this.token) throw new Error('ADVBOX_TOKEN não configurado.');

    let lastErr;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      await this._rateLimit();

      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), this.timeout);

      try {
        const resp = await fetch(`${this.baseURL}${endpoint}`, {
          ...opts,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            ...opts.headers,
          },
          signal: ctrl.signal,
        });
        clearTimeout(tid);

        if (resp.ok) {
          return await resp.json();
        }

        if (resp.status === 429) {
          const after = parseInt(resp.headers.get('Retry-After') || '0') || this.baseDelay * attempt;
          console.warn(`[AdvBox] 429 – aguardando ${after}ms (tent. ${attempt}/${this.maxRetries})`);
          await new Promise(r => setTimeout(r, after));
          continue;
        }

        if (resp.status === 401 || resp.status === 403) {
          throw new Error(`Autenticação falhou (${resp.status}). Verifique ADVBOX_TOKEN.`);
        }

        const ct = resp.headers.get('content-type') || '';
        if (!ct.includes('json')) {
          lastErr = new Error('RATE_LIMIT');
          const backoff = this.baseDelay * Math.pow(2, attempt - 1);
          console.warn(`[AdvBox] Resposta não-JSON (tent. ${attempt}) – aguardando ${backoff}ms`);
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }

        if (resp.status >= 500) {
          const backoff = this.baseDelay * Math.pow(2, attempt - 1);
          lastErr = new Error(`Servidor AdvBox ${resp.status}`);
          console.warn(`[AdvBox] ${lastErr.message} (tent. ${attempt}) – backoff ${backoff}ms`);
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }

        const body = await resp.json().catch(() => ({}));
        throw new Error(`API ${resp.status}: ${body.message || body.error || 'Erro desconhecido'}`);

      } catch (err) {
        clearTimeout(tid);
        lastErr = err;

        if (err.name === 'AbortError') {
          console.warn(`[AdvBox] Timeout ${this.timeout}ms (tent. ${attempt}/${this.maxRetries})`);
          await new Promise(r => setTimeout(r, this.baseDelay * attempt));
          continue;
        }

        if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND'].includes(err.code)) {
          const backoff = this.baseDelay * Math.pow(2, attempt - 1);
          console.warn(`[AdvBox] Rede ${err.code} (tent. ${attempt}) – backoff ${backoff}ms`);
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }

        throw err;
      }
    }

    throw lastErr || new Error('Requisição falhou após todas as tentativas');
  }

  async getAllLawsuits(pageSize = 500) {
    const all = [];
    let page = 0;
    while (page < 30) {
      const data = await this.request(`/lawsuits?limit=${pageSize}&offset=${page * pageSize}`);
      const arr  = Array.isArray(data) ? data : (data.data || []);
      if (!arr.length) break;
      all.push(...arr);
      page++;
      if (arr.length < pageSize) break;
    }
    console.log(`[AdvBox] Processos carregados: ${all.length} (${page} páginas)`);
    return all;
  }

  getTransactions(limit = 1000) { return this.request(`/transactions?limit=${limit}`); }
  getCustomers(limit = 1000)    { return this.request(`/customers?limit=${limit}`); }
  getBirthdays()                { return this.request('/customers/birthdays'); }
  getLastMovements(limit = 500) { return this.request(`/last_movements?limit=${limit}`); }
  getSettings()                 { return this.request('/settings'); }
}

module.exports = AdvBoxClient;
