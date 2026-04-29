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

async function migrate() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id               SERIAL PRIMARY KEY,
        chatguru_id      VARCHAR(255) UNIQUE,
        name             VARCHAR(500),
        phone            VARCHAR(50),
        email            VARCHAR(255),
        message          TEXT,
        campaign         VARCHAR(255),
        tipo             VARCHAR(100),
        responsible_zone VARCHAR(100),
        stage            VARCHAR(100) NOT NULL DEFAULT 'TRIAGEM',
        advbox_lawsuit_id   VARCHAR(255),
        advbox_customer_id  VARCHAR(255),
        notes            TEXT,
        created_at       TIMESTAMP DEFAULT NOW(),
        updated_at       TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_leads_stage   ON leads(stage);
      CREATE INDEX IF NOT EXISTS idx_leads_zone    ON leads(responsible_zone);
      CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS birthday_messages_log (
        id            SERIAL PRIMARY KEY,
        client_id     INTEGER,
        client_name   VARCHAR(500),
        client_phone  VARCHAR(50),
        variation_used SMALLINT,
        sent_at       TIMESTAMP DEFAULT NOW(),
        status        VARCHAR(20) NOT NULL DEFAULT 'sent',
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_bml_sent_at   ON birthday_messages_log(sent_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bml_client_id ON birthday_messages_log(client_id);

      CREATE TABLE IF NOT EXISTS app_config (
        key   VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    await pool.query(`
      CREATE OR REPLACE FUNCTION update_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ LANGUAGE plpgsql;
    `);

    await pool.query(`
      DROP TRIGGER IF EXISTS leads_updated_at ON leads;
      CREATE TRIGGER leads_updated_at
        BEFORE UPDATE ON leads
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_resolved (
        id           SERIAL PRIMARY KEY,
        lawsuit_id   VARCHAR(100) NOT NULL,
        cliente      VARCHAR(500),
        fase         VARCHAR(255),
        responsible  VARCHAR(255),
        destino_zone VARCHAR(100),
        destino_label VARCHAR(255),
        resolved_by  VARCHAR(100) DEFAULT 'admin',
        resolved_at  TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_resolved_at ON audit_resolved(resolved_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_resolved_lid ON audit_resolved(lawsuit_id);

      CREATE TABLE IF NOT EXISTS audit_cobranca_log (
        id           SERIAL PRIMARY KEY,
        person_name  VARCHAR(255) NOT NULL,
        quantidade   INTEGER NOT NULL,
        detalhes     TEXT,
        logged_at    TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_cob_at ON audit_cobranca_log(logged_at DESC);

      CREATE TABLE IF NOT EXISTS inss_conference_log (
        id               SERIAL PRIMARY KEY,
        total            INTEGER NOT NULL DEFAULT 0,
        coerentes        INTEGER NOT NULL DEFAULT 0,
        divergentes      INTEGER NOT NULL DEFAULT 0,
        nao_encontrados  INTEGER NOT NULL DEFAULT 0,
        detalhes         TEXT,
        conferido_em     TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_icl_at ON inss_conference_log(conferido_em DESC);
    `);

    console.log('[DB] Schema verificado/criado com sucesso.');
  } catch (err) {
    console.error('[DB] Erro na migração:', err.message);
  }
}

module.exports = { pool, query, migrate };
