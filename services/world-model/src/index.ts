import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { loadLlmClientFromEnv } from "@automakit/agent-llm";
import { createDatabasePool, ensureCoreSchema, parseJsonField, toIsoTimestamp } from "@automakit/persistence";
import type { PriceThresholdDecisionRule, ResolutionExtractionMode, ResolutionSpec } from "@automakit/sdk-types";
import {
  buildDedupeKey,
  normalizeAllowedDomainsFromUrl,
  type ActiveWorldEvent,
  type BeliefHypothesisProposal,
  type SimulationRunStatus,
  type WorldEntityRef,
  type WorldEntityState,
  type WorldFactorState,
  type WorldSignal,
  type WorldStateProposal,
  validateBeliefHypothesisProposal,
  validateWorldStateProposal,
} from "@automakit/world-sim";

type SimulationRunRow = {
  id: string;
  trigger_signal_ids: unknown;
  status: SimulationRunStatus;
  started_at: unknown;
};

type WorldSignalRow = {
  id: string;
  source_type: WorldSignal["source_type"];
  source_adapter: WorldSignal["source_adapter"];
  source_id: string;
  source_url: string;
  trust_tier: WorldSignal["trust_tier"];
  title: string;
  summary: string;
  payload: unknown;
  entity_refs: unknown;
  dedupe_key: string;
  fetched_at: unknown;
  effective_at: unknown;
  created_at: unknown;
};

type WorldStateProposalRow = {
  id: string;
  run_id: string;
  agent_id: string;
  source_signal_ids: unknown;
  as_of: unknown;
  entities: unknown;
  active_events: unknown;
  factors: unknown;
  regime_labels: unknown;
  reasoning_summary: string;
  created_at: unknown;
};

type BeliefHypothesisProposalRow = {
  id: string;
  run_id: string;
  agent_id: string;
  parent_ids: unknown;
  hypothesis_kind: BeliefHypothesisProposal["hypothesis_kind"];
  category: string;
  subject: string;
  predicate: string;
  target_time: unknown;
  confidence_score: unknown;
  reasoning_summary: string;
  source_signal_ids: unknown;
  machine_resolvable: boolean;
  suggested_resolution_spec: unknown;
  dedupe_key: string;
  created_at: unknown;
};

type WorldModelLlmResponse = {
  world_state: {
    as_of?: string;
    entities?: WorldEntityState[];
    active_events?: ActiveWorldEvent[];
    factors?: WorldFactorState[];
    regime_labels?: string[];
    reasoning_summary?: string;
  };
  hypotheses: Array<{
    source_signal_id: string;
    hypothesis_kind: BeliefHypothesisProposal["hypothesis_kind"];
    category: string;
    subject: string;
    predicate: string;
    target_time: string;
    confidence_score: number;
    reasoning_summary: string;
    machine_resolvable?: boolean;
    price_threshold?: {
      operator: "gt" | "gte" | "lt" | "lte";
      threshold: number;
    };
  }>;
};

const port = Number(process.env.WORLD_MODEL_PORT ?? 4011);
const intervalMs = Number(process.env.WORLD_MODEL_INTERVAL_MS ?? 1000);
const batchSize = Number(process.env.WORLD_MODEL_BATCH_SIZE ?? 10);
const agentId = process.env.WORLD_MODEL_AGENT_ID ?? "world-model-alpha";
const agentProfile = process.env.WORLD_MODEL_AGENT_PROFILE ?? "macro";
const mode = process.env.WORLD_MODEL_MODE ?? "llm";
const llmClient = (() => {
  if (mode !== "llm") {
    return null;
  }
  return loadLlmClientFromEnv();
})();
const app = Fastify({ logger: true });
const pool = createDatabasePool();

let tickInFlight = false;
let lastTickAt: string | null = null;
let lastTickError: string | null = null;

function mapSignalRow(row: WorldSignalRow): WorldSignal {
  return {
    id: row.id,
    source_type: row.source_type,
    source_adapter: row.source_adapter,
    source_id: row.source_id,
    source_url: row.source_url,
    trust_tier: row.trust_tier,
    title: row.title,
    summary: row.summary,
    payload: parseJsonField<Record<string, unknown>>(row.payload),
    entity_refs: parseJsonField<WorldEntityRef[]>(row.entity_refs),
    dedupe_key: row.dedupe_key,
    fetched_at: toIsoTimestamp(row.fetched_at),
    effective_at: row.effective_at ? toIsoTimestamp(row.effective_at) : null,
    created_at: toIsoTimestamp(row.created_at),
  };
}

