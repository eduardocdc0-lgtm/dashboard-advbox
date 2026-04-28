/**
 * Cliente da API AdvBox com retry, rate limiting e error handling robusto
 */

const fetch = require('node-fetch');

class AdvBoxClient {
  constructor(token, options = {}) {
    this.token = token;
    this.baseURL = 'https://app.advbox.com.br/api/v1';
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 1000;
    this.timeout = options.timeout || 30000;
    this.requestCount = 0;
    this.lastRequestTime = 0;
    this.minRequestInterval = options.minRequestInterval || 100;
  }

  async enforceRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestInterval) {
      await new Promise(resolve =>
        setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest)
      );
    }
    this.lastRequestTime = Date.now();
  }

  async request(endpoint, options = {}) {
    let lastError;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        await this.enforceRateLimit();

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const response = await fetch(`${this.baseURL}${endpoint}`, {
          ...options,
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            ...options.headers,
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json();
          return data;
        }

        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('Retry-After') || '0') || (this.retryDelay * attempt);
          console.warn(`[AdvBox] Rate limited. Aguardando ${retryAfter}ms (tentativa ${attempt}/${this.maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, retryAfter));
          continue;
        }

        if (response.status === 401 || response.status === 403) {
          throw new Error(`Autenticação falhou (${response.status}). Verifique o ADVBOX_TOKEN.`);
        }

        if (response.status >= 500) {
          lastError = new Error(`Servidor AdvBox erro ${response.status}`);
          console.warn(`[AdvBox] ${lastError.message} (tentativa ${attempt}/${this.maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, this.retryDelay * attempt));
          continue;
        }

        const ct = response.headers.get('content-type') || '';
        if (!ct.includes('json')) {
          lastError = new Error(`RATE_LIMIT`);
          await new Promise(resolve => setTimeout(resolve, this.retryDelay * attempt));
          continue;
        }

        const errorData = await response.json().catch(() => ({}));
        throw new Error(`API error ${response.status}: ${errorData.message || errorData.error || 'Erro desconhecido'}`);

      } catch (error) {
        lastError = error;

        if (error.name === 'AbortError' || error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED') {
          console.warn(`[AdvBox] Timeout/Rede (tentativa ${attempt}/${this.maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, this.retryDelay * attempt));
          continue;
        }

        throw error;
      }
    }

    throw lastError || new Error('Requisição falhou após todas as tentativas');
  }

  async getLawsuitsPage(limit = 500, offset = 0) {
    return this.request(`/lawsuits?limit=${limit}&offset=${offset}`);
  }

  async getAllLawsuits(pageSize = 500) {
    const all = [];
    let page = 0;
    while (page < 30) {
      const data = await this.getLawsuitsPage(pageSize, page * pageSize);
      const arr = Array.isArray(data) ? data : (data.data || []);
      if (!arr.length) break;
      all.push(...arr);
      page++;
      if (arr.length < pageSize) break;
      await new Promise(r => setTimeout(r, 200));
    }
    return all;
  }

  async getTransactions(limit = 1000) {
    return this.request(`/transactions?limit=${limit}`);
  }

  async getCustomers(limit = 1000) {
    return this.request(`/customers?limit=${limit}`);
  }

  async getLastMovements(limit = 20) {
    return this.request(`/last_movements?limit=${limit}`);
  }

  async getSettings() {
    return this.request('/settings');
  }
}

module.exports = AdvBoxClient;
