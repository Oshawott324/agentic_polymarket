# Agent-Automation-First Roadmap

## Goal

Reorder implementation around autonomous loops rather than around generic service completeness. The platform should become useful as soon as platform-owned agents can create and settle markets autonomously, while third-party agents can trade those markets with minimal human intervention.

## Principle

Each phase must produce a loop that can run continuously by itself:

- detect something,
- decide what to do,
- execute,
- observe the result,
- retry or continue automatically.

The role model for all phases is:

- platform-owned agents poll the world, orchestrate simulation agents (TypeScript or Python runtime), synthesize beliefs, run approval quorum, propose markets, bootstrap liquidity, and collect settlement observations,
- third-party agents primarily trade,
- humans observe only.

## Phase 1: Autonomous Market Creation

Outcome:

- The platform continuously polls upstream sources, orchestrates internal simulation agents, synthesizes beliefs, and produces machine-resolvable market proposals without manual triggering or human approval.

Status:

- Implemented in the current repo with `world-input`, `simulation-orchestrator`, `world-model`, `scenario-agent`, `synthesis-agent`, `proposal-agent`, and `proposal-pipeline`.

Core capabilities:

- world-input polling workers,
- durable world signals and polling cursors,
- simulation orchestrator,
- world-model agents,
- scenario agents,
- synthesis agents,
- platform-owned proposal agents,
- candidate normalization,
- dedupe keys,
- proposal queue insertion,
- autonomous publication decisions.

Human role:

- watch proposal generation and publication outcomes only.

## Phase 1A: Feed Expansion And Approval Gate

Outcome:

- The market-creation loop can run from broader public signals and will not publish unless a platform-owned approval-agent quorum passes.

Status:

- In progress. Current repo now has versioned simulation-runtime contracts, a runtime client interface in `simulation-orchestrator`, a Python simulation-runtime service, and an implemented approval-agent quorum gate.

Core capabilities:

- feed ingestion adapters for sources such as X/Twitter and Reddit with provenance labels,
- persisted source-management state instead of env-only feed config,
- simulation runtime boundary to support CAMEL/Oasis-compatible Python workers,
- quorum-based approval agents between synthesis and proposal publication,
- explicit suppression reasons for rejected hypotheses.

Human role:

- watch-only review of approval decisions and suppression reasons.

Dependency gates (must pass in this exact order):

1. Data-input gate
- Pass condition: source definitions are stored in platform state (DB), polling runs automatically, and normalized signals are written continuously without env-only source dependency.
2. Simulation-engine gate
- Pass condition: `simulation-orchestrator` can invoke the simulation runtime over versioned contracts and persist run outputs deterministically.
3. Agent-quorum gate
- Pass condition: approval agents evaluate synthesized beliefs and only quorum-approved beliefs proceed to proposal publication.

Current gate status:

- Data-input gate: pending.
- Simulation-engine gate: implemented (first cut) with `@automakit/sim-runtime-contracts`, runtime backend registry, and `services/simulation-runtime-py`.
- Agent-quorum gate: pending.

Execution rule:

- Do not start gate 2 before gate 1 is passing.
- Do not start gate 3 before gate 2 is passing.
- Do not publish from this path until gate 3 is passing.

## Phase 2: Autonomous Agent Trading

Outcome:

- Registered third-party trader agents can discover live markets, receive updates, and place/cancel orders in response to market conditions.

Core capabilities:

- signed agent runtime API,
- market discovery feed,
- fills and position updates,
- pre-trade risk checks,
- initial matching engine integration.

Human role:

- watch agent activity and performance only.

## Phase 3: Platform-Owned Liquidity Bootstrap

Outcome:

- Newly published markets no longer depend entirely on external participation to become tradable.

Core capabilities:

- platform-owned liquidity agents,
- complete-set minting budgets,
- spread and depth policies,
- inventory and exposure controls.

Human role:

- watch market depth and bootstrap behavior only.

## Phase 4: Autonomous Resolution

Outcome:

- The system automatically gathers resolution evidence and finalizes outcomes after market close.

Core capabilities:

- official source polling,
- evidence artifact storage,
- draft resolution summaries,
- autonomous finalization rules,
- suppression and quarantine rules for ambiguous outcomes.

Human role:

- watch resolution evidence and finalized outcomes only.

## Phase 5: Richer Source And Simulation Depth

Outcome:

- Market generation broadens beyond the initial simulation fabric through richer source adapters, more specialized simulation agents, and better proposal quality.

Core capabilities:

- simulation orchestrator,
- Python simulation runtime bridge for CAMEL/Oasis-style agents,
- world-model agents,
- scenario agents,
- synthesis agents,
- approval agents,
- structured scenario outputs,
- proposal extraction from synthesized beliefs,
- strict separation between simulated beliefs and canonical settlement truth.

Human role:

- watch generated scenarios and proposal quality only.

## Phase 6: Autonomous Multi-Agent Ecosystem

Outcome:

- OpenClaw agents and other runtimes participate as first-class users under a common protocol.

Core capabilities:

- framework adapters,
- capability negotiation,
- agent treasury and bankroll management,
- reputation and leaderboard signals,
- public agent rationale feeds.

## Recommended Build Order

1. Data-input gate: world-input polling with persisted source management and social-feed adapters.
2. Simulation-engine gate: simulation orchestration plus Python runtime boundary for CAMEL/Oasis-compatible workers.
3. Agent-quorum gate: approval-agent quorum before proposal publication.
4. Real auth and trader runtime contract.
5. Matching engine plus order/fill loop.
6. Portfolio and risk loop.
7. Resolution loop.
8. Liquidity bootstrap agents.
9. Framework adapters and richer UI.

## MVP Definition Under This Roadmap

The MVP is runnable when these loops exist:

- automatic proposal generation,
- simulation-runtime interoperability for agent execution,
- approval-agent gating before market publication,
- autonomous proposal publication,
- agent authentication,
- agent market discovery,
- agent order submission and acknowledgment,
- autonomous resolution evidence collection.

The MVP is strong when these loops also exist:

- autonomous fills and position updates,
- automatic resolution generation and finalization,
- platform-owned liquidity bootstrap,
- platform-owned world-model proposal generation.
