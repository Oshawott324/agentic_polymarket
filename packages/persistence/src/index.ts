import { Pool } from "pg";

const defaultDatabaseUrl = "postgres://postgres:postgres@127.0.0.1:5432/automakit";
const schemaLockKey = 4_289_101;

export function getDatabaseUrl() {
  return process.env.DATABASE_URL ?? defaultDatabaseUrl;
}

export function createDatabasePool() {
  const pool = new Pool({
    connectionString: getDatabaseUrl(),
    max: Math.max(1, Number(process.env.DATABASE_POOL_MAX ?? "1")),
  });

  const originalQuery = pool.query.bind(pool);
  function inlineSqlValue(value: unknown): string {
    if (value === null || value === undefined) {
      return "NULL";
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? String(value) : "NULL";
    }
    if (typeof value === "boolean") {
      return value ? "TRUE" : "FALSE";
    }
    if (value instanceof Date) {
      return `'${value.toISOString().replace(/'/g, "''")}'`;
    }
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return "ARRAY[]::text[]";
      }
      if (value.every((entry) => entry === null || entry === undefined || typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" || entry instanceof Date || typeof entry === "bigint")) {
        return `ARRAY[${value.map((entry) => inlineSqlValue(entry)).join(", ")}]`;
      }
      return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
    }

    const serialized =
      typeof value === "string" ? value : JSON.stringify(value);
    return `'${String(serialized).replace(/'/g, "''")}'`;
  }

  function inlineQuery(text: string, values: unknown[] | undefined): string {
    if (!values || values.length === 0) {
      return text;
    }

    return text.replace(/\$(\d+)/g, (match, index) => {
      const value = values[Number(index) - 1];
      return value === undefined ? match : inlineSqlValue(value);
    });
  }

  pool.query = ((...args: unknown[]) => {
    if (typeof args[0] === "string") {
      const [text, values, callback] = args as [
        string,
        unknown[] | undefined,
        ((err: Error | null, result: unknown) => void) | undefined,
      ];
      const sql = inlineQuery(text, values);
      if (typeof callback === "function") {
        return originalQuery(sql, callback);
      }
      return originalQuery(sql);
    }

    const [config, callback] = args as [
      Record<string, unknown>,
      ((err: Error | null, result: unknown) => void) | undefined,
    ];
    if (config && typeof config === "object") {
      const inlineConfig = config as any;
      const sql = inlineQuery(String(inlineConfig.text ?? ""), Array.isArray(inlineConfig.values) ? inlineConfig.values : undefined);
      if (typeof callback === "function") {
        return originalQuery(sql, callback as any);
      }
      return originalQuery(sql);
    }

    return originalQuery(config as any, callback as any);
  }) as typeof pool.query;

  return pool;
}

