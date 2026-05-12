/**
 * Sincroniza publicações DJEN → tarefas no AdvBox.
 *
 * Fluxo:
 *  1. Busca publicações novas da OAB do escritório no DJEN.
 *  2. Pra cada publicação, normaliza process_number e procura no AdvBox.
 *  3. Se match → cria tarefa no processo (template MANIFESTAÇÃO).
 *  4. Se não match → log em djen_unmatched pra revisão manual.
 *  5. Dedupe por `hash` da publicação (não recria).
 */

'use strict';

const fetch = require('node-fetch');
const { query } = require('./db');
const { fetchLawsuits } = require('./data');
const { DjenClient, normalizarNumeroProcesso } = require('./djen-client');

const ADVBOX_BASE = 'https://app.advbox.com.br/api/v1';
const ADVBOX_UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const ENV_OAB = process.env.DJEN_OAB    || '64717';
const ENV_UF  = process.env.DJEN_OAB_UF || 'PE';

// ID da Task "ACOMPANHAR ANDAMENTO" no AdvBox (descoberto via /settings)
const TASK_ID_ACOMPANHAR_ANDAMENTO = 8894482;

async function ensureTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS djen_seen (
      hash TEXT PRIMARY KEY,
      numero_processo TEXT,
      data_disponibilizacao DATE,
      tribunal TEXT,
      tipo_comunicacao TEXT,
      lawsuit_id INT,
      task_created_id INT,
      task_error TEXT,
      processed_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_djen_seen_data ON djen_seen(data_disponibilizacao DESC);
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS djen_unmatched (
      id SERIAL PRIMARY KEY,
      hash TEXT UNIQUE,
      numero_processo TEXT,
      tribunal TEXT,
      tipo_comunicacao TEXT,
      texto_preview TEXT,
      data_disponibilizacao DATE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

async function createAdvBoxTask({ lawsuitId, titulo, notes, prazoDias = 5 }) {
  const start = new Date();
  const deadline = new Date(start.getTime() + prazoDias * 86400_000);
  const payload = {
    tasks_id: TASK_ID_ACOMPANHAR_ANDAMENTO,
    start_date: start.toISOString().slice(0, 10),
    date_deadline: deadline.toISOString().slice(0, 10),
    from: 'Auto-DJEN',
    lawsuits_id: lawsuitId,
    guests: [],
    notes: `[Auto-DJEN]\n${notes || ''}`.slice(0, 4000),
  };
  const resp = await fetch(`${ADVBOX_BASE}/posts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.ADVBOX_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': ADVBOX_UA,
    },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!resp.ok) {
    throw new Error(`AdvBox ${resp.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

/**
 * Roda 1 ciclo de sincronização.
 * @param {object} opts
 * @param {number} [opts.days=7]   busca publicações dos últimos N dias
 * @param {boolean} [opts.dryRun]  não cria tarefas no AdvBox, só simula
 * @param {string} [opts.oab]      sobrescreve env DJEN_OAB
 * @param {string} [opts.uf]
 */
async function syncCycle({ days = 7, dryRun = false, oab, uf, logger = console } = {}) {
  await ensureTables();

  const client = new DjenClient({ oab: oab || ENV_OAB, uf: uf || ENV_UF, logger });
  const items = await client.fetchLastDays(days);
  logger.info(`[DJEN] ${items.length} publicações encontradas (últimos ${days} dias)`);

  if (!items.length) return { items: 0, novos: 0, criados: 0, unmatched: 0 };

  // Quais hashes já foram processados?
  const hashes = items.map(i => i.hash).filter(Boolean);
  const seenRes = hashes.length
    ? await query(`SELECT hash FROM djen_seen WHERE hash = ANY($1::text[])`, [hashes])
    : { rows: [] };
  const jaVisto = new Set(seenRes.rows.map(r => r.hash));

  const novos = items.filter(i => i.hash && !jaVisto.has(i.hash));
  logger.info(`[DJEN] ${novos.length} novos (não vistos antes)`);

  if (!novos.length) return { items: items.length, novos: 0, criados: 0, unmatched: 0 };

  // Carrega lawsuits do AdvBox (cacheado) pra match por process_number
  const lawsuits = await fetchLawsuits();
  const byProcNum = new Map();
  for (const l of lawsuits) {
    const proc = normalizarNumeroProcesso(l.process_number) || l.process_number;
    if (proc) byProcNum.set(proc, l);
  }

  let criados = 0;
  let unmatched = 0;
  const detalhes = [];

  for (const item of novos) {
    const numeroProc = normalizarNumeroProcesso(item.numeroprocessocommascara || item.numero_processo);
    const lawsuit = numeroProc ? byProcNum.get(numeroProc) : null;

    if (!lawsuit) {
      unmatched++;
      if (!dryRun) {
        await query(`
          INSERT INTO djen_unmatched (hash, numero_processo, tribunal, tipo_comunicacao, texto_preview, data_disponibilizacao)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (hash) DO NOTHING
        `, [item.hash, numeroProc, item.siglaTribunal, item.tipoComunicacao, (item.texto || '').slice(0, 500), item.data_disponibilizacao]);
      }
      detalhes.push({ hash: item.hash, processo: numeroProc, status: 'unmatched', tribunal: item.siglaTribunal });
      continue;
    }

    // Tem match — cria tarefa
    if (dryRun) {
      criados++;
      detalhes.push({ hash: item.hash, processo: numeroProc, lawsuit_id: lawsuit.id, status: 'would-create' });
      continue;
    }

    const titulo = `${item.tipoComunicacao || 'Intimação'} — ${item.siglaTribunal || ''}`;
    const notes = `${titulo}\n${item.tipoDocumento || ''}\n\n${(item.texto || '').slice(0, 3000)}\n\nLink: ${item.link || ''}`;
    try {
      const task = await createAdvBoxTask({
        lawsuitId: lawsuit.id,
        titulo,
        notes,
        prazoDias: 5,
      });
      await query(`
        INSERT INTO djen_seen (hash, numero_processo, data_disponibilizacao, tribunal, tipo_comunicacao, lawsuit_id, task_created_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (hash) DO NOTHING
      `, [item.hash, numeroProc, item.data_disponibilizacao, item.siglaTribunal, item.tipoComunicacao, lawsuit.id, task?.id || null]);
      criados++;
      detalhes.push({ hash: item.hash, processo: numeroProc, lawsuit_id: lawsuit.id, task_id: task?.id, status: 'created' });
      // Rate limit safety entre POSTs
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      await query(`
        INSERT INTO djen_seen (hash, numero_processo, data_disponibilizacao, tribunal, tipo_comunicacao, lawsuit_id, task_error)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (hash) DO NOTHING
      `, [item.hash, numeroProc, item.data_disponibilizacao, item.siglaTribunal, item.tipoComunicacao, lawsuit.id, e.message.slice(0, 500)]);
      detalhes.push({ hash: item.hash, processo: numeroProc, lawsuit_id: lawsuit.id, status: 'error', error: e.message });
      logger.error(`[DJEN] Erro criando tarefa: ${e.message}`);
    }
  }

  return {
    items: items.length,
    novos: novos.length,
    criados,
    unmatched,
    dryRun: !!dryRun,
    detalhes: detalhes.slice(0, 50),
  };
}

module.exports = { syncCycle, ensureTables };
