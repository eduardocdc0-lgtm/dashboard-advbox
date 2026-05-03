/**
 * Cliente da API AdvBox.
 *
 * Características:
 *  - Retry exponencial com jitter
 *  - Rate limit interno por intervalo mínimo entre requisições
 *  - Timeout via AbortController
 *  - Mapeamento de erros HTTP em mensagens claras
 *  - Logs estruturados via pino (passa logger via DI; fallback console)
 *
 * Refatorado: o request() antigo (60+ linhas) foi quebrado em métodos privados.
 */

'use strict';

const fetch = require('node-fetch');

// ── Constantes ────────────────────────────────────────────────────────────────
const DEFAULTS = Object.freeze({
  baseURL:      'https://app.advbox.com.br/api/v1',
  maxRetries:   3,
  baseDelayMs:  1000,
  timeoutMs:    30_000,
  minIntervalMs:120,
  // User-Agent “real” evita filtros agressivos do AdvBox; documentar no time.
  userAgent:    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
});

const RETRYABLE_NET_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

// ── Utilitários ───────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const expoBackoff = (base, attempt) => base * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 100);

class AdvBoxClient {
  /**
   * @param {string} token
   * @param {object} options
   * @param {object} [options.logger]  pino-like logger (warn, error, info)
   */
  constructor(token, options = {}) {
    this.token         = token;
    this.baseURL       = options.baseURL       ?? DEFAULTS.baseURL;
    this.maxRetries    = options.maxRetries    ?? DEFAULTS.maxRetries;
    this.baseDelayMs   = options.baseDelayMs   ?? DEFAULTS.baseDelayMs;
    this.timeoutMs     = options.timeoutMs     ?? DEFAULTS.timeoutMs;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULTS.minIntervalMs;
    this.logger        = options.logger        ?? console;
    this._lastReqAt    = 0;
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  async request(endpoint, opts = {}) {
    if (!this.token) throw new Error('ADVBOX_TOKEN não configurado.');

    let lastErr;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      await this._respectRateLimit();
      try {
        const result = await this._tryOnce(endpoint, opts, attempt);
        if (result.retry) {
          lastErr = result.err;
          continue;
        }
        return result.data;
      } catch (err) {
        lastErr = err;
        if (!this._shouldRetry(err)) throw err;
        await sleep(expoBackoff(this.baseDelayMs, attempt));
      }
    }
    throw lastErr || new Error('Requisição AdvBox falhou após todas as tentativas');
  }

  async getAllLawsuits(pageSize = 500, maxPages = 30) {
    const all = [];
    for (let page = 0; page < maxPages; page++) {
      const data = await this.request(`/lawsuits?limit=${pageSize}&offset=${page * pageSize}`);
      const arr  = Array.isArray(data) ? data : (data.data || []);
      if (!arr.length) break;
      all.push(...arr);
      if (arr.length < pageSize) break;
    }
    this.logger.info(`[AdvBox] Processos carregados: ${all.length}`);
    return all;
  }

  getTransactions(limit = 1000) { return this.request(`/transactions?limit=${limit}`); }
  getCustomers(limit = 1000)    { return this.request(`/customers?limit=${limit}`); }
  getBirthdays()                { return this.request('/customers/birthdays'); }
  getLastMovements(limit = 500) { return this.request(`/last_movements?limit=${limit}`); }
  getSettings()                 { return this.request('/settings'); }

  // ── Privados ───────────────────────────────────────────────────────────────

  async _respectRateLimit() {
    const wait = this.minIntervalMs - (Date.now() - this._lastReqAt);
    if (wait > 0) await sleep(wait);
    this._lastReqAt = Date.now();
  }

  /**
   * Faz UMA tentativa. Retorna:
   *   { data: <json> }                   → sucesso
   *   { retry: true, err: Error }        → retry no laço externo
   *   throws                              → erro fatal (não retryável)
   */
  async _tryOnce(endpoint, opts, attempt) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetch(`${this.baseURL}${endpoint}`, {
        ...opts,
        headers: this._headers(opts.headers),
        signal:  controller.signal,
      });

      if (resp.ok)            return { data: await resp.json() };
      if (resp.status === 429) return await this._handle429(resp, attempt);
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(`Autenticação AdvBox falhou (${resp.status}). Verifique ADVBOX_TOKEN.`);
      }
      if (resp.status >= 500) {
        return this._retryAfter(`Servidor AdvBox ${resp.status}`, attempt);
      }
      // 4xx: pega body e levanta erro fatal
      const body = await resp.json().catch(() => ({}));
      throw new Error(`API AdvBox ${resp.status}: ${body.message || body.error || 'erro desconhecido'}`);

    } catch (err) {
      if (err.name === 'AbortError') {
        this.logger.warn(`[AdvBox] Timeout ${this.timeoutMs}ms (tent. ${attempt}/${this.maxRetries})`);
        return { retry: true, err };
      }
      if (RETRYABLE_NET_CODES.has(err.code)) {
        this.logger.warn(`[AdvBox] Rede ${err.code} (tent. ${attempt}) — backoff`);
        return { retry: true, err };
      }
      throw err;
    } finally {
      clearTimeout(tid);
    }
  }

  _headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type':'application/json',
      Accept:        'application/json',
      'User-Agent':  DEFAULTS.userAgent,
      ...extra,
    };
  }

  async _handle429(resp, attempt) {
    const after = parseInt(resp.headers.get('Retry-After') || '0', 10) * 1000
               || expoBackoff(this.baseDelayMs, attempt);
    this.logger.warn(`[AdvBox] 429 — aguardando ${after}ms (tent. ${attempt}/${this.maxRetries})`);
    await sleep(after);
    return { retry: true, err: new Error('RATE_LIMIT') };
  }

  _retryAfter(reason, attempt) {
    this.logger.warn(`[AdvBox] ${reason} (tent. ${attempt}) — backoff`);
    return { retry: true, err: new Error(reason) };
  }

  _shouldRetry(err) {
    if (err.name === 'AbortError') return true;
    if (RETRYABLE_NET_CODES.has(err.code)) return true;
    if (err.message === 'RATE_LIMIT') return true;
    return false;
  }
}

module.exports = AdvBoxClient;
