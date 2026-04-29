/**
 * ChatGuru – cliente para envio de mensagens outbound via WhatsApp.
 * Credenciais via variáveis de ambiente.
 */

const fetch = require('node-fetch');

const BASE_URL    = process.env.CHATGURU_BASE_URL      || 'https://s22.chatguru.app/api/v1';
const ACCOUNT_ID  = process.env.CHATGURU_ACCOUNT_ID    || '';
const PHONE_ID    = process.env.CHATGURU_PHONE_ID      || '';
const API_KEY     = process.env.CHATGURU_API_KEY        || '';

function cleanPhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 0) return null;
  if (digits.startsWith('55')) return digits;
  if (digits.length === 10 || digits.length === 11) return '55' + digits;
  return digits;
}

async function sendWhatsApp(toPhone, message) {
  const phone = cleanPhone(toPhone);
  if (!phone) throw new Error('Telefone inválido: ' + toPhone);
  if (!API_KEY)    throw new Error('CHATGURU_API_KEY não configurado.');
  if (!ACCOUNT_ID) throw new Error('CHATGURU_ACCOUNT_ID não configurado.');
  if (!PHONE_ID)   throw new Error('CHATGURU_PHONE_ID não configurado.');

  // ChatGuru usa POST /api/v1 com form-urlencoded
  const params = new URLSearchParams({
    key:        API_KEY,
    account_id: ACCOUNT_ID,
    action:     'send_message',
    phone_id:   PHONE_ID,
    to:         phone,
    message,
  });

  const resp = await fetch(BASE_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
  });

  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }

  // ChatGuru retorna { code: 200, result: "success" } em sucesso
  if (json.result === 'success' || json.code === 200) return json;

  if (!resp.ok || json.result === 'error') {
    const msg = json.description || json.message || json.error || `HTTP ${resp.status}`;
    throw Object.assign(new Error(msg), { status: resp.status, body: json });
  }

  return json;
}

module.exports = { sendWhatsApp, cleanPhone };
