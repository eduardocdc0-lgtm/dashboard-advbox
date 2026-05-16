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

      CREATE TABLE IF NOT EXISTS audit_actions (
        id                SERIAL PRIMARY KEY,
        actor_username    TEXT NOT NULL,
        actor_advbox_id   INT,
        action_type       TEXT NOT NULL,
        target_lawsuit_id BIGINT,
        target_user_id    INT,
        problema_payload  JSONB NOT NULL,
        advbox_response   JSONB,
        success           BOOLEAN NOT NULL,
        error_message     TEXT,
        created_at        TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_aa_created_at ON audit_actions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_aa_cooldown   ON audit_actions(action_type, target_lawsuit_id, created_at DESC);
    `);

    // ── Financeiro próprio do dashboard ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS financial_parcelas (
        id              SERIAL PRIMARY KEY,
        group_id        UUID NOT NULL,
        lawsuit_id      BIGINT,
        client_name     VARCHAR(500) NOT NULL,
        category        VARCHAR(100),
        kind            VARCHAR(20) NOT NULL DEFAULT 'parcelado',
        parcela_num     INTEGER NOT NULL DEFAULT 1,
        total_parcelas  INTEGER NOT NULL DEFAULT 1,
        due_date        DATE NOT NULL,
        value           NUMERIC(12,2) NOT NULL,
        status          VARCHAR(20) NOT NULL DEFAULT 'pendente',
        paid_date       DATE,
        paid_value      NUMERIC(12,2),
        notes           TEXT,
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_fp_due     ON financial_parcelas(due_date);
      CREATE INDEX IF NOT EXISTS idx_fp_status  ON financial_parcelas(status);
      CREATE INDEX IF NOT EXISTS idx_fp_group   ON financial_parcelas(group_id);
      CREATE INDEX IF NOT EXISTS idx_fp_lawsuit ON financial_parcelas(lawsuit_id);

      DROP TRIGGER IF EXISTS fp_updated_at ON financial_parcelas;
      CREATE TRIGGER fp_updated_at
        BEFORE UPDATE ON financial_parcelas
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    `);

    // ── ASAAS — override de pagador + histórico de pagamentos ──
    // payer_overrides: pra casos onde o cliente do processo é menor de idade
    // (criança em ação previdenciária) e quem paga é o responsável legal.
    // Indexado preferencialmente por lawsuit_id (todas as parcelas do mesmo
    // processo usam o mesmo pagador). Fallback por transaction_id quando
    // a transação não tem lawsuit vinculado.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS asaas_payer_overrides (
        id              SERIAL PRIMARY KEY,
        lawsuit_id      BIGINT,
        transaction_id  BIGINT,
        payer_name      VARCHAR(500) NOT NULL,
        payer_cpf_cnpj  VARCHAR(20)  NOT NULL,
        payer_email     VARCHAR(255),
        payer_phone     VARCHAR(50),
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_apo_lawsuit
        ON asaas_payer_overrides(lawsuit_id)
        WHERE lawsuit_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_apo_tx
        ON asaas_payer_overrides(transaction_id)
        WHERE lawsuit_id IS NULL AND transaction_id IS NOT NULL;

      DROP TRIGGER IF EXISTS apo_updated_at ON asaas_payer_overrides;
      CREATE TRIGGER apo_updated_at
        BEFORE UPDATE ON asaas_payer_overrides
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();

      CREATE TABLE IF NOT EXISTS asaas_payment_history (
        id                  SERIAL PRIMARY KEY,
        asaas_payment_id    VARCHAR(50) UNIQUE NOT NULL,
        external_reference  VARCHAR(255),
        event               VARCHAR(50) NOT NULL,
        status              VARCHAR(50) NOT NULL,
        value               NUMERIC(12,2),
        net_value           NUMERIC(12,2),
        customer_id         VARCHAR(50),
        paid_at             TIMESTAMP,
        raw_payload         JSONB,
        advbox_synced       BOOLEAN DEFAULT FALSE,
        advbox_sync_error   TEXT,
        created_at          TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_aph_ext_ref ON asaas_payment_history(external_reference);
      CREATE INDEX IF NOT EXISTS idx_aph_created ON asaas_payment_history(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_aph_status  ON asaas_payment_history(status);
    `);

    // ── CONTROLLER — snapshots diários pra tendência/produtividade ──
    // Uma linha por (snapshot_date, categoria_id). Cron 23h America/Recife
    // grava a foto antes de virar o dia. Daí dá pra calcular:
    //   - delta vs ontem (subiu/desceu)
    //   - volume entregue (linhas que saíram da categoria entre ontem e hoje)
    //   - tendência semanal (gráfico)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS controller_snapshots (
        id              SERIAL PRIMARY KEY,
        snapshot_date   DATE NOT NULL,
        categoria_id    VARCHAR(64) NOT NULL,
        setor_id        VARCHAR(64),
        total           INT NOT NULL DEFAULT 0,
        estourados      INT NOT NULL DEFAULT 0,
        dias_medios     NUMERIC(6,2) DEFAULT 0,
        sla_pct         INT DEFAULT 0,
        created_at      TIMESTAMP DEFAULT NOW(),
        CONSTRAINT uniq_cs_date_cat UNIQUE (snapshot_date, categoria_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cs_date  ON controller_snapshots(snapshot_date DESC);
      CREATE INDEX IF NOT EXISTS idx_cs_setor ON controller_snapshots(setor_id, snapshot_date DESC);
    `);

    // ── ADVBOX_FLOWTER_EVENTS — webhooks recebidos do Flowter (event-driven) ──
    // Toda chamada do Flowter persiste aqui (cru). Permite:
    //  - Debugar payload real do AdvBox antes de confiar em parsing
    //  - Auditar quem mandou, quando, o que aconteceu
    //  - Re-processar eventos antigos se a lógica de reação tiver bug
    // V1 só persiste. V2 (depois de ver payload real) adiciona reações.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS advbox_flowter_events (
        id              BIGSERIAL PRIMARY KEY,
        event_type      TEXT,
        lawsuit_id      INT,
        post_id         INT,
        stage           TEXT,
        payload         JSONB,
        received_at     TIMESTAMP DEFAULT NOW(),
        processed_at    TIMESTAMP,
        processed_ok    BOOLEAN,
        error_message   TEXT,
        source_ip       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_afe_received ON advbox_flowter_events(received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_afe_lawsuit ON advbox_flowter_events(lawsuit_id);
      CREATE INDEX IF NOT EXISTS idx_afe_unprocessed ON advbox_flowter_events(processed_ok)
        WHERE processed_ok IS NULL OR processed_ok = false;
    `);

    // ── ROUTE_ACCESS_LOG — telemetria de uso de rota pra auditoria de morto ──
    // Loga cada GET /api/* (não params, só path) pra descobrir quais
    // features Eduardo realmente usa vs quais estão lá só ocupando código.
    // Retenção 30 dias (limpeza no cron de discord-briefing ou manual).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS route_access_log (
        id          BIGSERIAL PRIMARY KEY,
        route       TEXT NOT NULL,
        user_id     INT,
        accessed_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ral_route_time ON route_access_log(route, accessed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ral_time ON route_access_log(accessed_at DESC);
    `);

    console.log('[DB] Schema verificado/criado com sucesso.');
  } catch (err) {
    console.error('[DB] Erro na migração:', err.message);
  }
}

module.exports = { pool, query, migrate };
