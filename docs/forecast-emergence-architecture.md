# Forecast-Emergence Architecture And Tranche Plan

## 1. Design Shift

Automakit should simulate **forecast emergence**, not social posting behavior.

Target behavior:

- hidden reality changes first,
- evidence leaks through uneven channels,
- heterogeneous agents form and challenge hypotheses,
- only some beliefs compile into listable markets,
- outcomes resolve and feed learning back into agent quality.

This keeps the product centered on prediction-object quality, not engagement dynamics.

## 2. Repo-Mapped Architecture (6 Layers)

```text
Layer 1: Latent World (hidden reality state)
  packages/world-sim (new latent world contracts)
  services/simulation-runtime-py (latent-step execution)

Layer 2: Evidence Emission (observable evidence with noise/latency)
  services/world-input (ingest + normalize -> world_signals)
  services/event-builder (cluster -> event_cases)
  packages/persistence (world_signals/event_cases/evidence tables)

Layer 3: Agent Ecology (role-bounded epistemic agents)
  services/world-model
  services/scenario-agent
  services/synthesis-agent
  packages/agent-llm

Layer 4: Belief Interaction (proposal/refine/challenge/split/merge)
  services/world-model + scenario-agent + synthesis-agent (typed actions)
  packages/world-sim (belief action contracts)
  packages/persistence (belief action/event log tables)

Layer 5: Market Compilation (belief -> candidate -> listable market)
  services/proposal-agent
  services/approval-agent
  services/proposal-pipeline
  services/market-service

Layer 6: Resolution + Learning (truth settlement + scoring feedback)
  services/resolution-collector
  services/resolution-service
  services/portfolio-service
  apps/observer-console (performance/cockpit read surface)
```

## 3. Core Object Model

First-class state objects:

- `WorldState` (latent snapshot per tick)
- `LatentEvent` (hidden or partially visible world change)
- `EvidenceItem` (emitted observation with source/channel metadata)
- `SourceChannel` (latency/reliability/distortion/revision profile)
- `AgentState` (epistemic profile + persistent internal state)
- `Hypothesis` (typed claim candidate)
- `BeliefCluster` (merged/refined hypothesis object)
- `MarketCandidate` (belief compiled for listing checks)
- `ResolutionContract` (`resolution_spec` + source-of-truth contract)
- `OutcomeRecord` (resolved truth + scoring feedback)

## 4. Concrete Tranche Plan (Strict Order)

Execution order is fixed:

1. Schema + contracts
2. Agent runtime behavior
3. Observer cockpit

No tranche starts before the previous gate passes.

---

## Tranche A: Schema First

Goal:

- make emergence state explicit and replayable before changing agent behavior.

### A1. Contract extensions

Files:

- `packages/world-sim/src/index.ts`
- `packages/sdk-types/src/index.ts`

Changes:

- Add `case_type` to hypothesis/belief contracts:
  - `now_case | forecast_case`
- Add `source_event_case_ids`, `event_window_start`, `event_window_end`.
- Add typed belief actions:
  - `propose_hypothesis`
  - `refine_hypothesis`
  - `split_hypothesis`
  - `merge_hypothesis`
  - `attach_evidence`
  - `challenge_hypothesis`
  - `flag_ambiguity`
  - `nominate_resolution_source`
  - `mark_unlistable`
  - `abstain`

### A2. Persistence schema

File:

- `packages/persistence/src/index.ts`

Add tables:

- `evidence_items`
- `source_channels`
- `belief_clusters`
- `belief_actions`
- `belief_lineage_events`
- `market_candidates`
- `agent_epistemic_profiles`
- `agent_epistemic_states`
- `agent_outcome_scores`

Required indexes:

- `(belief_cluster_id, created_at DESC)` for timelines
- `(agent_id, created_at DESC)` for scorecards
- `(status, updated_at DESC)` for candidate queues
- `(event_case_id, source_channel_id, observed_at DESC)` for evidence joins

### A3. Read-model views for cockpit

File:

- `packages/persistence/src/index.ts`

Add SQL views/materialized views:

- `belief_live_view`
- `belief_timeline_view`
- `agent_leaderboard_view`
- `belief_disagreement_view`

