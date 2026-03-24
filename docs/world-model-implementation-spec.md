# Agent Simulation Fabric Spec

## 1. Goal

Replace the current rule-based single-path `world-model` implementation with an agent-simulated upstream layer.

The target system should:

- let platform-owned agents interpret the world rather than encode the belief logic in deterministic platform code,
- let platform-owned agents generate multiple future paths rather than one flat forecast,
- keep the platform deterministic only at the boundary contracts,
- preserve strict separation between simulated beliefs and settlement truth.

The new upstream loop should be built around:

- `simulation-orchestrator`
- `simulation runtime boundary` (TypeScript and/or Python CAMEL/Oasis workers)
- `world-model agents`
- `scenario agents`
- `synthesis agents`
- `approval agents`
- `proposal agents`
- deterministic boundary contracts only

## 2. Core Principle

Automakit should not implement the belief layer as a hardcoded engine.

Instead:

- agents simulate the world,
- the platform enforces schemas, permissions, persistence, and admission rules,
- canonical sources settle truth.

So the platform is not the simulator. It is the runtime, contract layer, and market gateway for upstream simulation agents.

## 3. Deterministic Boundary Contracts Only

The platform should be deterministic only where trust and reproducibility require it.

These parts should remain deterministic:

- signal schema validation
- world-state and scenario artifact schemas
- storage format
- agent role permissions
- proposal dedupe and overlap checks
- machine-resolvability checks
- publication policy
- typed `resolution_spec` validation
- settlement from canonical sources
- payout logic

These parts should be agent-driven rather than hardcoded:

- world interpretation
- causal reasoning
- regime inference
- confidence formation
- multi-path scenario generation
- synthesis of competing hypotheses
- proposal drafting

## 4. Target Operating Model

The upgraded upstream loop should be:

1. `world-input` polls configured upstream sources (including social feeds) and writes `world_signals`.
2. `simulation-orchestrator` selects which simulation tasks to run.
3. `simulation-orchestrator` dispatches run payloads to simulation workers (TypeScript runtime today, Python runtime boundary next).
4. `world-model agents` interpret fresh signals and emit proposed `world_state` updates and direct hypotheses.
5. `scenario agents` consume current world state and generate several future paths.
6. `synthesis agents` merge direct and scenario outputs into typed `belief_hypotheses`.
7. `approval agents` score resolvability and manipulation risk; only quorum-approved beliefs continue.
8. `proposal agents` convert approved hypotheses into candidate markets.
9. `proposal-pipeline` validates, dedupes, scores, and publishes or suppresses.

Settlement remains downstream and separate:

8. `resolution-collector` fetches canonical sources.
9. `resolution-service` resolves only from verified observations plus typed rules.

## 5. Service Roles

### 5.1 `services/simulation-orchestrator`

This should be the control plane for the belief layer.

Responsibilities:

- watch new `world_signals`
- schedule simulation tasks
- decide which agent classes to invoke
- assign run ids and work batches
- manage retries, timeouts, and stale work
- collect outputs from world-model, scenario, and synthesis agents
- move tasks through deterministic state transitions

This service should not decide beliefs. It should coordinate agents that do.

### 5.1A `services/simulation-runtime-py`

Responsibilities:

- Execute CAMEL/Oasis-compatible simulation workers under versioned contracts.
- Accept `SimulationRunRequest` payloads and return typed world-model/scenario artifacts.
- Keep prompting and tool wiring in the simulation runtime while leaving deterministic validation to platform services.

This service is a runtime boundary, not a source of truth.

### 5.2 `world-model agents`

Responsibilities:

- interpret newly ingested signals,
- propose updates to `world_state`,
- emit direct hypotheses about likely outcomes,
- attach reasoning summaries and evidence references,
- optionally emit regime labels as agent output.

These agents are allowed to disagree. The platform should store several outputs rather than assume one authoritative answer.

### 5.3 `scenario agents`

Responsibilities:

- consume current world context,
- generate several plausible future paths,
- attach path narratives and path probabilities,
- emit path-scoped hypotheses.

These agents should not be treated as truth authorities. They are producers of possible futures only.

### 5.4 `synthesis agents`

Responsibilities:

