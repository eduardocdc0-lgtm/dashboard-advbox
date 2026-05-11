/**
 * Agendador de mensagens pro Discord via Webhook.
 *
 * Persistência: tabela `discord_scheduled` no Postgres.
 * Disparo: cron de 1 minuto varre mensagens pendentes (send_at <= now)
 *          que ainda não foram enviadas. Pra mensagens repetidas
 *          (daily/weekly), agenda a próxima após enviar.
 *
 * URL do webhook vem de ENV `DISCORD_WEBHOOK_URL` (padrão).
 * Pode passar `channel_url` pra agendar pra outro canal.
 */

'use strict';

const fetch = require('node-fetch');
const { query } = require('./db');

const DEFAULT_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';

async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS discord_scheduled (
      id SERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      username TEXT,
      channel_url TEXT,
      send_at TIMESTAMPTZ NOT NULL,
      repeats TEXT DEFAULT 'once',  -- 'once' | 'daily' | 'weekly'
      sent_at TIMESTAMPTZ,
      last_error TEXT,
      cancelled BOOLEAN DEFAULT false,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_discord_due ON discord_scheduled(send_at)
      WHERE sent_at IS NULL AND cancelled = false;
  `);
}

/**
 * Agenda uma mensagem.
 * opts: { content, sendAt (Date|ISO), repeats?, username?, channelUrl?, createdBy? }
 * Retorna { id, send_at }.
 */
async function scheduleMessage(opts) {
  await ensureTable();
  const { content, sendAt, repeats = 'once', username, channelUrl, createdBy } = opts;
  if (!content) throw new Error('content é obrigatório');
  if (!sendAt) throw new Error('sendAt é obrigatório');
  const sendAtDate = sendAt instanceof Date ? sendAt : new Date(sendAt);
  if (isNaN(sendAtDate)) throw new Error('sendAt inválido');
  if (!['once', 'daily', 'weekly'].includes(repeats)) {
    throw new Error('repeats deve ser once|daily|weekly');
  }

  const r = await query(`
    INSERT INTO discord_scheduled (content, username, channel_url, send_at, repeats, created_by)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, send_at;
  `, [content, username || null, channelUrl || null, sendAtDate.toISOString(), repeats, createdBy || null]);
  return r.rows[0];
}

async function listScheduled({ includeSent = false } = {}) {
  await ensureTable();
  const where = includeSent ? 'TRUE' : 'sent_at IS NULL AND cancelled = false';
  const r = await query(`SELECT * FROM discord_scheduled WHERE ${where} ORDER BY send_at ASC LIMIT 100`);
  return r.rows;
}

async function cancelMessage(id) {
  await ensureTable();
  await query(`UPDATE discord_scheduled SET cancelled = true WHERE id = $1`, [id]);
}

/**
 * Envia uma mensagem via webhook Discord. Retorna { ok, status, body }.
 */
async function sendWebhook(content, { username, url } = {}) {
  const webhook = url || DEFAULT_WEBHOOK;
  if (!webhook) throw new Error('DISCORD_WEBHOOK_URL não configurado');
  const payload = { content };
  if (username) payload.username = username;

  const resp = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  // Webhook responde 204 (sem body) em sucesso
  const text = resp.status === 204 ? '' : await resp.text();
  return { ok: resp.ok, status: resp.status, body: text };
}

/**
 * Roda 1 ciclo: envia mensagens vencidas e reagenda repetidas.
 * Retorna { enviadas, erros, detalhes }.
 */
async function runDueMessages({ logger = console } = {}) {
  await ensureTable();
  const r = await query(`
    SELECT * FROM discord_scheduled
    WHERE sent_at IS NULL AND cancelled = false AND send_at <= NOW()
    ORDER BY send_at ASC LIMIT 50
  `);
  let enviadas = 0, erros = 0;
  const detalhes = [];

  for (const msg of r.rows) {
    try {
      const result = await sendWebhook(msg.content, {
        username: msg.username,
        url: msg.channel_url,
      });
      if (!result.ok) throw new Error(`HTTP ${result.status}: ${result.body}`);

      await query(`
        UPDATE discord_scheduled SET sent_at = NOW(), last_error = NULL WHERE id = $1
      `, [msg.id]);
      enviadas++;
      detalhes.push({ id: msg.id, ok: true });

      // Reagenda se repetitivo
      if (msg.repeats === 'daily' || msg.repeats === 'weekly') {
        const next = new Date(msg.send_at);
        if (msg.repeats === 'daily') next.setDate(next.getDate() + 1);
        else next.setDate(next.getDate() + 7);
        await query(`
          INSERT INTO discord_scheduled
            (content, username, channel_url, send_at, repeats, created_by)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [msg.content, msg.username, msg.channel_url, next.toISOString(), msg.repeats, msg.created_by]);
      }
    } catch (e) {
      erros++;
      const errMsg = e.message.slice(0, 500);
      await query(`UPDATE discord_scheduled SET last_error = $1 WHERE id = $2`, [errMsg, msg.id]);
      logger.error(`[Discord] Falha ao enviar #${msg.id}: ${errMsg}`);
      detalhes.push({ id: msg.id, ok: false, error: errMsg });
    }
  }

  return { enviadas, erros, detalhes };
}

module.exports = {
  scheduleMessage,
  listScheduled,
  cancelMessage,
  sendWebhook,
  runDueMessages,
  ensureTable,
};
