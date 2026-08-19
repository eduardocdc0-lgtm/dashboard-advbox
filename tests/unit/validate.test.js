/**
 * Unit tests pra utils/validate.js — chainable Validator.
 */

'use strict';

require('../_test-env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { validate } = require('../../utils/validate');
const { ValidationError } = require('../../middleware/errorHandler');

describe('validate().string()', () => {
  it('aceita string válida e faz trim', () => {
    const data = validate({ name: '  hello  ' }).string('name').done();
    assert.equal(data.name, 'hello');
  });

  it('rejeita string vazia quando required', () => {
    assert.throws(
      () => validate({ name: '' }).string('name').done(),
      (err) => err instanceof ValidationError && err.details[0].field === 'name'
    );
  });

  it('rejeita string só-com-espaços quando required', () => {
    assert.throws(
      () => validate({ name: '   ' }).string('name').done(),
      ValidationError
    );
  });

  it('aceita ausência quando optional', () => {
    const data = validate({}).string('name', { optional: true }).done();
    assert.equal(data.name, undefined);
  });

  it('valida minLength', () => {
    assert.throws(
      () => validate({ name: 'ab' }).string('name', { minLength: 3 }).done(),
      (err) => /pelo menos 3/.test(err.details[0].message)
    );
  });

  it('valida maxLength', () => {
    assert.throws(
      () => validate({ name: 'abcdef' }).string('name', { maxLength: 3 }).done(),
      (err) => /excede 3/.test(err.details[0].message)
    );
  });

  it('valida pattern com hint custom', () => {
    assert.throws(
      () => validate({ email: 'not-an-email' })
        .string('email', { pattern: /@/, patternHint: 'precisa conter @' })
        .done(),
      (err) => err.details[0].message === 'precisa conter @'
    );
  });
});

describe('validate().number()', () => {
  it('aceita número e retorna como Number', () => {
    const data = validate({ x: 42 }).number('x').done();
    assert.strictEqual(data.x, 42);
  });

  it('coerce string numérica', () => {
    const data = validate({ x: '123.5' }).number('x').done();
    assert.strictEqual(data.x, 123.5);
  });

  it('rejeita NaN', () => {
    assert.throws(
      () => validate({ x: 'abc' }).number('x').done(),
      ValidationError
    );
  });

  it('aplica min e max', () => {
    assert.throws(() => validate({ x: 5 }).number('x', { min: 10 }).done(), ValidationError);
    assert.throws(() => validate({ x: 50 }).number('x', { max: 10 }).done(), ValidationError);
  });

  it('valida integer', () => {
    assert.throws(
      () => validate({ x: 1.5 }).number('x', { integer: true }).done(),
      (err) => /inteiro/.test(err.details[0].message)
    );
  });
});

describe('validate().enum()', () => {
  it('aceita valor permitido', () => {
    const data = validate({ kind: 'a_vista' }).enum('kind', ['a_vista', 'parcelado']).done();
    assert.equal(data.kind, 'a_vista');
  });

  it('rejeita valor fora do set com lista no erro', () => {
    assert.throws(
      () => validate({ kind: 'avista' }).enum('kind', ['a_vista', 'parcelado']).done(),
      (err) => /a_vista, parcelado/.test(err.details[0].message)
    );
  });
});

describe('validate().boolean()', () => {
  it('aceita true/false direto', () => {
    assert.strictEqual(validate({ b: true }).boolean('b').done().b, true);
    assert.strictEqual(validate({ b: false }).boolean('b').done().b, false);
  });

  it('coerce strings "true"/"false"', () => {
    assert.strictEqual(validate({ b: 'true' }).boolean('b').done().b, true);
    assert.strictEqual(validate({ b: 'false' }).boolean('b').done().b, false);
  });

  it('coerce 1/0', () => {
    assert.strictEqual(validate({ b: 1 }).boolean('b').done().b, true);
    assert.strictEqual(validate({ b: 0 }).boolean('b').done().b, false);
  });

  it('rejeita strings arbitrárias', () => {
    assert.throws(
      () => validate({ b: 'yes' }).boolean('b').done(),
      ValidationError
    );
  });
});

describe('validate().dateYMD()', () => {
  it('aceita YYYY-MM-DD válido', () => {
    const data = validate({ d: '2026-05-21' }).dateYMD('d').done();
    assert.equal(data.d, '2026-05-21');
  });

  it('rejeita formato errado', () => {
    assert.throws(() => validate({ d: '21/05/2026' }).dateYMD('d').done(), ValidationError);
    assert.throws(() => validate({ d: '2026-5-21' }).dateYMD('d').done(),  ValidationError);
  });

  it('rejeita data impossível (Feb 30)', () => {
    assert.throws(
      () => validate({ d: '2025-02-30' }).dateYMD('d').done(),
      (err) => /dia ou mês fora do range/.test(err.details[0].message)
    );
  });
});

describe('validate().done() multi-error', () => {
  it('agrega TODOS os erros em uma única exceção', () => {
    try {
      validate({})
        .string('name')
        .number('age')
        .enum('kind', ['a', 'b'])
        .done();
      assert.fail('deveria ter throw-ado');
    } catch (err) {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.details.length, 3);
      assert.deepEqual(err.details.map(d => d.field).sort(), ['age', 'kind', 'name']);
    }
  });

  it('inclui resumo concatenado em err.message', () => {
    try {
      validate({}).string('a').string('b').done();
    } catch (err) {
      assert.match(err.message, /a: é obrigatório · b: é obrigatório/);
    }
  });

  it('retorna valores limpos quando tudo passa', () => {
    const data = validate({ name: ' eduardo ', age: '35', kind: 'admin' })
      .string('name')
      .number('age', { integer: true })
      .enum('kind', ['admin', 'team'])
      .done();
    assert.deepEqual(data, { name: 'eduardo', age: 35, kind: 'admin' });
  });
});
