const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Erro inesperado no pool:', err.message);
});

async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const ms = Date.now() - start;
    if (ms > 2000) console.warn(`[DB] Query lenta (${ms}ms):`, text.slice(0, 80));
    return result;
  } catch (err) {
    console.error('[DB] Erro na query:', err.message, '|', text.slice(0, 80));
    throw err;
  }
}

module.exports = { pool, query };
