import { Pool } from "pg";

const defaultDatabaseUrl = "postgres://postgres:postgres@127.0.0.1:5432/automakit";

export function getDatabaseUrl() {
  return process.env.DATABASE_URL ?? defaultDatabaseUrl;
}

export function createDatabasePool() {
  return new Pool({
    connectionString: getDatabaseUrl(),
  });
}

export async function ensureCoreSchema(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL,
      name TEXT NOT NULL,
      runtime_type TEXT NOT NULL,
      public_key TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      verified_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS auth_challenges (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      payload TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS agent_tokens (
      token_hash TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      proposer_agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      close_time TIMESTAMPTZ NOT NULL,
      resolution_criteria TEXT NOT NULL,
      resolution_spec JSONB NOT NULL DEFAULT '{}'::jsonb,
      source_of_truth_url TEXT NOT NULL,
      resolution_kind TEXT NOT NULL,
      resolution_metadata JSONB NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      origin TEXT NOT NULL,
      signal_source_id TEXT,
      signal_source_type TEXT,
      status TEXT NOT NULL,
      confidence_score DOUBLE PRECISION NOT NULL,
      observation_count INTEGER NOT NULL,
      autonomy_note TEXT NOT NULL,
      linked_market_id TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS markets (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL UNIQUE,
      event_id TEXT NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT,
      status TEXT NOT NULL,
      category TEXT NOT NULL,
      close_time TIMESTAMPTZ NOT NULL,
      resolution_spec JSONB NOT NULL DEFAULT '{}'::jsonb,
      resolution_source TEXT NOT NULL,
      resolution_kind TEXT NOT NULL,
      resolution_metadata JSONB NOT NULL,
      last_traded_price_yes DOUBLE PRECISION,
      volume_24h DOUBLE PRECISION NOT NULL,
      liquidity_score DOUBLE PRECISION NOT NULL,
      outcomes JSONB NOT NULL,
      rules TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resolution_cases (
      market_id TEXT PRIMARY KEY REFERENCES markets(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      draft_outcome TEXT,
      final_outcome TEXT,
      canonical_source_url TEXT,
      quorum_threshold INTEGER NOT NULL,
      last_updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resolution_evidence (
      id TEXT PRIMARY KEY,
      market_id TEXT NOT NULL REFERENCES resolution_cases(market_id) ON DELETE CASCADE,
      submitter_agent_id TEXT NOT NULL,
      evidence_type TEXT NOT NULL,
      derived_outcome TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_url TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      observation_payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (market_id, submitter_agent_id)
    );

    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      market_id TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
      collector_agent_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      parser_version TEXT NOT NULL DEFAULT 'resolution-runtime@1',
      observed_at TIMESTAMPTZ NOT NULL,
      observation_payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (market_id, collector_agent_id)
    );

    CREATE TABLE IF NOT EXISTS resolution_collection_jobs (
      id TEXT PRIMARY KEY,
      market_id TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
      collector_agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      next_attempt_at TIMESTAMPTZ NOT NULL,
      claimed_at TIMESTAMPTZ,
      claim_expires_at TIMESTAMPTZ,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (market_id, collector_agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_resolution_collection_jobs_claimable
      ON resolution_collection_jobs (collector_agent_id, status, next_attempt_at, claim_expires_at);

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      market_id TEXT NOT NULL REFERENCES markets(id) ON DELETE RESTRICT,
      client_order_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      side TEXT NOT NULL,
      outcome TEXT NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      size DOUBLE PRECISION NOT NULL,
      filled_size DOUBLE PRECISION NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      signed_at TIMESTAMPTZ NOT NULL,
      request_signature TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      canceled_at TIMESTAMPTZ,
      UNIQUE (agent_id, client_order_id)
    );

    CREATE TABLE IF NOT EXISTS fills (
      id TEXT PRIMARY KEY,
      market_id TEXT NOT NULL REFERENCES markets(id) ON DELETE RESTRICT,
      outcome TEXT NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      size DOUBLE PRECISION NOT NULL,
      buy_order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
      sell_order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
      buy_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
      sell_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
      executed_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_events (
      sequence_id BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      order_id TEXT,
      market_id TEXT NOT NULL REFERENCES markets(id) ON DELETE RESTRICT,
      agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT,
      side TEXT,
      outcome TEXT NOT NULL,
      price DOUBLE PRECISION,
      size DOUBLE PRECISION,
      buy_order_id TEXT,
      sell_order_id TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_order_events_market_sequence
      ON order_events (market_id, sequence_id);

    CREATE TABLE IF NOT EXISTS stream_events (
      sequence_id BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      channel TEXT NOT NULL,
      market_id TEXT,
      agent_id TEXT,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_stream_events_sequence
      ON stream_events (sequence_id);

    CREATE INDEX IF NOT EXISTS idx_stream_events_market_sequence
      ON stream_events (market_id, sequence_id);

    CREATE INDEX IF NOT EXISTS idx_stream_events_agent_sequence
      ON stream_events (agent_id, sequence_id);

    CREATE TABLE IF NOT EXISTS portfolio_accounts (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      cash_balance DOUBLE PRECISION NOT NULL,
      reserved_cash DOUBLE PRECISION NOT NULL,
      realized_pnl DOUBLE PRECISION NOT NULL,
      unsettled_pnl DOUBLE PRECISION NOT NULL,
      fees DOUBLE PRECISION NOT NULL,
      payouts DOUBLE PRECISION NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS portfolio_positions (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      market_id TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
      outcome TEXT NOT NULL,
      market_category TEXT NOT NULL,
      quantity DOUBLE PRECISION NOT NULL,
      reserved_quantity DOUBLE PRECISION NOT NULL,
      cost_basis_notional DOUBLE PRECISION NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (agent_id, market_id, outcome)
    );

    CREATE TABLE IF NOT EXISTS portfolio_ledger_entries (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      market_id TEXT REFERENCES markets(id) ON DELETE CASCADE,
      outcome TEXT,
      entry_type TEXT NOT NULL,
      cash_delta DOUBLE PRECISION NOT NULL,
      reserved_cash_delta DOUBLE PRECISION NOT NULL,
      position_delta DOUBLE PRECISION NOT NULL,
      reserved_position_delta DOUBLE PRECISION NOT NULL,
      cost_basis_notional_delta DOUBLE PRECISION NOT NULL,
      realized_pnl_delta DOUBLE PRECISION NOT NULL,
      unsettled_pnl_delta DOUBLE PRECISION NOT NULL,
      fees_delta DOUBLE PRECISION NOT NULL,
      payouts_delta DOUBLE PRECISION NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      metadata JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (reference_type, reference_id, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_portfolio_ledger_agent_created
      ON portfolio_ledger_entries (agent_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_risk_limits (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      max_order_size DOUBLE PRECISION NOT NULL,
      max_market_exposure DOUBLE PRECISION NOT NULL,
      max_category_exposure DOUBLE PRECISION NOT NULL,
      allow_shorting BOOLEAN NOT NULL,
      cancel_on_disconnect BOOLEAN NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS filled_size DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE proposals ADD COLUMN IF NOT EXISTS resolution_spec JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE markets ADD COLUMN IF NOT EXISTS resolution_spec JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE observations ADD COLUMN IF NOT EXISTS parser_version TEXT NOT NULL DEFAULT 'resolution-runtime@1';
  `);
}

export function toIsoTimestamp(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(String(value)).toISOString();
}

export function parseJsonField<T>(value: unknown): T {
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }

  return value as T;
}

export function toNumberOrNull(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}