### A-Gate (must pass)

- typecheck passes for all changed packages/services
- migration boots clean on empty DB and existing DB
- `event_cases -> beliefs -> candidates` joins execute within target latency for observer reads

---

## Tranche B: Agent Runtime

Goal:

- implement bounded epistemic agent loops over `event_cases`, not raw social-like posting.

### B1. Orchestrator input pivot

File:

- `services/simulation-orchestrator/src/index.ts`

Changes:

- trigger runs from `event_cases` + supporting `world_signals`.
- dedupe key computed from event-case fingerprint + freshness/version.
- run payload carries:
  - selected `event_cases`
  - linked evidence IDs
  - role list + tick budget

### B2. World-model bounded agent loop

File:

- `services/world-model/src/index.ts`

Changes:

- per tick:
  1. observe assigned `event_cases`
  2. retrieve local `agent_epistemic_state`
  3. execute max 1-3 tool actions
  4. emit structured `belief_actions` + hypothesis updates
- classify outputs into:
  - `now_case` (currently unfolding)
  - `forecast_case` (1-7 day horizon)

### B3. Scenario and synthesis alignment

Files:

- `services/scenario-agent/src/index.ts`
- `services/synthesis-agent/src/index.ts`

Changes:

- preserve `case_type` and `source_event_case_ids`.
- emit disagreement metadata and conflict edges explicitly.
- write lineage events for split/merge/refine/challenge transitions.

### B4. Compilation boundary hardening

Files:

- `services/proposal-agent/src/index.ts`
- `services/proposal-pipeline/src/index.ts`

Changes:

- only `proposal-agent` can compile/publish from synthesized beliefs.
- upstream agents cannot call publish endpoints directly.
- enforce listability checks on compiled `market_candidates`:
  - resolvability
  - ambiguity threshold
  - source quality
  - deadline validity

### B-Gate (must pass)

- autonomous loop runs continuously with no manual calls
- beliefs are emitted as `now_case` or `forecast_case`
- end-to-end lineage exists from evidence -> belief actions -> synthesized belief -> candidate decision
- no direct market publish path from world/scenario/synthesis services

---

## Tranche C: Cockpit (Observer Product Layer)

Goal:

- make belief emergence legible and evaluable in one watch-only surface.

### C1. Observer read API surface

Files:

- `services/api-gateway/src/index.ts`
- `services/stream-service/src/index.ts`

Add endpoints:

- `GET /v1/observer/beliefs/live`
- `GET /v1/observer/beliefs/:beliefId`
- `GET /v1/observer/beliefs/:beliefId/timeline`
- `GET /v1/observer/agents/leaderboard`
- `GET /v1/observer/disagreement-map`
- `GET /v1/observer/resolutions/history`

Add stream events:

- `belief.update`
- `belief.timeline.update`
- `agent.score.update`

### C2. Observer-console pages

Files:

- `apps/observer-console/*`

Pages:

- live beliefs board
- belief detail with full “why changed” timeline
- disagreement map
- agent leaderboard
- resolution history

### C3. Scoring model

Files:

- `packages/world-sim/src/index.ts`
- `services/resolution-service/src/index.ts`
- `services/api-gateway/src/index.ts`

Metrics:

- hit rate
- Brier-like calibration score
- time-to-first-useful-hypothesis
- listable precision
- clean-resolution rate
- disagreement predictive value

### C-Gate (must pass)

- one-screen cockpit shows live beliefs + top agents + change traces
- each belief has an auditable chain:
  - source evidence
  - world/scenario/synthesis transitions
  - approval/publish decision
  - resolution outcome
- leaderboard updates automatically after resolutions

## 5. Non-Goals For This Plan

- exchange-grade matching/performance hardening
- margin/shorting expansion
- fully general open-ended agent tool autonomy

These can proceed in parallel tracks, but are not blockers for the forecast-emergence product loop.

## 6. Acceptance Definition

The architecture shift is complete when:

- the platform reliably produces and tracks `now_case` and `forecast_case` beliefs,
- belief evolution is inspectable and replayable from persisted events,
- humans can open observer-console and understand:
  - what changed,
  - why it changed,
  - which agents are actually good over time.
