const { Pool } = require('pg');
const { config } = require('../config');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  max: config.db.poolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
  query_timeout: 15000,
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

      -- Tabela inss_conference_log removida do schema (feature removida em 2026-05-16).
      -- A tabela ainda existe em produção com histórico. Pra liberar espaço:
      --   DROP TABLE IF EXISTS inss_conference_log;

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

    // ── Índices adicionais (Week 3 — query patterns que surgiram dos fixes #8, #10, #11) ──
    // Todos `IF NOT EXISTS` — idempotente, seguro pra re-rodar. Cada um cobre
    // uma query nova que ficou sem índice próprio depois das melhorias da
    // semana 2. Sem isso, queries vão a full-table scan quando o histórico
    // crescer (poucas semanas pra Asaas e route_access_log).
    await pool.query(`
      -- "Mostre toda mutação no processo X" (audit trail de #10).
      -- Existing idx_aa_cooldown começa com action_type; queries sem filtrar
      -- por tipo não conseguem usar — precisam de um índice começando por
      -- target_lawsuit_id.
      CREATE INDEX IF NOT EXISTS idx_aa_lawsuit_time
        ON audit_actions(target_lawsuit_id, created_at DESC)
        WHERE target_lawsuit_id IS NOT NULL;

      -- "Quais rotas o usuário X mais usou" (usage analytics by user).
      -- Existing idx_ral_route_time é por rota, não por user.
      CREATE INDEX IF NOT EXISTS idx_ral_user_time
        ON route_access_log(user_id, accessed_at DESC)
        WHERE user_id IS NOT NULL;

      -- "Pagamentos ASAAS que falharam de sincronizar pro AdvBox" — pra
      -- conferência/recovery operacional. WHERE filtra o subconjunto pequeno.
      CREATE INDEX IF NOT EXISTS idx_aph_unsynced
        ON asaas_payment_history(created_at DESC)
        WHERE advbox_synced = FALSE;

      -- "Tendência semanal de categoria X" — controller snapshots filtrados
      -- por categoria. Existing UNIQUE(snapshot_date, categoria_id) atende
      -- queries time-first, esta atende category-first.
      CREATE INDEX IF NOT EXISTS idx_cs_cat_date
        ON controller_snapshots(categoria_id, snapshot_date DESC);
    `);

    console.log('[DB] Schema verificado/criado com sucesso.');
  } catch (err) {
    console.error('[DB] Erro na migração:', err.message);
  }
}

/**
 * Executa `fn` mantendo um advisory lock per-resource. Garante que duas
 * invocações concorrentes pra mesmo (category, resourceKey) serializem ao
 * invés de correrem.
 *
 * Implementação: pg_advisory_xact_lock(category, hashtext(resourceKey))
 * dentro de uma transação dedicada. xact_lock auto-libera em COMMIT/ROLLBACK
 * — sem risco de lock órfão se o callback der throw.
 *
 * IMPORTANTE: o lock fica retido durante TODA a execução de `fn`. Não use
 * pra trabalho que pode demorar minutos (ex: runCycle do auto-workflow) —
 * tudo bem pra webhook handlers que fazem ~10s de trabalho.
 *
 * Convenções de category (int32):
 *   - 902301: auto-workflow (formato single-int, não usa este helper)
 *   - 902400: Asaas webhook per-payment
 *   - 902401+: reservado pra futuras necessidades
 *
 * @param {object} opts
 * @param {number} opts.category    int32 — agrupador do tipo de lock
 * @param {string|number} opts.resourceKey  hash dele = chave fina
 * @param {string} [opts.timeout='10s']  lock_timeout (Postgres-style: '10s', '500ms')
 * @param {function} fn  async () => result
 */
async function withAdvisoryLock({ category, resourceKey, timeout = '10s' }, fn) {
  if (!Number.isInteger(category)) {
    throw new Error('[withAdvisoryLock] category must be an integer');
  }
  if (resourceKey == null || resourceKey === '') {
    throw new Error('[withAdvisoryLock] resourceKey is required');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // SET LOCAL só vale dentro da transação — reseta automaticamente no COMMIT.
    await client.query(`SET LOCAL lock_timeout = '${timeout}'`);
    await client.query(
      'SELECT pg_advisory_xact_lock($1, hashtext($2))',
      [category, String(resourceKey)]
    );
    try {
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    client.release();
  }
}

module.exports = { pool, query, migrate, withAdvisoryLock };
