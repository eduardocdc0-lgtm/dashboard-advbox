const { query } = require('./db');

// ── Classificação de campanha ─────────────────────────────────────────────────

const CAMPAIGN_RULES = [
  { match: /laudo\s*sus|laudo|sus/i,         campaign: 'Laudo SUS',   tipo: 'ADM',         zone: 'MARILIA'  },
  { match: /trabalhista|clt|emprego/i,        campaign: 'Trabalhista', tipo: 'TRABALHISTA', zone: 'EDUARDO'  },
  { match: /maternidade|gestante|bebe/i,      campaign: 'Maternidade', tipo: 'ADM',         zone: 'MARILIA'  },
  { match: /bpc|loas|defici/i,                campaign: 'BPC/LOAS',    tipo: 'ADM',         zone: 'MARILIA'  },
  { match: /aposentadoria|inss|previd/i,      campaign: 'INSS',        tipo: 'ADM',         zone: 'MARILIA'  },
  { match: /recurso|judicial|tribunal/i,      campaign: 'Judicial',    tipo: 'JUDICIAL',    zone: 'LETICIA_OU_ALICE' },
];

function classifyLead(message = '', campaignHint = '') {
  const text = (message + ' ' + campaignHint).toLowerCase();
  for (const rule of CAMPAIGN_RULES) {
    if (rule.match.test(text)) {
      return { campaign: rule.campaign, tipo: rule.tipo, responsible_zone: rule.zone };
    }
  }
  return { campaign: 'Geral', tipo: 'ADM', responsible_zone: 'MARILIA' };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

const VALID_STAGES = ['TRIAGEM', 'PROTOCOLO_ADM', 'IMPLANTACAO', 'CONCLUIDO', 'CANCELADO'];

async function createLead({ chatguru_id, name, phone, email, message, campaign_hint }) {
  const classification = classifyLead(message, campaign_hint);

  const existing = chatguru_id
    ? await query('SELECT id FROM leads WHERE chatguru_id = $1', [chatguru_id])
    : { rows: [] };

  if (existing.rows.length > 0) {
    return { lead: existing.rows[0], created: false };
  }

  const result = await query(
    `INSERT INTO leads (chatguru_id, name, phone, email, message, campaign, tipo, responsible_zone, stage)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'TRIAGEM')
     RETURNING *`,
    [chatguru_id || null, name, phone, email, message,
     classification.campaign, classification.tipo, classification.responsible_zone]
  );

  console.log(`[Leads] Novo lead criado: ${name} | ${classification.campaign} → ${classification.responsible_zone}`);
  return { lead: result.rows[0], created: true };
}

async function listLeads({ stage, zone, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  let p = 1;

  if (stage) { conditions.push(`stage = $${p++}`); params.push(stage); }
  if (zone)  { conditions.push(`responsible_zone = $${p++}`); params.push(zone); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(limit, offset);

  const result = await query(
    `SELECT * FROM leads ${where} ORDER BY created_at DESC LIMIT $${p} OFFSET $${p + 1}`,
    params
  );
  const count = await query(
    `SELECT COUNT(*) FROM leads ${where}`,
    params.slice(0, -2)
  );

  return { leads: result.rows, total: parseInt(count.rows[0].count) };
}

async function getLead(id) {
  const result = await query('SELECT * FROM leads WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function updateStage(id, stage, notes = null) {
  if (!VALID_STAGES.includes(stage)) throw new Error(`Fase inválida: ${stage}`);

  const result = await query(
    `UPDATE leads SET stage = $1, notes = COALESCE($2, notes) WHERE id = $3 RETURNING *`,
    [stage, notes, id]
  );

  if (!result.rows.length) throw new Error('Lead não encontrado.');
  console.log(`[Leads] Lead #${id} → ${stage}`);
  return result.rows[0];
}

async function updateAdvboxIds(id, { lawsuit_id, customer_id }) {
  const result = await query(
    `UPDATE leads SET advbox_lawsuit_id = $1, advbox_customer_id = $2 WHERE id = $3 RETURNING *`,
    [lawsuit_id || null, customer_id || null, id]
  );
  return result.rows[0] || null;
}

async function getStats() {
  const result = await query(`
    SELECT
      stage,
      responsible_zone,
      COUNT(*) AS total
    FROM leads
    GROUP BY stage, responsible_zone
    ORDER BY stage, responsible_zone
  `);

  const byStage = {};
  for (const row of result.rows) {
    if (!byStage[row.stage]) byStage[row.stage] = { total: 0, zones: {} };
    byStage[row.stage].total += parseInt(row.total);
    byStage[row.stage].zones[row.responsible_zone] = parseInt(row.total);
  }

  return { byStage };
}

module.exports = { createLead, listLeads, getLead, updateStage, updateAdvboxIds, getStats, classifyLead, VALID_STAGES };