- merge outputs from several world-model and scenario agents,
- detect agreement and divergence,
- produce a smaller set of typed `belief_hypotheses`,
- emit confidence reasoning and conflict notes,
- mark hypotheses as too ambiguous when agreement is too weak.

This layer lets the system benefit from multiple agents without forcing the platform itself to “think.”

### 5.5 `approval agents`

Responsibilities:

- consume synthesized hypotheses,
- evaluate resolvability completeness and source quality,
- score manipulation risk and ambiguity,
- vote `approve` or `suppress` with structured reasons.

Only quorum-approved hypotheses may proceed to proposal drafting.

### 5.6 `proposal agents`

Responsibilities:

- read synthesized hypotheses,
- draft market titles and typed `resolution_spec`,
- submit only machine-resolvable proposals,
- suppress hypotheses that cannot become safe markets.

Proposal agents remain upstream of listing. They do not publish directly.

## 6. Shared Contracts In `packages/world-sim`

The shared package should define contracts and validators, not belief logic.

### 6.1 Signal contract

```ts
export type WorldSignal = {
  id: string;
  source_type: WorldSignalSourceType;
  source_adapter: string;
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
```

### 6.2 World-state proposal contract

```ts
export type WorldStateProposal = {
  id: string;
  run_id: string;
  agent_id: string;
  source_signal_ids: string[];
  as_of: string;
  entities: WorldEntityState[];
  active_events: ActiveWorldEvent[];
  factors: WorldFactorState[];
  regime_labels: string[];
  reasoning_summary: string;
  created_at: string;
};
```

### 6.3 Scenario-path contract

```ts
export type ScenarioPathProposal = {
  id: string;
  run_id: string;
  agent_id: string;
  label: "base" | "bull" | "bear" | "stress" | string;
  probability: number;
  narrative: string;
  factor_deltas: Record<string, unknown>;
  path_events: ScenarioEvent[];
  created_at: string;
};
```

### 6.4 Hypothesis contract

```ts
export type BeliefHypothesisProposal = {
  id: string;
  run_id: string;
  agent_id: string;
  parent_ids: string[];
  hypothesis_kind:
    | "price_threshold"
    | "rate_decision"
    | "filing_detected"
    | "game_result";
  category: string;
  subject: string;
  predicate: string;
  target_time: string;
  confidence_score: number;
  reasoning_summary: string;
  source_signal_ids: string[];
  machine_resolvable: boolean;
  suggested_resolution_spec?: Record<string, unknown>;
  created_at: string;
};
```

### 6.5 Synthesis contract

```ts
export type SynthesizedBelief = {
  id: string;
  run_id: string;
  agent_id: string;
  parent_hypothesis_ids: string[];
  agreement_score: number;
  disagreement_score: number;
  confidence_score: number;
  conflict_notes?: string;
  hypothesis: BeliefHypothesisProposal;
  status: "new" | "ambiguous" | "proposed" | "suppressed";
  created_at: string;
};
```

### 6.6 Approval decision contract

```ts
export type ApprovalDecision = {
  id: string;
  run_id: string;
  belief_id: string;
  agent_id: string;
  decision: "approve" | "suppress";
  score: number;
  reasons: string[];
  created_at: string;
};
```

These contracts should be validated structurally by the platform. The contents are still agent-generated.

## 7. Persistence Model

The persistence layer now uses an explicit multi-agent run model.

### 7.1 Keep

- `world_signals`
- `world_input_cursors`

### 7.2 Add

```sql
CREATE TABLE IF NOT EXISTS simulation_runs (
  id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL,
  trigger_signal_ids JSONB NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  failure_reason TEXT
);

CREATE TABLE IF NOT EXISTS world_state_proposals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  source_signal_ids JSONB NOT NULL,
  as_of TIMESTAMPTZ NOT NULL,
  entities JSONB NOT NULL,
  active_events JSONB NOT NULL,
  factors JSONB NOT NULL,
  regime_labels JSONB NOT NULL,
  reasoning_summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS scenario_path_proposals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  label TEXT NOT NULL,
  probability DOUBLE PRECISION NOT NULL,
  narrative TEXT NOT NULL,
  factor_deltas JSONB NOT NULL,
  path_events JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS belief_hypothesis_proposals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
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
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS synthesized_beliefs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
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
  updated_at TIMESTAMPTZ NOT NULL
);
```

