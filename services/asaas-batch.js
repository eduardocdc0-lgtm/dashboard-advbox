/**
 * Processamento em lote de cobranças ASAAS.
 *
 * Eduardo cobra 5-20 inadimplentes de uma vez. Esse módulo recebe uma lista
 * de devedores, garante o customer (find-or-create) e gera a cobrança pra
 * cada um, agregando sucessos e erros num único resumo.
 *
 * Throttle simples (sequencial com mini-delay) — ASAAS limita a ~20 req/s,
 * 5-20 cobranças cabem folgadas.
 */

'use strict';

const { AsaasClient } = require('./asaas-client');

const DEFAULT_INTEREST_PERCENT = 1; // 1% ao mês de juros (config futura)
const DEFAULT_FINE_PERCENT     = 2; // 2% de multa por atraso
const REQ_DELAY_MS             = 150;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * @param {AsaasClient} client
 * @param {Array<{
 *   name: string,
 *   cpfCnpj: string,
 *   email?: string, phone?: string,
 *   value: number,
 *   dueDate: string,         // 'YYYY-MM-DD'
 *   description?: string,
 *   externalReference?: string,  // lawsuit_id, transaction_id, etc
 * }>} items
 * @param {object} options
 * @param {'BOLETO'|'PIX'|'UNDEFINED'} [options.billingType='UNDEFINED']
 * @param {number} [options.interestPercent]
 * @param {number} [options.finePercent]
 */
async function createBatch(client, items, options = {}) {
  const {
    billingType     = 'UNDEFINED',
    interestPercent = DEFAULT_INTEREST_PERCENT,
    finePercent     = DEFAULT_FINE_PERCENT,
  } = options;

  const results = {
    total:    items.length,
    success:  [],
    errors:   [],
    started:  new Date().toISOString(),
    finished: null,
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      if (!item.cpfCnpj) {
        throw new Error('CPF/CNPJ obrigatório (cliente sem identificação)');
      }
      if (!(item.value > 0)) {
        throw new Error('valor inválido');
      }
      if (!item.dueDate) {
        throw new Error('vencimento obrigatório');
      }

      const customer = await client.findOrCreateCustomer({
        name:        item.name,
        cpfCnpj:     item.cpfCnpj,
        email:       item.email,
        phone:       item.phone,
        mobilePhone: item.mobilePhone || item.phone,
      });

      const payment = await client.createPayment({
        customerId:        customer.id,
        value:             Number(item.value),
        dueDate:           item.dueDate,
        billingType,
        description:       item.description,
        externalReference: item.externalReference,
        interestPercent,
        finePercent,
      });

      results.success.push({
        idx:           i,
        name:          item.name,
        cpfCnpj:       item.cpfCnpj,
        value:         payment.value,
        customer_id:   customer.id,
        payment_id:    payment.id,
        invoice_url:   payment.invoiceUrl,        // página de pagamento ASAAS
        bank_slip_url: payment.bankSlipUrl,       // boleto PDF
        pix_qr_url:    payment.pixQrCodeId ? `/api/asaas/pix-qr/${payment.id}` : null,
        due_date:      payment.dueDate,
        status:        payment.status,
      });
    } catch (err) {
      results.errors.push({
        idx:     i,
        name:    item.name,
        cpfCnpj: item.cpfCnpj,
        value:   item.value,
        error:   err.message || String(err),
      });
    }
    if (i < items.length - 1) await sleep(REQ_DELAY_MS);
  }

  results.finished = new Date().toISOString();
  return results;
}

module.exports = { createBatch };
