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
    -- Anexos: aceita URL pública (Drive/S3/etc). Discord webhook tem limite de 8MB
    -- (25MB com server boost). Suporta mp4, png, pdf, etc. Adicionado em 2026-05.
    ALTER TABLE discord_scheduled ADD COLUMN IF NOT EXISTS attachment_url TEXT;
    ALTER TABLE discord_scheduled ADD COLUMN IF NOT EXISTS attachment_filename TEXT;
  `);
}

/**
 * Agenda uma mensagem.
 * opts: { content, sendAt (Date|ISO), repeats?, username?, channelUrl?, createdBy?,
 *         attachmentUrl?, attachmentFilename? }
 * Retorna { id, send_at }.
 */
async function scheduleMessage(opts) {
  await ensureTable();
  const {
    content, sendAt, repeats = 'once', username, channelUrl, createdBy,
    attachmentUrl, attachmentFilename,
  } = opts;
  if (!content && !attachmentUrl) {
    throw new Error('content ou attachmentUrl é obrigatório');
  }
  if (!sendAt) throw new Error('sendAt é obrigatório');
  const sendAtDate = sendAt instanceof Date ? sendAt : new Date(sendAt);
  if (isNaN(sendAtDate)) throw new Error('sendAt inválido');
  if (!['once', 'daily', 'weekly'].includes(repeats)) {
    throw new Error('repeats deve ser once|daily|weekly');
  }
  if (attachmentUrl && !/^https?:\/\//i.test(attachmentUrl)) {
    throw new Error('attachmentUrl deve ser http(s) público');
  }

  const r = await query(`
    INSERT INTO discord_scheduled
      (content, username, channel_url, send_at, repeats, created_by,
       attachment_url, attachment_filename)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id, send_at;
  `, [
    content || '',
    username || null,
    channelUrl || null,
    sendAtDate.toISOString(),
    repeats,
    createdBy || null,
    attachmentUrl || null,
    attachmentFilename || null,
  ]);
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

// Limite default de webhook Discord (8 MiB sem boost, 25 MiB com boost).
// Pode aumentar via env DISCORD_ATTACH_MAX_MB. Excede → erro antes de gastar tráfego.
const ATTACH_MAX_BYTES = (Number(process.env.DISCORD_ATTACH_MAX_MB) || 8) * 1024 * 1024;

/** Deriva filename de uma URL (ex: ".../arquivo.pdf?x=1" → "arquivo.pdf"). */
function filenameFromUrl(u) {
  try {
    const path = new URL(u).pathname;
    const name = decodeURIComponent(path.split('/').pop() || '');
    return name && name.includes('.') ? name : null;
  } catch { return null; }
}

/**
 * Baixa o anexo da URL pública e devolve { buffer, filename, contentType }.
 * Streamzinho controlado — aborta se passar do limite.
 */
async function fetchAttachment(attachmentUrl, suggestedFilename) {
  // fetch global do Node 18+ (não usa node-fetch v2 aqui — node-fetch não
  // entende o FormData nativo do Node, então padronizamos com fetch+FormData
  // built-in pra essa função).
  const resp = await global.fetch(attachmentUrl, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ao baixar attachmentUrl`);

  const contentType = resp.headers.get('content-type') || 'application/octet-stream';
  const declaredLen = Number(resp.headers.get('content-length') || 0);
  if (declaredLen && declaredLen > ATTACH_MAX_BYTES) {
    throw new Error(`Anexo ${declaredLen} bytes excede limite (${ATTACH_MAX_BYTES})`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  if (arrayBuffer.byteLength > ATTACH_MAX_BYTES) {
    throw new Error(`Anexo baixado ${arrayBuffer.byteLength} bytes excede limite`);
  }

  const filename = suggestedFilename || filenameFromUrl(attachmentUrl) || 'anexo.bin';
  return { buffer: Buffer.from(arrayBuffer), filename, contentType };
}

/**
 * Envia uma mensagem via webhook Discord. Retorna { ok, status, body }.
 * opts: { username?, url?, attachmentUrl?, attachmentFilename? }
 *
 * Quando attachmentUrl é informado, monta multipart/form-data e anexa o arquivo
 * (Discord aceita imagens, vídeos, PDFs até ~8 MiB no canal sem boost).
 */
async function sendWebhook(content, { username, url, attachmentUrl, attachmentFilename } = {}) {
  const webhook = url || DEFAULT_WEBHOOK;
  if (!webhook) throw new Error('DISCORD_WEBHOOK_URL não configurado');

  const payload = { content: content || '' };
  if (username) payload.username = username;

  // ── Sem anexo: JSON simples (caminho rápido)
  if (!attachmentUrl) {
    const resp = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = resp.status === 204 ? '' : await resp.text();
    return { ok: resp.ok, status: resp.status, body: text };
  }

  // ── Com anexo: multipart usando FormData nativo do Node 18+
  const { buffer, filename, contentType } = await fetchAttachment(attachmentUrl, attachmentFilename);
  const form = new global.FormData();
  // payload_json define content + username + outras opções do webhook
  form.append('payload_json', JSON.stringify(payload));
  // files[0] = anexo binário (Discord aceita até 10 anexos: files[0]..files[9])
  form.append('files[0]', new global.Blob([buffer], { type: contentType }), filename);

  const resp = await global.fetch(webhook, { method: 'POST', body: form });
  const text = resp.status === 204 ? '' : await resp.text();
  return { ok: resp.ok, status: resp.status, body: text, attachment: { filename, bytes: buffer.length } };
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
        attachmentUrl: msg.attachment_url,
        attachmentFilename: msg.attachment_filename,
      });
      if (!result.ok) throw new Error(`HTTP ${result.status}: ${result.body}`);

      await query(`
        UPDATE discord_scheduled SET sent_at = NOW(), last_error = NULL WHERE id = $1
      `, [msg.id]);
      enviadas++;
      detalhes.push({ id: msg.id, ok: true });

      // Reagenda se repetitivo (preserva anexo nas próximas execuções)
      if (msg.repeats === 'daily' || msg.repeats === 'weekly') {
        const next = new Date(msg.send_at);
        if (msg.repeats === 'daily') next.setDate(next.getDate() + 1);
        else next.setDate(next.getDate() + 7);
        await query(`
          INSERT INTO discord_scheduled
            (content, username, channel_url, send_at, repeats, created_by,
             attachment_url, attachment_filename)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          msg.content, msg.username, msg.channel_url, next.toISOString(),
          msg.repeats, msg.created_by, msg.attachment_url, msg.attachment_filename,
        ]);
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
