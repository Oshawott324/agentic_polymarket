# World-Model And Proposal-Agent Implementation Spec

## 1. Goal

Add platform-owned world-input, world-model, and proposal-agent services so market generation no longer depends only on external structured `MarketSignal` feeds.

The system must be able to start from an empty runtime, poll canonical upstream sources automatically, generate typed hypotheses, convert eligible hypotheses into machine-resolvable market proposals, and publish markets through the existing proposal pipeline.

This layer is upstream of listing and strictly separate from settlement:

- world-model output may influence which markets exist,
- world-model output must never directly resolve a market.

## 2. Scope

This spec covers:

- `packages/world-sim`
- `services/world-input`
- `services/world-model`
- `services/proposal-agent`
- required persistence schema
- internal APIs between the new services and existing proposal-pipeline
- autonomous feed startup and steady-state polling
- live-test requirements

This spec does not require a full social simulator in the first tranche.

## 3. Operating Model

The world-generation loop is:

1. `world-input` polls configured external and internal sources.
2. `world-input` writes normalized `world_signals`.
3. `world-model` consumes fresh `world_signals` and emits `world_hypotheses`.
4. `proposal-agent` converts eligible `world_hypotheses` into typed market proposals.
5. `proposal-pipeline` validates, dedupes, scores, and publishes or suppresses.
6. `market-service` creates markets from published proposals.

This loop runs continuously without direct human intervention.

## 4. Design Constraints

- Start with deterministic enrichment, not freeform simulation.
- Prefer typed intermediate records over opaque prose.
- Keep settlement truth in `resolution-service` and canonical source adapters only.
- Use Postgres as the durable work log and state store.
- Treat the existing `proposal-pipeline` as the listing gate.
- Keep all new services restart-safe and idempotent.

## 5. New Packages And Services

### 5.1 `packages/world-sim`

Purpose:

- shared types
- validation helpers
- normalization helpers
- no network IO
- no database access

Initial exports:

- `WorldSignal`
- `WorldSignalSourceType`
- `WorldEntityRef`
- `WorldHypothesis`
- `WorldHypothesisStatus`
- `ProposalCandidate`
- `WorldInputCursor`
- `SourceAdapterKind`

Suggested first interfaces:

```ts
export type WorldSignalSourceType =
  | "economic_calendar"
  | "price_feed"
  | "filing"
  | "official_announcement"
  | "news"
  | "market_internal";

export type WorldEntityRef = {
  kind: "asset" | "institution" | "person" | "issuer" | "event";
  value: string;
};

export type WorldSignal = {
  id: string;
  source_type: WorldSignalSourceType;
  source_id: string;
  source_url: string;
  trust_tier: "official" | "exchange" | "curated" | "derived";
  fetched_at: string;
  effective_at?: string;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  entity_refs: WorldEntityRef[];
  dedupe_key: string;
};

export type WorldHypothesis = {
  id: string;
  source_signal_ids: string[];
  category: string;
  subject: string;
  predicate: string;
  target_time: string;
  confidence_score: number;
  reasoning_summary: string;
  machine_resolvable: boolean;
  suggested_resolution_kind?: string;
  suggested_resolution_source_url?: string;
  status: "new" | "proposed" | "suppressed";
  dedupe_key: string;
  created_at: string;
};

export type ProposalCandidate = {
  title: string;
  category: string;
  close_time: string;
  resolution_criteria: string;
  resolution_spec: Record<string, unknown>;
  dedupe_key: string;
  source_hypothesis_id: string;
};
```

### 5.2 `services/world-input`

Purpose:

- poll upstream sources on schedule
- normalize responses into `WorldSignal`
- write `world_signals`
- maintain polling cursors and backoff state

This service is the answer to the “how does the world auto-feed” question.

### 5.3 `services/world-model`

Purpose:

- consume fresh `world_signals`
- group related signals
- enrich entities, deadlines, thresholds, and event types
- emit typed `world_hypotheses`

This service should start as a typed enrichment engine, not a general LLM sandbox.

### 5.4 `services/proposal-agent`

Purpose:

- read eligible `world_hypotheses`
- convert them into machine-resolvable market drafts
- generate `resolution_criteria` and `resolution_spec`
- submit drafts to `proposal-pipeline`
- update hypothesis status to `proposed` or `suppressed`