### 7.3 Removed Legacy Path

The legacy `world_hypotheses` table and the old single-path enrichment contract are no longer part of the active design. Proposal generation now reads only from `synthesized_beliefs`.

## 8. Orchestrator Workflow

`simulation-orchestrator` should run deterministic workflow transitions over non-deterministic agent work.

### 8.1 Run lifecycle

1. detect fresh signals or state changes
2. create `simulation_run`
3. dispatch tasks to `world-model agents`
4. wait for minimum required outputs
5. dispatch tasks to `scenario agents`
6. dispatch tasks to `synthesis agents`
7. dispatch tasks to `approval agents`
8. store final `synthesized_beliefs` and `approval_decisions`
9. hand quorum-approved beliefs to `proposal-agent`

### 8.2 Deterministic orchestration state

Only the workflow transitions should be platform-controlled:

- `pending`
- `dispatched`
- `collecting_outputs`
- `synthesizing`
- `approval`
- `ready_for_proposal`
- `failed`

## 9. Proposal Pipeline Boundary

`proposal-pipeline` should remain a deterministic admission controller.

It should validate:

- schema correctness
- duplicate or overlap risk
- machine-resolvability
- required `resolution_spec`
- confidence and agreement thresholds
- market-count limits by domain

It should not decide whether a hypothesis is “true.” That remains part of the upstream agent simulation layer.

## 10. Required Agent Roles

Platform-owned upstream roles should be explicit:

- `world_model`
- `scenario`
- `synthesis`
- `approval`
- `proposal`

Each should have:

- a stable `agent_id`
- capability declaration
- role-bound permissions
- signed outputs

Third-party agents should still default to trading roles, not simulation roles.

## 11. Live-Test Requirements

This design is not implemented until a live test proves:

1. `world-input` polls real configured sources.
2. `simulation-orchestrator` creates a run automatically.
3. at least two `world-model agents` submit state or direct hypotheses.
4. at least two `scenario agents` submit future paths.
5. at least one `synthesis agent` emits `synthesized_beliefs`.
6. at least one `approval agent` emits a structured approval decision.
7. `proposal-agent` publishes at least one market from quorum-approved synthesized output.
8. the market still resolves only through canonical sources and `resolution-service`.

## 12. Guardrails

- Simulated beliefs must never be resolution evidence.
- Scenario output must never bypass `proposal-pipeline`.
- The platform should validate shape and permissions, not hardcode belief logic.
- Conflicting agent outputs should be stored, not hidden.
- The system should prefer ambiguity over fake certainty.

## 13. Implementation Status

Implemented:

1. `packages/world-sim` defines the agent-output contracts and validators.
2. The run-based persistence tables are part of the core schema.
3. `services/simulation-orchestrator` coordinates run state transitions.
4. `services/world-model` operates as a world-model agent runtime surface.
5. `services/scenario-agent` and `services/synthesis-agent` emit scenario paths and synthesized beliefs.
6. `services/proposal-agent` reads `synthesized_beliefs`.
7. The live test proves full orchestrated agent simulation before proposal publication and downstream autonomous resolution.
8. The deprecated single-path enrichment path and `world_hypotheses` persistence path have been removed from the active runtime design.
9. `world-model`, `scenario-agent`, and `synthesis-agent` run in LLM mode by default using OpenAI-compatible settings.
10. deterministic contract validation remains in shared TypeScript packages; simulation runtime language can vary.
11. `@automakit/sim-runtime-contracts` defines versioned runtime-agnostic schemas for request, status, and result payloads.
12. `simulation-orchestrator` now uses a runtime client interface (`submitRun`, `getRunStatus`, `getRunResult`) and a backend registry (`SIMULATION_RUNTIME_BACKEND`).
13. `services/simulation-runtime-py` implements `/v1/runtime/runs`, `/v1/runtime/runs/{id}`, and `/v1/runtime/runs/{id}/result` and returns typed world/scenario/synthesis outputs without writing market tables directly.

Remaining focus:

1. broader source-adapter coverage including social ingestion,
2. dedicated approval-agent quorum stage before proposal publication,
3. platform-owned liquidity bootstrap,
4. further exchange hardening beyond replay-based recovery.
