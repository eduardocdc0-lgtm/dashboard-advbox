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

  const url = `${BASE_URL}/accounts/${ACCOUNT_ID}/contacts/send_message`;

  const body = {
    phone_id: PHONE_ID,
    to:       phone,
    message,
    type:     'text',
  };

  const resp = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${API_KEY}`,
      'api_access_token': API_KEY,
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!resp.ok) {
    const msg = json.message || json.error || json.raw || `HTTP ${resp.status}`;
    throw Object.assign(new Error(msg), { status: resp.status, body: json });
  }

  return json;
}

module.exports = { sendWhatsApp, cleanPhone };