## 6. Persistence Additions

Add these tables to [packages/persistence/src/index.ts](/Users/yifanjin/agentic_polymarket/packages/persistence/src/index.ts).

### 6.1 `world_signals`

```sql
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
```

Indexes:

- `(source_type, fetched_at DESC)`
- `(created_at DESC)`

### 6.2 `world_input_cursors`

```sql
CREATE TABLE IF NOT EXISTS world_input_cursors (
  source_key TEXT PRIMARY KEY,
  cursor_value TEXT,
  last_polled_at TIMESTAMPTZ,
  next_poll_at TIMESTAMPTZ NOT NULL,
  backoff_until TIMESTAMPTZ,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);
```

### 6.3 `world_hypotheses`

```sql
CREATE TABLE IF NOT EXISTS world_hypotheses (
  id TEXT PRIMARY KEY,
  source_signal_ids JSONB NOT NULL,
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  target_time TIMESTAMPTZ NOT NULL,
  confidence_score DOUBLE PRECISION NOT NULL,
  reasoning_summary TEXT NOT NULL,
  machine_resolvable BOOLEAN NOT NULL,
  suggested_resolution_kind TEXT,
  suggested_resolution_source_url TEXT,
  suggested_resolution_metadata JSONB,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  suppression_reason TEXT,
  linked_proposal_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
```

Indexes:

- `(status, created_at DESC)`
- `(category, target_time DESC)`

### 6.4 Optional later tables

Do not add these in the first tranche unless needed:

- `scenario_runs`
- `scenario_outputs`
- `world_entities`

The first pass should stay focused on typed signal enrichment.

## 7. Source Adapters For Auto-Feed

`world-input` should support a small adapter registry.

Initial adapters:

- `http_json_calendar`
- `http_json_price`
- `http_json_filing`
- `http_json_official_announcement`
- `market_internal`

Each adapter must define:

- source key
- poll cadence
- optional backfill window
- normalization function
- trust tier

Suggested env shape:

```env
WORLD_INPUT_SOURCES_JSON=[
  {
    "key": "fed-calendar",
    "adapter": "http_json_calendar",
    "url": "https://example.test/fed-calendar.json",
    "poll_interval_seconds": 300,
    "backfill_hours": 72,
    "trust_tier": "official"
  },
  {
    "key": "btc-price",
    "adapter": "http_json_price",
    "url": "https://example.test/btc-price.json",
    "poll_interval_seconds": 15,
    "backfill_hours": 24,
    "trust_tier": "exchange"
  }
]
```

## 8. Auto-Feed Lifecycle

### 8.1 Startup

On startup, `world-input` must:

1. load configured sources
2. initialize or load source cursors
3. perform immediate bootstrap polling
4. backfill recent history if the source supports it
5. store normalized `world_signals`

### 8.2 Steady-state polling

For each source:

- poll at configured cadence
- normalize items into typed signals
- dedupe by `dedupe_key`
- update cursor state
- apply exponential backoff on transient failures

### 8.3 Internal feedback

Later, `market_internal` can emit signals from:

- unusual spread changes
- repeated unresolved proposal themes
- large order-flow changes
- liquidity gaps

These are valid world-model inputs for belief generation but never for settlement.

## 9. World-Model Rules

The first version of `world-model` must not depend on a large freeform simulation loop.

It should perform:

- entity linking
- event classification
- deadline extraction
- threshold extraction
- domain classification
- source agreement scoring
- machine-resolvability checks

Examples:

- price signal -> `price_threshold` hypothesis
- Fed decision signal -> `rate_decision` hypothesis
- filing signal -> later `filing_detected` hypothesis once that resolution kind exists

World-model output must be a typed `world_hypothesis`, not a ready-to-list market.

## 10. Proposal-Agent Rules

The proposal-agent converts a `world_hypothesis` into a proposal only if:

- `machine_resolvable = true`
- `suggested_resolution_kind` is supported by [packages/sdk-types/src/resolution-spec.ts](/Users/yifanjin/agentic_polymarket/packages/sdk-types/src/resolution-spec.ts)
- a canonical source URL exists
- close time can be derived unambiguously
- title can be rendered as a clean binary question