function mapWorldStateProposalRow(row: WorldStateProposalRow): WorldStateProposal {
  return {
    id: row.id,
    run_id: row.run_id,
    agent_id: row.agent_id,
    source_signal_ids: parseJsonField<string[]>(row.source_signal_ids),
    as_of: toIsoTimestamp(row.as_of),
    entities: parseJsonField<WorldEntityState[]>(row.entities),
    active_events: parseJsonField<ActiveWorldEvent[]>(row.active_events),
    factors: parseJsonField<WorldFactorState[]>(row.factors),
    regime_labels: parseJsonField<string[]>(row.regime_labels),
    reasoning_summary: row.reasoning_summary,
    created_at: toIsoTimestamp(row.created_at),
  };
}

function mapHypothesisProposalRow(row: BeliefHypothesisProposalRow): BeliefHypothesisProposal {
  return {
    id: row.id,
    run_id: row.run_id,
    agent_id: row.agent_id,
    parent_ids: parseJsonField<string[]>(row.parent_ids),
    hypothesis_kind: row.hypothesis_kind,
    category: row.category,
    subject: row.subject,
    predicate: row.predicate,
    target_time: toIsoTimestamp(row.target_time),
    confidence_score: Number(row.confidence_score),
    reasoning_summary: row.reasoning_summary,
    source_signal_ids: parseJsonField<string[]>(row.source_signal_ids),
    machine_resolvable: Boolean(row.machine_resolvable),
    suggested_resolution_spec: row.suggested_resolution_spec
      ? parseJsonField<ResolutionSpec>(row.suggested_resolution_spec)
      : undefined,
    dedupe_key: row.dedupe_key,
    created_at: toIsoTimestamp(row.created_at),
  };
}

async function fetchRunsNeedingAgentOutput(limit: number) {
  const result = await pool.query<SimulationRunRow>(
    `
      SELECT id, trigger_signal_ids, status, started_at
      FROM simulation_runs
      WHERE status = 'world_model_pending'
        AND NOT EXISTS (
          SELECT 1
          FROM world_state_proposals
          WHERE world_state_proposals.run_id = simulation_runs.id
            AND world_state_proposals.agent_id = $1
        )
      ORDER BY started_at ASC, id ASC
      LIMIT $2
    `,
    [agentId, limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    trigger_signal_ids: parseJsonField<string[]>(row.trigger_signal_ids),
    status: row.status,
    started_at: toIsoTimestamp(row.started_at),
  }));
}

async function fetchSignals(signalIds: string[]) {
  if (signalIds.length === 0) {
    return [];
  }

  const result = await pool.query<WorldSignalRow>(
    `
      SELECT *
      FROM world_signals
      WHERE id = ANY($1::text[])
      ORDER BY created_at ASC, id ASC
    `,
    [signalIds],
  );

  return result.rows.map(mapSignalRow);
}

function clamp(value: number, min = 0.05, max = 0.95) {
  return Math.max(min, Math.min(max, value));
}

function readResolutionExtractionMode(signal: WorldSignal): ResolutionExtractionMode | undefined {
  return signal.payload.resolution_extraction_mode === "agent_extract" ? "agent_extract" : undefined;
}

