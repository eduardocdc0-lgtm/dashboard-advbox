/**
 * Cliente da API ASAAS (gateway de pagamento).
 *
 * Doc oficial: https://docs.asaas.com/reference
 *
 * Ambientes:
 *   - Sandbox:  https://api-sandbox.asaas.com/v3
 *   - Produção: https://api.asaas.com/v3
 *
 * Autenticação: header `access_token: <token>` (NÃO é Bearer).
 *
 * Métodos principais:
 *   - findOrCreateCustomer({ name, cpfCnpj, email?, phone? })
 *   - createPayment({ customerId, value, dueDate, billingType, description, ... })
 *   - listPayments({ status?, limit?, offset? })
 *   - getPayment(id)
 */

'use strict';

const fetch = require('node-fetch');

const DEFAULTS = Object.freeze({
  sandbox:    'https://api-sandbox.asaas.com/v3',
  production: 'https://api.asaas.com/v3',
  timeoutMs:  20_000,
  userAgent:  'dashboard-advbox/asaas-client',
});

class AsaasClient {
  constructor(token, options = {}) {
    if (!token) throw new Error('AsaasClient: token obrigatório');
    this.token   = token;
    // Token de sandbox tem "_hmlg_" no meio — usamos isso como autodetect
    // pra evitar que dev rode em produção sem perceber.
    const isSandbox = options.baseURL
      ? options.baseURL.includes('sandbox')
      : token.includes('_hmlg_');
    this.baseURL = options.baseURL || (isSandbox ? DEFAULTS.sandbox : DEFAULTS.production);
    this.isSandbox = isSandbox;
    this.timeoutMs = options.timeoutMs || DEFAULTS.timeoutMs;
    this.logger    = options.logger || console;
  }

  async _request(method, path, body) {
    const url = `${this.baseURL}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const r = await fetch(url, {
        method,
        headers: {
          'access_token':  this.token,
          'Accept':        'application/json',
          'Content-Type':  'application/json',
          'User-Agent':    DEFAULTS.userAgent,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await r.text();
      let json;
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      if (!r.ok) {
        const msg = json.errors?.[0]?.description || json.message || `HTTP ${r.status}`;
        const err = new Error(`ASAAS ${method} ${path}: ${msg}`);
        err.status = r.status;
        err.body = json;
        throw err;
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Customers ─────────────────────────────────────────────────────────────
  async findCustomerByCpfCnpj(cpfCnpj) {
    if (!cpfCnpj) return null;
    const clean = String(cpfCnpj).replace(/\D/g, '');
    if (!clean) return null;
    const res = await this._request('GET', `/customers?cpfCnpj=${clean}&limit=1`);
    return res.data?.[0] || null;
  }

  async createCustomer({ name, cpfCnpj, email, phone, mobilePhone }) {
    if (!name) throw new Error('createCustomer: name obrigatório');
    if (!cpfCnpj) throw new Error('createCustomer: cpfCnpj obrigatório');
    return this._request('POST', '/customers', {
      name,
      cpfCnpj: String(cpfCnpj).replace(/\D/g, ''),
      email:   email || undefined,
      phone:   phone || undefined,
      mobilePhone: mobilePhone || phone || undefined,
    });
  }

  /** Busca por CPF; se não achar, cria. Devolve sempre o customer ASAAS. */
  async findOrCreateCustomer({ name, cpfCnpj, email, phone, mobilePhone }) {
    const existing = await this.findCustomerByCpfCnpj(cpfCnpj);
    if (existing) return existing;
    return this.createCustomer({ name, cpfCnpj, email, phone, mobilePhone });
  }

  // ── Payments ──────────────────────────────────────────────────────────────
  /**
   * billingType: 'BOLETO' | 'PIX' | 'CREDIT_CARD' | 'UNDEFINED' (cliente escolhe)
   */
  async createPayment({
    customerId, value, dueDate, billingType = 'UNDEFINED',
    description, externalReference,
    interestPercent, finePercent,
  }) {
    if (!customerId) throw new Error('createPayment: customerId obrigatório');
    if (!(value > 0)) throw new Error('createPayment: value > 0 obrigatório');
    if (!dueDate)    throw new Error('createPayment: dueDate obrigatório');

    const body = {
      customer:    customerId,
      billingType,
      value:       Number(value.toFixed(2)),
      dueDate,
      description: description || undefined,
      externalReference: externalReference || undefined,
    };
    if (interestPercent > 0) body.interest = { value: Number(interestPercent) };
    if (finePercent     > 0) body.fine     = { value: Number(finePercent) };

    return this._request('POST', '/payments', body);
  }

  async getPayment(id) {
    return this._request('GET', `/payments/${encodeURIComponent(id)}`);
  }

  async listPayments({ status, customer, limit = 50, offset = 0 } = {}) {
    const qs = new URLSearchParams();
    if (status)   qs.set('status', status);
    if (customer) qs.set('customer', customer);
    qs.set('limit',  String(limit));
    qs.set('offset', String(offset));
    return this._request('GET', `/payments?${qs.toString()}`);
  }

  /** Retorna QR Code PIX (base64) + copia-cola pra um payment do tipo PIX. */
  async getPaymentPixQrCode(paymentId) {
    return this._request('GET', `/payments/${encodeURIComponent(paymentId)}/pixQrCode`);
  }
}

module.exports = { AsaasClient };