If any of those fail, the proposal-agent must suppress the hypothesis and store a suppression reason.

Suggested deterministic mappings:

- `price_threshold`
  - title: `Will BTC close above $100,000 on June 30, 2026?`
  - resolution criteria: explicit source, evaluation time, threshold rule
- `rate_decision`
  - title: `Will the Federal Reserve cut rates at the June 17, 2026 meeting?`
  - resolution criteria: official release and cut/hold/hike rule

## 11. Internal APIs

### 11.1 `world-input`

Read/write directly to Postgres for `world_signals` and `world_input_cursors`.

Optional health endpoints:

- `GET /health`
- `GET /v1/internal/world-input/sources`

### 11.2 `world-model`

Suggested internal endpoints:

- `GET /health`
- `POST /v1/internal/world-model/run-once`
- `GET /v1/internal/world-hypotheses?status=new`

It may also run a loop with no external trigger in normal runtime.

### 11.3 `proposal-agent`

Suggested internal endpoints:

- `GET /health`
- `POST /v1/internal/proposal-agent/run-once`

Submission target:

- `POST /v1/market-proposals` on [services/proposal-pipeline/src/index.ts](/Users/yifanjin/agentic_polymarket/services/proposal-pipeline/src/index.ts)

Required request shape:

- `proposer_agent_id`
- `title`
- `category`
- `close_time`
- `resolution_criteria`
- `resolution_spec`
- `dedupe_key`
- `origin = "automation"`
- `signal_source_id = world_hypothesis.id`
- `signal_source_type = "agent"`

## 12. Service Ownership Boundaries

- `world-input` owns source polling and normalization.
- `world-model` owns hypothesis generation.
- `proposal-agent` owns draft generation from hypotheses.
- `proposal-pipeline` owns listing admission.
- `resolution-service` owns settlement truth.

No service in this new layer may:

- directly create a market in `market-service`
- directly resolve a market
- treat simulated beliefs as settlement evidence

## 13. Implementation Order

### Step 1

Add `packages/world-sim` with types and validators.

Acceptance:

- package builds
- types are imported by new services

### Step 2

Add persistence schema for `world_signals`, `world_input_cursors`, and `world_hypotheses`.

Acceptance:

- schema migrates cleanly
- restart-safe inserts and dedupe work

### Step 3

Add `services/world-input` with one adapter class:

- `http_json_calendar`

Acceptance:

- service boots
- polls configured source
- stores normalized signals
- backoff and dedupe work

### Step 4

Add `services/world-model` with deterministic enrichment for:

- `price_threshold`
- `rate_decision`

Acceptance:

- new signals produce hypotheses
- invalid signals are ignored or suppressed

### Step 5

Add `services/proposal-agent`.

Acceptance:

- eligible hypotheses produce proposals
- invalid hypotheses are suppressed with explicit reason
- proposals are submitted idempotently

### Step 6

Connect the new services into the default dev stack and keep the old `market-creator` as fallback during rollout.

Acceptance:

- both paths can coexist
- fallback can be disabled later

## 14. Live Test Plan

Add a new end-to-end test, for example:

- `scripts/live-test-world-model.ts`

The test must:

1. boot disposable Postgres-backed services
2. start a temporary feed server with:
   - one price source
   - one rate-decision source
3. start `world-input`
4. start `world-model`
5. start `proposal-agent`
6. start existing `proposal-pipeline` and `market-service`
7. verify:
   - `world_signals` inserted
   - `world_hypotheses` created
   - proposal submitted automatically
   - market published automatically
   - no direct test call to create the market

This test should prove the platform can start from an empty runtime and generate markets from autonomous polling.

## 15. Deferred Work

Defer these until the first typed enrichment path is stable:

- full `scenario-simulator` runtime
- richer world entity graph
- LLM-generated long-horizon social simulations
- third-party simulation agents
- proposal generation from fully synthetic scenario trajectories

## 16. Success Criteria

This tranche is complete when:

- the world starts automatically from configured source polling,
- new `world_signals` produce `world_hypotheses`,
- eligible hypotheses generate market proposals automatically,
- the existing proposal-pipeline remains the listing gate,
- at least one live test proves end-to-end autonomous market generation without direct proposal injection from the test harness.
