/**
 * Circuit breaker minimalista pra APIs externas.
 *
 * Estados:
 *   closed     → normal, requests passam
 *   open       → muitas falhas consecutivas; rejeita imediatamente sem chamar
 *                a função. Após resetTimeoutMs, transiciona pra half-open.
 *   half-open  → permite UM request pra testar. Sucesso → closed; falha → open.
 *
 * Objetivo: quando AdvBox/Asaas/Meta caem, parar de hammerar a API (que só
 * piora o problema deles e o nosso). Operador vê estado em /api/cache-status.
 *
 * NÃO é Opossum (lib maior, ~3KB minified vs ~60 linhas aqui). Sem hystrix,
 * sem half-open com fila — simples o suficiente pra revisar sem documentação.
 *
 * Threshold tripa em QUALQUER erro por padrão (inclui 4xx, timeouts, network).
 * Trade-off consciente: tokens inválidos abrem o breaker rápido (5 fails),
 * dando feedback ao operador em vez de retornar 401 indefinidamente.
 */

'use strict';

class CircuitBreaker {
  constructor({ name, failureThreshold = 5, resetTimeoutMs = 30_000 } = {}) {
    if (!name) throw new Error('[CircuitBreaker] name é obrigatório');
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs   = resetTimeoutMs;

    this.state         = 'closed';   // 'closed' | 'open' | 'half-open'
    this.failureCount  = 0;
    this.lastFailureAt = null;
    this.lastSuccessAt = null;
    this.openedAt      = null;

    this.metrics = { calls: 0, successes: 0, failures: 0, rejections: 0, opens: 0 };
  }

  /**
   * Executa `fn`. Rejeita imediatamente se o breaker estiver aberto.
   */
  async exec(fn) {
    this.metrics.calls++;

    if (this.state === 'open') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.resetTimeoutMs) {
        // Janela de half-open: permite a próxima chamada como trial
        this.state = 'half-open';
      } else {
        this.metrics.rejections++;
        const remaining = Math.ceil((this.resetTimeoutMs - elapsed) / 1000);
        const err = new Error(`[CircuitBreaker:${this.name}] OPEN — request rejeitado, tente em ${remaining}s`);
        err.code = 'CIRCUIT_OPEN';
        err.breaker = this.name;
        throw err;
      }
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  _onSuccess() {
    this.metrics.successes++;
    this.lastSuccessAt = Date.now();
    this.failureCount  = 0;
    if (this.state === 'half-open') this.state = 'closed';
  }

  _onFailure() {
    this.metrics.failures++;
    this.lastFailureAt = Date.now();
    this.failureCount++;
    if (this.state === 'half-open') {
      // Trial em half-open falhou → re-abre imediatamente
      this._open();
    } else if (this.state === 'closed' && this.failureCount >= this.failureThreshold) {
      this._open();
    }
  }

  _open() {
    if (this.state !== 'open') this.metrics.opens++;
    this.state    = 'open';
    this.openedAt = Date.now();
  }

  /**
   * Snapshot pra /api/cache-status. Tudo serializável.
   */
  status() {
    const now = Date.now();
    return {
      name:           this.name,
      state:          this.state,
      failureCount:   this.failureCount,
      lastSuccessAt:  this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
      lastFailureAt:  this.lastFailureAt ? new Date(this.lastFailureAt).toISOString() : null,
      openedAt:       this.openedAt      ? new Date(this.openedAt).toISOString()      : null,
      msUntilHalfOpen: this.state === 'open'
        ? Math.max(0, this.resetTimeoutMs - (now - this.openedAt))
        : 0,
      config:  { failureThreshold: this.failureThreshold, resetTimeoutMs: this.resetTimeoutMs },
      metrics: { ...this.metrics },
    };
  }

  /**
   * Reset manual (útil em testes e no /api/cache-invalidate do admin).
   */
  reset() {
    this.state         = 'closed';
    this.failureCount  = 0;
    this.openedAt      = null;
  }
}

// ── Singletons por API externa ────────────────────────────────────────────────
// Thresholds calibrados pra contexto: AdvBox/Asaas dão erros transitórios
// ocasionais; 5 falhas seguidas em ~30s é sinal real de degradação.
// Meta tem janela maior (60s) porque a API deles é mais flaky historicamente
// e pequenos blips não devem cortar campanha-roi por 30s.
const breakers = {
  advbox: new CircuitBreaker({ name: 'advbox', failureThreshold: 5, resetTimeoutMs: 30_000 }),
  asaas:  new CircuitBreaker({ name: 'asaas',  failureThreshold: 5, resetTimeoutMs: 30_000 }),
  meta:   new CircuitBreaker({ name: 'meta',   failureThreshold: 5, resetTimeoutMs: 60_000 }),
};

function allStatus() {
  return Object.fromEntries(Object.entries(breakers).map(([k, b]) => [k, b.status()]));
}

function resetAll() {
  for (const b of Object.values(breakers)) b.reset();
}

module.exports = { CircuitBreaker, breakers, allStatus, resetAll };
