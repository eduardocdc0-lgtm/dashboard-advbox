/**
 * Serviço de mensagens de aniversário — busca clientes ativos,
 * envia via ChatGuru e registra no log.
 */

const { query } = require('./db');
const { sendWhatsApp } = require('./chatguru-sender');

const VARIACOES = [
  (nome) =>
`${nome}, bom dia! 🎂

Só passando pra te desejar um feliz aniversário e um dia muito especial.

Que Deus te abençoe e que esse novo ano seja repleto de boas notícias.

Abraço!
Eduardo`,

  (nome) =>
`Bom dia, ${nome}!

Passei aqui só pra te desejar um feliz aniversário. 🎉

Que esse novo ciclo venha cheio de saúde, paz e boas conquistas pra você e pra sua família.

Forte abraço,
Eduardo`,

  (nome) =>
`Oi, ${nome}! Tudo bem?

Hoje é seu aniversário e eu não podia deixar passar sem te mandar um abraço. 🎂

Que Deus te abençoe nesse novo ano e que venha cheio de coisa boa.

Abraço,
Eduardo`,

  (nome) =>
`${nome}, feliz aniversário! 🎉

Que esse seu novo ano seja muito especial, com saúde, paz e realizações.

Um forte abraço,
Eduardo`,
];

function primeiroNome(fullName) {
  return (fullName || '').trim().split(/\s+/)[0] || fullName;
}

function parseDate(str) {
  if (!str) return null;
  const [d, m] = str.split('/').map(Number);
  if (!d || !m) return null;
  return { day: d, month: m };
}

function ehAniversarioHoje(birthdate) {
  const parsed = parseDate(birthdate);
  if (!parsed) return false;
  const now = new Date();
  return parsed.day === now.getDate() && parsed.month === (now.getMonth() + 1);
}

async function getAniversariantesHoje(customers) {
  return (customers || []).filter(c => {
    const ativo = Array.isArray(c.lawsuits) && c.lawsuits.length > 0;
    return ativo && ehAniversarioHoje(c.birthdate) && (c.cellphone || c.phone);
  });
}

async function getAniversariantesMes(customers) {
  const now = new Date();
  const mesAtual = now.getMonth() + 1;
  return (customers || []).filter(c => {
    const ativo = Array.isArray(c.lawsuits) && c.lawsuits.length > 0;
    const parsed = parseDate(c.birthdate);
    return ativo && parsed && parsed.month === mesAtual && (c.cellphone || c.phone);
  }).sort((a, b) => {
    const pa = parseDate(a.birthdate);
    const pb = parseDate(b.birthdate);
    return pa.day - pb.day;
  });
}

async function enviarMensagem(cliente, variacaoIdx = null) {
  const nome  = primeiroNome(cliente.name);
  const phone = cliente.cellphone || cliente.phone;
  const idx   = variacaoIdx !== null ? variacaoIdx : Math.floor(Math.random() * 4);
  const msg   = VARIACOES[idx](nome);

  let status = 'sent';
  let errorMsg = null;
  let apiResp = null;

  try {
    apiResp = await sendWhatsApp(phone, msg);
  } catch (err) {
    status   = 'failed';
    errorMsg = err.message;
    console.error(`[Birthday] Falha ao enviar para ${nome} (${phone}):`, err.message);
  }

  await query(
    `INSERT INTO birthday_messages_log
       (client_id, client_name, client_phone, variation_used, status, error_message)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [cliente.id, cliente.name, phone, idx + 1, status, errorMsg]
  );

  return { nome, phone, status, errorMsg, variation: idx + 1, apiResp };
}

async function processarAniversariantesHoje(customers) {
  const lista = await getAniversariantesHoje(customers);
  console.log(`[Birthday] Aniversariantes hoje: ${lista.length}`);

  const resultados = [];
  for (const c of lista) {
    const r = await enviarMensagem(c);
    resultados.push(r);
    console.log(`[Birthday] ${r.status === 'sent' ? '✓' : '✗'} ${r.nome} (${r.phone})`);
    if (lista.indexOf(c) < lista.length - 1) {
      await new Promise(res => setTimeout(res, 2000));
    }
  }
  return resultados;
}

async function getHistorico(limit = 100) {
  const result = await query(
    `SELECT * FROM birthday_messages_log ORDER BY sent_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

async function getConfig() {
  const result = await query(
    `SELECT value FROM app_config WHERE key = 'birthday_auto_enabled' LIMIT 1`
  );
  return result.rows[0]?.value === 'true';
}

async function setConfig(enabled) {
  await query(
    `INSERT INTO app_config (key, value) VALUES ('birthday_auto_enabled', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [enabled ? 'true' : 'false']
  );
}

module.exports = {
  getAniversariantesHoje,
  getAniversariantesMes,
  enviarMensagem,
  processarAniversariantesHoje,
  getHistorico,
  getConfig,
  setConfig,
  VARIACOES,
  primeiroNome,
};
