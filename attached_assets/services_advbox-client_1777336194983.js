/**
 * Cliente da API AdvBox com retry, rate limiting e error handling robusto
 */

const fetch = require('node-fetch');

class AdvBoxClient {
  constructor(token, options = {}) {
    this.token = token;
    this.baseURL = 'https://api.advbox.com';
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 1000; // ms
    this.timeout = options.timeout || 30000; // ms
    this.requestCount = 0;
    this.lastRequestTime = 0;
    this.minRequestInterval = options.minRequestInterval || 100; // ms entre requisições
  }

  /**
   * Rate limiting - espera se necessário
   */
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

  /**
   * Requisição com retry automático
   */
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

        // Sucesso
        if (response.ok) {
          const data = await response.json();
          return { success: true, data, status: response.status };
        }

        // Erro 429 = rate limit (retry)
        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After') || this.retryDelay * attempt;
          console.warn(`[AdvBox] Rate limited. Retry after ${retryAfter}ms (attempt ${attempt}/${this.maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, retryAfter));
          continue;
        }

        // Erro 401/403 = autenticação (não retry)
        if (response.status === 401 || response.status === 403) {
          throw new Error(`Autenticação falhou (${response.status}). Verifique o token.`);
        }

        // Erro 5xx = servidor (retry)
        if (response.status >= 500) {
          lastError = new Error(`Servidor AdvBox erro ${response.status}`);
          console.warn(`[AdvBox] ${lastError.message} (attempt ${attempt}/${this.maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, this.retryDelay * attempt));
          continue;
        }

        // Outro erro
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`API error ${response.status}: ${errorData.message || 'Unknown'}`);

      } catch (error) {
        lastError = error;

        // Timeout ou rede = retry
        if (error.name === 'AbortError' || error.code === 'ECONNRESET') {
          console.warn(`[AdvBox] Timeout/Conexão (attempt ${attempt}/${this.maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, this.retryDelay * attempt));
          continue;
        }

        // Erro crítico = não retry
        if (attempt === this.maxRetries) {
          throw error;
        }
      }
    }

    throw lastError || new Error('Requisição falhou após todas as tentativas');
  }

  /**
   * Métodos específicos da API (adapte conforme sua API)
   */
  
  async getLawsuits(page = 1, limit = 20) {
    return this.request(`/lawsuits?page=${page}&limit=${limit}`);
  }

  async getAuditResponsible() {
    return this.request('/audit/responsible');
  }

  async getAuditStages() {
    return this.request('/audit/stages');
  }

  async getDistribution() {
    return this.request('/distribution');
  }

  async getTransactions(startDate, endDate) {
    return this.request(`/transactions?start=${startDate}&end=${endDate}`);
  }

  async getCustomers(page = 1) {
    return this.request(`/customers?page=${page}`);
  }

  async getMovements(limit = 50) {
    return this.request(`/movements?limit=${limit}`);
  }
}

module.exports = AdvBoxClient;