function buildPriceThresholdSpec(
  signal: WorldSignal,
  options: {
    operator: "gt" | "gte" | "lt" | "lte";
    threshold: number;
  },
): ResolutionSpec | null {
  const assetSymbol =
    typeof signal.payload.asset_symbol === "string" ? signal.payload.asset_symbol : undefined;
  const operator = options.operator;
  const threshold = options.threshold;
  const canonicalSourceUrl =
    typeof signal.payload.canonical_source_url === "string" ? signal.payload.canonical_source_url : undefined;
  const observationPricePath =
    typeof signal.payload.observation_price_path === "string" && signal.payload.observation_price_path.trim().length > 0
      ? signal.payload.observation_price_path.trim()
      : "price";

  if (!assetSymbol || !Number.isFinite(threshold) || !canonicalSourceUrl || threshold <= 0) {
    return null;
  }

  return {
    kind: "price_threshold",
    source: {
      adapter: "http_json",
      canonical_url: canonicalSourceUrl,
      allowed_domains: normalizeAllowedDomainsFromUrl(canonicalSourceUrl),
      extraction_mode: readResolutionExtractionMode(signal),
    },
    observation_schema: {
      type: "object",
      fields: {
        price: { type: "number", path: observationPricePath },
        observed_at: { type: "string", path: "observed_at", required: false },
      },
    },
    decision_rule: {
      kind: "price_threshold",
      observation_field: "price",
      operator,
      threshold,
    },
    quorum_rule: {
      min_observations: 2,
      min_distinct_collectors: 2,
      agreement: "all",
    },
    quarantine_rule: {
      on_source_fetch_failure: true,
      on_schema_validation_failure: true,
      on_observation_conflict: true,
      max_observation_age_seconds: 3600,
    },
  };
}

function buildRateDecisionSpec(signal: WorldSignal): ResolutionSpec | null {
  const direction =
    signal.payload.direction === "hold" || signal.payload.direction === "hike"
      ? signal.payload.direction
      : "cut";
  const canonicalSourceUrl =
    typeof signal.payload.canonical_source_url === "string" ? signal.payload.canonical_source_url : undefined;

  if (!canonicalSourceUrl) {
    return null;
  }

  return {
    kind: "rate_decision",
    source: {
      adapter: "http_json",
      canonical_url: canonicalSourceUrl,
      allowed_domains: normalizeAllowedDomainsFromUrl(canonicalSourceUrl),
      extraction_mode: readResolutionExtractionMode(signal),
    },
    observation_schema: {
      type: "object",
      fields: {
        previous_upper_bound_bps: { type: "number", path: "previous_upper_bound_bps" },
        current_upper_bound_bps: { type: "number", path: "current_upper_bound_bps" },
        observed_at: { type: "string", path: "observed_at", required: false },
      },
    },
    decision_rule: {
      kind: "rate_decision",
      previous_field: "previous_upper_bound_bps",
      current_field: "current_upper_bound_bps",
      direction,
    },
    quorum_rule: {
      min_observations: 2,
      min_distinct_collectors: 2,
      agreement: "all",
    },
    quarantine_rule: {
      on_source_fetch_failure: true,
      on_schema_validation_failure: true,
      on_observation_conflict: true,
      max_observation_age_seconds: 3600,
    },
  };
}

function buildWorldModelLlmSystemPrompt() {
  return [
    "You are a world-model agent in an autonomous prediction-market platform.",
    "Return strict JSON only.",
    "Generate one world_state object and a hypotheses array.",
    "Each hypothesis must map to one input signal via source_signal_id.",
    "Use only these hypothesis kinds: price_threshold, rate_decision, event_occurrence.",
    "Set confidence_score in [0,1].",
    "For price_threshold hypotheses, always include price_threshold.operator and price_threshold.threshold.",
    "Never hallucinate source ids.",
  ].join(" ");
}

function buildWorldModelLlmUserPayload(signals: WorldSignal[]) {
  return {
    agent_profile: agentProfile,
    signals: signals.map((signal) => ({
      id: signal.id,
      source_type: signal.source_type,
      title: signal.title,
      summary: signal.summary,
      effective_at: signal.effective_at,
      entity_refs: signal.entity_refs,
      payload: signal.payload,
    })),
  };
}