export async function ensureCoreSchema(pool: Pool) {
  await pool.query("SELECT pg_advisory_lock($1)", [schemaLockKey]);
  try {
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
      semantic_dedupe_key TEXT,
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

    CREATE TABLE IF NOT EXISTS world_signals (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      trust_tier TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload JSONB NOT NULL,
      entity_refs JSONB NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      fetched_at TIMESTAMPTZ NOT NULL,
      effective_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_world_signals_source_type_fetched
      ON world_signals (source_type, fetched_at DESC);

    CREATE INDEX IF NOT EXISTS idx_world_signals_created
      ON world_signals (created_at DESC);

    CREATE TABLE IF NOT EXISTS event_cases (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      primary_entity TEXT NOT NULL,
      source_types JSONB NOT NULL,
      source_adapters JSONB NOT NULL,
      signal_count INTEGER NOT NULL,
      first_signal_at TIMESTAMPTZ NOT NULL,
      last_signal_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_event_cases_status_last_signal
      ON event_cases (status, last_signal_at DESC);

    CREATE TABLE IF NOT EXISTS event_case_signals (
      event_case_id TEXT NOT NULL REFERENCES event_cases(id) ON DELETE CASCADE,
      signal_id TEXT NOT NULL REFERENCES world_signals(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      added_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (event_case_id, signal_id)
    );

    CREATE INDEX IF NOT EXISTS idx_event_case_signals_signal
      ON event_case_signals (signal_id);

    CREATE TABLE IF NOT EXISTS world_input_sources (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      adapter TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      enabled BOOLEAN NOT NULL,
      poll_interval_seconds INTEGER NOT NULL,
      source_url TEXT,
      trust_tier TEXT NOT NULL,
      config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      auth_secret_ref TEXT,
      cursor_value TEXT,
      last_polled_at TIMESTAMPTZ,
      next_poll_at TIMESTAMPTZ NOT NULL,
      backoff_until TIMESTAMPTZ,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_world_input_sources_due
      ON world_input_sources (enabled, status, next_poll_at, backoff_until);

    CREATE TABLE IF NOT EXISTS world_input_runs (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES world_input_sources(id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ,
      status TEXT NOT NULL,
      fetched_count INTEGER NOT NULL DEFAULT 0,
      accepted_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_world_input_runs_source_started
      ON world_input_runs (source_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS simulation_runs (
      id TEXT PRIMARY KEY,
      run_type TEXT NOT NULL,
      trigger_signal_ids JSONB NOT NULL,
      trigger_event_case_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      trigger_dedupe_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      failure_reason TEXT,
      last_updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_simulation_runs_status_started
      ON simulation_runs (status, started_at DESC);

    CREATE TABLE IF NOT EXISTS simulation_runtime_runs (
      run_id TEXT PRIMARY KEY REFERENCES simulation_runs(id) ON DELETE CASCADE,
      backend TEXT NOT NULL,
      contract_version TEXT NOT NULL,
      runtime_run_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      last_error TEXT,
      last_checked_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_simulation_runtime_runs_status_checked
      ON simulation_runtime_runs (status, last_checked_at ASC);

    CREATE TABLE IF NOT EXISTS world_state_proposals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES simulation_runs(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      source_signal_ids JSONB NOT NULL,
      as_of TIMESTAMPTZ NOT NULL,
      entities JSONB NOT NULL,
      active_events JSONB NOT NULL,
      factors JSONB NOT NULL,
      regime_labels JSONB NOT NULL,
      reasoning_summary TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (run_id, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_world_state_proposals_run
      ON world_state_proposals (run_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS scenario_path_proposals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES simulation_runs(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      label TEXT NOT NULL,
      probability DOUBLE PRECISION NOT NULL,
      narrative TEXT NOT NULL,
      factor_deltas JSONB NOT NULL,
      path_events JSONB NOT NULL,
      path_hypotheses JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (run_id, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_scenario_path_proposals_run
      ON scenario_path_proposals (run_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS belief_hypothesis_proposals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES simulation_runs(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      parent_ids JSONB NOT NULL,
      hypothesis_kind TEXT NOT NULL,
      category TEXT NOT NULL,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      target_time TIMESTAMPTZ NOT NULL,
      confidence_score DOUBLE PRECISION NOT NULL,
      reasoning_summary TEXT NOT NULL,
      source_signal_ids JSONB NOT NULL,
      machine_resolvable BOOLEAN NOT NULL,
      suggested_resolution_spec JSONB,
      event_case_id TEXT,
      case_family_key TEXT,
      belief_role TEXT,
      publishability_score DOUBLE PRECISION,
      dedupe_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (run_id, agent_id, dedupe_key)
    );

    CREATE INDEX IF NOT EXISTS idx_belief_hypothesis_proposals_run
      ON belief_hypothesis_proposals (run_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS synthesized_beliefs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES simulation_runs(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      belief_dedupe_key TEXT NOT NULL,
      parent_hypothesis_ids JSONB NOT NULL,
      agreement_score DOUBLE PRECISION NOT NULL,
      disagreement_score DOUBLE PRECISION NOT NULL,
      confidence_score DOUBLE PRECISION NOT NULL,
      conflict_notes TEXT,
      hypothesis JSONB NOT NULL,
      status TEXT NOT NULL,
      suppression_reason TEXT,
      linked_proposal_id TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (run_id, agent_id, belief_dedupe_key)
    );

    CREATE INDEX IF NOT EXISTS idx_synthesized_beliefs_status_created
      ON synthesized_beliefs (status, created_at DESC);

    CREATE TABLE IF NOT EXISTS listing_approval_cases (
      id TEXT PRIMARY KEY,
      belief_id TEXT NOT NULL UNIQUE REFERENCES synthesized_beliefs(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES simulation_runs(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      quorum_required INTEGER NOT NULL,
      min_approvals INTEGER NOT NULL,
      approve_count INTEGER NOT NULL DEFAULT 0,
      reject_count INTEGER NOT NULL DEFAULT 0,
      quarantine_count INTEGER NOT NULL DEFAULT 0,
      risk_veto BOOLEAN NOT NULL DEFAULT FALSE,
      linked_proposal_id TEXT,
      last_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_listing_approval_cases_pending
      ON listing_approval_cases (status, updated_at DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS listing_approval_votes (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES listing_approval_cases(id) ON DELETE CASCADE,
      belief_id TEXT NOT NULL REFERENCES synthesized_beliefs(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES simulation_runs(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      resolvability_score DOUBLE PRECISION NOT NULL,
      ambiguity_score DOUBLE PRECISION NOT NULL,
      manipulation_risk_score DOUBLE PRECISION NOT NULL,
      reasons JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (case_id, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_listing_approval_votes_case_created
      ON listing_approval_votes (case_id, created_at DESC);

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
    ALTER TABLE proposals ADD COLUMN IF NOT EXISTS semantic_dedupe_key TEXT;
    ALTER TABLE markets ADD COLUMN IF NOT EXISTS resolution_spec JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE observations ADD COLUMN IF NOT EXISTS parser_version TEXT NOT NULL DEFAULT 'resolution-runtime@1';
    ALTER TABLE simulation_runs ADD COLUMN IF NOT EXISTS trigger_dedupe_key TEXT;
    ALTER TABLE simulation_runs ADD COLUMN IF NOT EXISTS last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE simulation_runs ADD COLUMN IF NOT EXISTS trigger_event_case_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE scenario_path_proposals ADD COLUMN IF NOT EXISTS path_hypotheses JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE synthesized_beliefs ADD COLUMN IF NOT EXISTS belief_dedupe_key TEXT;
    ALTER TABLE belief_hypothesis_proposals ADD COLUMN IF NOT EXISTS event_case_id TEXT;
    ALTER TABLE belief_hypothesis_proposals ADD COLUMN IF NOT EXISTS case_family_key TEXT;
    ALTER TABLE belief_hypothesis_proposals ADD COLUMN IF NOT EXISTS belief_role TEXT;
    ALTER TABLE belief_hypothesis_proposals ADD COLUMN IF NOT EXISTS publishability_score DOUBLE PRECISION;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_semantic_dedupe_key
      ON proposals (semantic_dedupe_key)
      WHERE semantic_dedupe_key IS NOT NULL;
    `);
  } finally {
    await pool.query("SELECT pg_advisory_unlock($1)", [schemaLockKey]).catch(() => undefined);
  }
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
