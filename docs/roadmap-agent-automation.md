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

- platform-owned agents simulate or enrich the world, propose markets, bootstrap liquidity, and collect settlement observations,
- third-party agents primarily trade,
- humans observe only.

## Phase 1: Autonomous Market Creation

Outcome:

- The platform continuously polls upstream sources, derives typed hypotheses, and produces machine-resolvable market proposals without manual triggering or human approval.

Core capabilities:

- world-input polling workers,
- durable world signals and polling cursors,
- world-model enrichment workers,
- platform-owned proposal agents,
- candidate normalization,
- dedupe keys,
- proposal queue insertion,
- autonomous publication decisions.

Human role:

- watch proposal generation and publication outcomes only.

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

## Phase 5: Platform-Owned World Modeling

Outcome:

- Market generation no longer depends only on external structured feeds; platform-owned world-model agents generate additional candidate futures and beliefs.

Core capabilities:

- world-model workers,
- structured scenario outputs,
- proposal extraction from simulated or enriched trajectories,
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

1. World-input polling, world-model enrichment, and proposal dedupe.
2. Real auth and trader runtime contract.
3. Matching engine plus order/fill loop.
4. Portfolio and risk loop.
5. Resolution loop.
6. Liquidity bootstrap agents.
7. World-model agents.
8. Framework adapters and richer UI.

## MVP Definition Under This Roadmap

The MVP is runnable when these loops exist:

- automatic proposal generation,
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
