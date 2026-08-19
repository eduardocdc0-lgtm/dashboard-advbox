/**
 * Validador chainable pra mutation endpoints.
 *
 * Filosofia:
 *   - Não puxa joi/zod (~300KB extras). 150 linhas resolvem nosso caso.
 *   - Cada método (.string, .number, .enum, .boolean, .dateYMD) é não-fatal —
 *     erros acumulam.
 *   - .done() atira UM ValidationError com TODOS os erros agregados — o
 *     errorHandler global serializa pra JSON { error, details, requestId }.
 *   - Coerce types (Number(), String().trim()) — handler recebe valores
 *     limpos via objeto retornado.
 *
 * USO:
 *   const data = validate(req.body)
 *     .string('client_name', { maxLength: 500 })
 *     .number('lawsuit_id',  { integer: true, min: 1, optional: true })
 *     .enum('kind',          ['a_vista', 'parcelado'])
 *     .number('parcela_value', { min: 0.01, max: 1_000_000 })
 *     .dateYMD('first_due_date')
 *     .done();
 *   // data.client_name === string trimmed
 *   // data.lawsuit_id  === number ou undefined
 *   // data.parcela_value === number
 *
 * MENSAGENS DE ERRO:
 *   Português, no formato "<campo>: <razão>". Frontend recebe:
 *     {
 *       "error": "client_name: é obrigatório · kind: deve ser um de: a_vista, parcelado",
 *       "details": [
 *         { "field": "client_name", "message": "é obrigatório" },
 *         { "field": "kind",        "message": "deve ser um de: a_vista, parcelado" }
 *       ],
 *       "requestId": "abc123"
 *     }
 *   `error` é string (compat com frontend que só lê isso); `details` é array
 *   estruturado pra UIs que querem highlight por campo.
 */

'use strict';

const { ValidationError } = require('../middleware/errorHandler');

const DATE_YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

class Validator {
  constructor(input) {
    this.input  = input || {};
    this.errors = [];
    this.values = {};
  }

  _missing(field, optional) {
    if (!optional) this.errors.push({ field, message: 'é obrigatório' });
  }

  /**
   * String com trim. opts: { optional, minLength, maxLength, pattern, patternHint, trim=true }
   */
  string(field, opts = {}) {
    const raw = this.input[field];
    const optional = opts.optional === true;

    // null, undefined, ou string só com espaços = vazio
    if (raw == null || (typeof raw === 'string' && raw.trim().length === 0)) {
      this._missing(field, optional);
      return this;
    }

    let s = String(raw);
    if (opts.trim !== false) s = s.trim();

    if (opts.minLength != null && s.length < opts.minLength) {
      this.errors.push({ field, message: `precisa ter pelo menos ${opts.minLength} caracteres` });
      return this;
    }
    if (opts.maxLength != null && s.length > opts.maxLength) {
      this.errors.push({ field, message: `excede ${opts.maxLength} caracteres` });
      return this;
    }
    if (opts.pattern && !opts.pattern.test(s)) {
      this.errors.push({ field, message: opts.patternHint || 'formato inválido' });
      return this;
    }

    this.values[field] = s;
    return this;
  }

  /**
   * Number. opts: { optional, integer, min, max }. Coerce de string ('123' → 123).
   */
  number(field, opts = {}) {
    const raw = this.input[field];
    const optional = opts.optional === true;

    if (raw == null || raw === '') {
      this._missing(field, optional);
      return this;
    }

    const n = Number(raw);
    if (!Number.isFinite(n)) {
      this.errors.push({ field, message: 'precisa ser um número' });
      return this;
    }
    if (opts.integer && !Number.isInteger(n)) {
      this.errors.push({ field, message: 'precisa ser um número inteiro' });
      return this;
    }
    if (opts.min != null && n < opts.min) {
      this.errors.push({ field, message: `precisa ser maior ou igual a ${opts.min}` });
      return this;
    }
    if (opts.max != null && n > opts.max) {
      this.errors.push({ field, message: `não pode passar de ${opts.max}` });
      return this;
    }

    this.values[field] = n;
    return this;
  }

  /**
   * Enum. allowed: array de valores permitidos. opts: { optional }.
   * Comparação por igualdade estrita (sem coerce — passe ['true','false'] se for string).
   */
  enum(field, allowed, opts = {}) {
    const raw = this.input[field];
    const optional = opts.optional === true;

    if (raw == null || raw === '') {
      this._missing(field, optional);
      return this;
    }

    if (!allowed.includes(raw)) {
      this.errors.push({ field, message: `deve ser um de: ${allowed.join(', ')}` });
      return this;
    }

    this.values[field] = raw;
    return this;
  }

  /**
   * Boolean. Aceita true/false, 'true'/'false', 1/0, '1'/'0'. opts: { optional }.
   */
  boolean(field, opts = {}) {
    const raw = this.input[field];
    const optional = opts.optional === true;

    if (raw == null || raw === '') {
      this._missing(field, optional);
      return this;
    }

    let coerced;
    if (typeof raw === 'boolean') coerced = raw;
    else if (raw === 'true'  || raw === '1' || raw === 1) coerced = true;
    else if (raw === 'false' || raw === '0' || raw === 0) coerced = false;
    else {
      this.errors.push({ field, message: 'precisa ser true ou false' });
      return this;
    }

    this.values[field] = coerced;
    return this;
  }

  /**
   * Data no formato YYYY-MM-DD (ISO date sem hora). opts: { optional }.
   * Valida formato + sanity (mês 1-12, dia válido pro mês).
   */
  dateYMD(field, opts = {}) {
    const raw = this.input[field];
    const optional = opts.optional === true;

    if (raw == null || raw === '') {
      this._missing(field, optional);
      return this;
    }

    const s = String(raw).trim();
    if (!DATE_YMD_RE.test(s)) {
      this.errors.push({ field, message: 'data inválida (esperado AAAA-MM-DD)' });
      return this;
    }
    // Sanity: parse e verifica round-trip (rejeita ex: 2025-02-30)
    const d = new Date(s + 'T00:00:00Z');
    if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
      this.errors.push({ field, message: 'data inválida (dia ou mês fora do range)' });
      return this;
    }

    this.values[field] = s;
    return this;
  }

  /**
   * Termina a validação:
   *   - sem erros → retorna objeto com valores coercidos (use destructuring)
   *   - com erros → throw ValidationError (errorHandler global serializa pra 400)
   */
  done() {
    if (this.errors.length > 0) {
      const summary = this.errors.map(e => `${e.field}: ${e.message}`).join(' · ');
      throw new ValidationError(summary, this.errors);
    }
    return this.values;
  }
}

function validate(input) {
  return new Validator(input);
}

module.exports = { validate, Validator };