async function generateWithLlm(runId: string, triggerSignalIds: string[], signals: WorldSignal[]) {
  if (!llmClient) {
    throw new Error("world_model_llm_client_unavailable");
  }

  const response = await llmClient.chatJson<WorldModelLlmResponse>([
    { role: "system", content: buildWorldModelLlmSystemPrompt() },
    {
      role: "user",
      content: JSON.stringify(buildWorldModelLlmUserPayload(signals)),
    },
  ]);

  if (!response || typeof response !== "object" || !Array.isArray(response.hypotheses)) {
    throw new Error("invalid_world_model_llm_response");
  }

  const signalMap = new Map<string, WorldSignal>(signals.map((signal) => [signal.id, signal]));
  const worldStateProposal: WorldStateProposal = {
    id: randomUUID(),
    run_id: runId,
    agent_id: agentId,
    source_signal_ids: triggerSignalIds,
    as_of:
      typeof response.world_state?.as_of === "string" ? response.world_state.as_of : new Date().toISOString(),
    entities: Array.isArray(response.world_state?.entities) ? response.world_state.entities : [],
    active_events: Array.isArray(response.world_state?.active_events) ? response.world_state.active_events : [],
    factors: Array.isArray(response.world_state?.factors) ? response.world_state.factors : [],
    regime_labels: Array.isArray(response.world_state?.regime_labels)
      ? response.world_state.regime_labels
      : ["belief-layer", "market:mixed"],
    reasoning_summary:
      typeof response.world_state?.reasoning_summary === "string"
        ? response.world_state.reasoning_summary
        : `${agentId} generated an LLM world-state interpretation.`,
    created_at: new Date().toISOString(),
  };

  const stateValidation = validateWorldStateProposal(worldStateProposal);
  if (!stateValidation.ok) {
    throw new Error(`invalid_world_state_proposal:${stateValidation.errors.join(",")}`);
  }

  const hypotheses: BeliefHypothesisProposal[] = [];
  for (const item of response.hypotheses) {
    const signal = signalMap.get(item.source_signal_id);
    if (!signal) {
      continue;
    }

    let suggestedResolutionSpec: ResolutionSpec | undefined;
    if (item.hypothesis_kind === "price_threshold") {
      if (!item.price_threshold) {
        continue;
      }
      suggestedResolutionSpec = buildPriceThresholdSpec(signal, {
        operator: item.price_threshold.operator,
        threshold: item.price_threshold.threshold,
      }) ?? undefined;
    } else if (item.hypothesis_kind === "rate_decision") {
      suggestedResolutionSpec = buildRateDecisionSpec(signal) ?? undefined;
    }

    const machineResolvable = Boolean(item.machine_resolvable ?? true) && Boolean(suggestedResolutionSpec);
    const hypothesis: BeliefHypothesisProposal = {
      id: randomUUID(),
      run_id: runId,
      agent_id: agentId,
      parent_ids: [signal.id],
      hypothesis_kind: item.hypothesis_kind,
      category: item.category,
      subject: item.subject,
      predicate: item.predicate,
      target_time: item.target_time,
      confidence_score: clamp(Number(item.confidence_score)),
      reasoning_summary: item.reasoning_summary,
      source_signal_ids: [signal.id],
      machine_resolvable: machineResolvable,
      suggested_resolution_spec: suggestedResolutionSpec,
      dedupe_key: buildDedupeKey({
        kind: item.hypothesis_kind,
        subject: item.subject,
        predicate: item.predicate,
        target_time: item.target_time,
        resolution_spec: suggestedResolutionSpec ?? null,
      }),
      created_at: new Date().toISOString(),
    };
    const validation = validateBeliefHypothesisProposal(hypothesis);
    if (validation.ok) {
      hypotheses.push(validation.proposal);
    }
  }

  if (hypotheses.length === 0) {
    throw new Error("world_model_llm_produced_no_valid_hypotheses");
  }

  return {
    worldStateProposal: stateValidation.proposal,
    hypotheses,
  };
}

async function upsertWorldStateProposal(proposal: WorldStateProposal) {
  await pool.query(
    `
      INSERT INTO world_state_proposals (
        id,
        run_id,
        agent_id,
        source_signal_ids,
        as_of,
        entities,
        active_events,
        factors,
        regime_labels,
        reasoning_summary,
        created_at
      )
      VALUES (
        $1, $2, $3, $4::jsonb, $5::timestamptz, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::timestamptz
      )
      ON CONFLICT (run_id, agent_id) DO UPDATE SET
        source_signal_ids = EXCLUDED.source_signal_ids,
        as_of = EXCLUDED.as_of,
        entities = EXCLUDED.entities,
        active_events = EXCLUDED.active_events,
        factors = EXCLUDED.factors,
        regime_labels = EXCLUDED.regime_labels,
        reasoning_summary = EXCLUDED.reasoning_summary
    `,
    [
      proposal.id,
      proposal.run_id,
      proposal.agent_id,
      JSON.stringify(proposal.source_signal_ids),
      proposal.as_of,
      JSON.stringify(proposal.entities),
      JSON.stringify(proposal.active_events),
      JSON.stringify(proposal.factors),
      JSON.stringify(proposal.regime_labels),
      proposal.reasoning_summary,
      proposal.created_at,
    ],
  );
}

