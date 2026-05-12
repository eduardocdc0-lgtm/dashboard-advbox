/**
 * Cliente da API pública do DJEN (Diário de Justiça Eletrônico Nacional).
 *
 * https://comunicaapi.pje.jus.br/swagger/index.html
 *
 * Endpoints GET são PÚBLICOS — não exigem autenticação.
 * Apenas POST exige (e só Tribunais podem postar). Aqui só consumo.
 *
 * Uso típico:
 *   const c = new DjenClient({ oab: '64717', uf: 'PE' });
 *   const items = await c.fetchSince('2026-05-01');
 */

'use strict';

const fetch = require('node-fetch');

const BASE = 'https://comunicaapi.pje.jus.br/api/v1';
const UA = 'Mozilla/5.0 (compatible; advbox-dashboard/1.0; +https://advbox-dashboard.replit.app)';

class DjenClient {
  constructor({ oab, uf, logger = console } = {}) {
    if (!oab) throw new Error('oab é obrigatório (ex: "64717")');
    if (!uf)  throw new Error('uf é obrigatório (ex: "PE")');
    this.oab = String(oab).replace(/\D/g, ''); // só dígitos
    this.uf = String(uf).toUpperCase();
    this.logger = logger;
  }

  async _get(path, params) {
    const qs = new URLSearchParams(params).toString();
    const url = `${BASE}${path}?${qs}`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`DJEN ${resp.status}: ${body.slice(0, 200)}`);
    }
    return resp.json();
  }

  /**
   * Lista comunicações da OAB. Pagina automaticamente.
   * @param {object} opts
   * @param {string} [opts.since]  ISO date YYYY-MM-DD — filtra data_disponibilizacao >= since
   * @param {number} [opts.maxPages=10]
   * @param {number} [opts.pageSize=200]
   * @returns {Array} items
   */
  async list({ since, maxPages = 10, pageSize = 200 } = {}) {
    const all = [];
    for (let pagina = 1; pagina <= maxPages; pagina++) {
      const data = await this._get('/comunicacao', {
        numeroOab: this.oab,
        ufOab: this.uf,
        pagina,
        itensPorPagina: pageSize,
      });
      const items = data?.items || [];
      if (!items.length) break;
      all.push(...items);
      // Se a página retornou itens com data anterior ao since, podemos parar
      if (since) {
        const oldest = items[items.length - 1]?.data_disponibilizacao;
        if (oldest && oldest < since) break;
      }
      if (items.length < pageSize) break;
    }
    if (since) return all.filter(i => (i.data_disponibilizacao || '') >= since);
    return all;
  }

  /**
   * Pega comunicações dos últimos N dias.
   */
  async fetchLastDays(days = 7) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    const since = d.toISOString().slice(0, 10);
    return this.list({ since });
  }
}

/**
 * Normaliza número de processo pro formato com máscara (00000-00.0000.0.00.0000)
 * a partir de uma string solta. Aceita já-com-máscara e devolve igual.
 */
function normalizarNumeroProcesso(s) {
  if (!s) return null;
  const limpo = String(s).replace(/\D/g, '');
  if (limpo.length !== 20) return null;
  // NNNNNNN-DD.AAAA.J.TR.OOOO
  return `${limpo.slice(0, 7)}-${limpo.slice(7, 9)}.${limpo.slice(9, 13)}.${limpo.slice(13, 14)}.${limpo.slice(14, 16)}.${limpo.slice(16, 20)}`;
}

module.exports = { DjenClient, normalizarNumeroProcesso };
