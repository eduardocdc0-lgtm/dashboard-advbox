/**
 * ChatGuru – cliente para envio de mensagens outbound via WhatsApp.
 * Formato descoberto via Guru-Api-Hub:
 *   POST https://s22.chatguru.app/api/v1?key=...&action=message_send&...
 *   (params na query string, não no body)
 *   send_date obrigatório: 1 minuto no futuro, formato YYYY-MM-DD HH:MM
 *   Campo destino: chat_number  |  Texto: text
 */

const fetch = require('node-fetch');

const BASE_URL   = process.env.CHATGURU_BASE_URL   || 'https://s22.chatguru.app/api/v1';
const ACCOUNT_ID = process.env.CHATGURU_ACCOUNT_ID || '';
const PHONE_ID   = process.env.CHATGURU_PHONE_ID   || '';
const API_KEY    = process.env.CHATGURU_API_KEY     || '';

function cleanPhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (!digits.length) return null;
  if (digits.startsWith('55')) return digits;
  if (digits.length === 10 || digits.length === 11) return '55' + digits;
  return digits;
}

function buildSendDate(offsetMs = 70 * 1000) {
  const d   = new Date(Date.now() + offsetMs);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function sendWhatsApp(toPhone, message, phoneId) {
  const phone = cleanPhone(toPhone);
  if (!phone) throw new Error('Telefone inválido: ' + toPhone);
  if (!API_KEY)    throw new Error('CHATGURU_API_KEY não configurado.');
  if (!ACCOUNT_ID) throw new Error('CHATGURU_ACCOUNT_ID não configurado.');

  const resolvedPhoneId = phoneId || PHONE_ID;
  if (!resolvedPhoneId) throw new Error('CHATGURU_PHONE_ID não configurado.');

  const params = new URLSearchParams({
    key:         API_KEY,
    account_id:  ACCOUNT_ID,
    phone_id:    resolvedPhoneId,
    action:      'message_send',
    chat_number: phone,
    text:        message,
    send_date:   buildSendDate(),
  });

  const resp = await fetch(`${BASE_URL}?${params}`, { method: 'POST' });

  const raw = await resp.json().catch(() => ({}));

  const ok = raw.result === 'success' || raw.code === 200 || raw.code === 201;
  if (!ok) {
    const msg = raw.description || raw.message || raw.error || `HTTP ${resp.status}`;
    throw Object.assign(new Error(msg), { status: resp.status, body: raw });
  }

  return { ok: true, messageId: raw.message_id ?? null, status: raw.message_status ?? null, raw };
}

module.exports = { sendWhatsApp, cleanPhone };