async function upsertBeliefHypothesisProposal(proposal: BeliefHypothesisProposal) {
  await pool.query(
    `
      INSERT INTO belief_hypothesis_proposals (
        id,
        run_id,
        agent_id,
        parent_ids,
        hypothesis_kind,
        category,
        subject,
        predicate,
        target_time,
        confidence_score,
        reasoning_summary,
        source_signal_ids,
        machine_resolvable,
        suggested_resolution_spec,
        dedupe_key,
        created_at
      )
      VALUES (
        $1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::timestamptz, $10, $11, $12::jsonb, $13, $14::jsonb, $15, $16::timestamptz
      )
      ON CONFLICT (run_id, agent_id, dedupe_key) DO UPDATE SET
        confidence_score = EXCLUDED.confidence_score,
        reasoning_summary = EXCLUDED.reasoning_summary,
        source_signal_ids = EXCLUDED.source_signal_ids,
        machine_resolvable = EXCLUDED.machine_resolvable,
        suggested_resolution_spec = EXCLUDED.suggested_resolution_spec
    `,
    [
      proposal.id,
      proposal.run_id,
      proposal.agent_id,
      JSON.stringify(proposal.parent_ids),
      proposal.hypothesis_kind,
      proposal.category,
      proposal.subject,
      proposal.predicate,
      proposal.target_time,
      proposal.confidence_score,
      proposal.reasoning_summary,
      JSON.stringify(proposal.source_signal_ids),
      proposal.machine_resolvable,
      JSON.stringify(proposal.suggested_resolution_spec ?? null),
      proposal.dedupe_key,
      proposal.created_at,
    ],
  );
}

async function processRun(runId: string, triggerSignalIds: string[]) {
  const signals = await fetchSignals(triggerSignalIds);
  if (signals.length === 0) {
    return;
  }

  let output:
    | {
        worldStateProposal: WorldStateProposal;
        hypotheses: BeliefHypothesisProposal[];
      }
    | undefined;

  if (mode !== "llm" || !llmClient) {
    throw new Error("world_model_requires_llm_mode_and_client");
  }
  output = await generateWithLlm(runId, triggerSignalIds, signals);

  await upsertWorldStateProposal(output.worldStateProposal);
  for (const hypothesis of output.hypotheses) {
    await upsertBeliefHypothesisProposal(hypothesis);
  }
}

async function tick() {
  if (tickInFlight) {
    return;
  }

  tickInFlight = true;
  try {
    const runs = await fetchRunsNeedingAgentOutput(batchSize);
    for (const run of runs) {
      await processRun(run.id, run.trigger_signal_ids);
    }
    lastTickAt = new Date().toISOString();
    lastTickError = null;
  } catch (error) {
    lastTickAt = new Date().toISOString();
    lastTickError = String(error);
    app.log.error(error);
  } finally {
    tickInFlight = false;
  }
}

app.get("/health", async () => ({
  service: "world-model",
  status: "ok",
  agent_id: agentId,
  agent_profile: agentProfile,
  mode,
  last_tick_at: lastTickAt,
  last_tick_error: lastTickError,
}));

app.get("/v1/internal/world-state-proposals", async () => {
  const result = await pool.query<WorldStateProposalRow>(
    `
      SELECT *
      FROM world_state_proposals
      ORDER BY created_at DESC, id DESC
    `,
  );

  return {
    items: result.rows.map(mapWorldStateProposalRow),
  };
});

app.get("/v1/internal/world-model-hypotheses", async () => {
  const result = await pool.query<BeliefHypothesisProposalRow>(
    `
      SELECT *
      FROM belief_hypothesis_proposals
      ORDER BY created_at DESC, id DESC
    `,
  );

  return {
    items: result.rows.map(mapHypothesisProposalRow),
  };
});

app.post("/v1/internal/world-model/run-once", async () => {
  await tick();
  return { status: "ok", last_tick_at: lastTickAt, last_tick_error: lastTickError };
});

async function start() {
  await ensureCoreSchema(pool);
  await app.listen({ port, host: "0.0.0.0" });
  void tick();
  setInterval(() => {
    void tick();
  }, intervalMs);
}

void start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
