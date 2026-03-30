import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { loadLlmClientFromEnv } from "@automakit/agent-llm";
import { createDatabasePool, ensureCoreSchema, parseJsonField, toIsoTimestamp } from "@automakit/persistence";
import {
  type BeliefHypothesisProposal,
  type ScenarioPathProposal,
  type SimulationRunStatus,
  type SynthesizedBelief,
  validateSynthesizedBelief,
} from "@automakit/world-sim";

type SimulationRunRow = {
  id: string;
  status: SimulationRunStatus;
  started_at: unknown;
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

type ScenarioPathProposalRow = {
  id: string;
  run_id: string;
  agent_id: string;
  label: string;
  probability: unknown;
  narrative: string;
  factor_deltas: unknown;
  path_events: unknown;
  path_hypotheses: unknown;
  created_at: unknown;
};

type SynthesizedBeliefRow = {
  id: string;
  run_id: string;
  agent_id: string;
  belief_dedupe_key: string;
  parent_hypothesis_ids: unknown;
  agreement_score: unknown;
  disagreement_score: unknown;
  confidence_score: unknown;
  conflict_notes: string | null;
  hypothesis: unknown;
  status: SynthesizedBelief["status"];
  suppression_reason: string | null;
  linked_proposal_id: string | null;
  created_at: unknown;
  updated_at: unknown;
};

type SynthesisLlmResponse = {
  beliefs: Array<{
    key: string;
    agreement_score: number;
    disagreement_score: number;
    confidence_score: number;
    status: SynthesizedBelief["status"];
    conflict_notes?: string | null;
    suppression_reason?: string | null;
    reasoning_summary: string;
  }>;
};

const port = Number(process.env.SYNTHESIS_AGENT_PORT ?? 4015);
const intervalMs = Number(process.env.SYNTHESIS_AGENT_INTERVAL_MS ?? 1000);
const batchSize = Number(process.env.SYNTHESIS_AGENT_BATCH_SIZE ?? 10);
const agentId = process.env.SYNTHESIS_AGENT_ID ?? "synthesis-core";
const minConfidenceForNew = Math.max(0, Math.min(1, Number(process.env.SYNTHESIS_MIN_CONFIDENCE_FOR_NEW ?? 0.52)));
const maxDisagreementForNew = Math.max(0, Math.min(1, Number(process.env.SYNTHESIS_MAX_DISAGREEMENT_FOR_NEW ?? 0.35)));
const mode = process.env.SYNTHESIS_AGENT_MODE ?? "llm";
const llmStrict = (process.env.SYNTHESIS_AGENT_LLM_STRICT ?? "false").toLowerCase() !== "false";
const llmClient = (() => {
  if (mode !== "llm") {
    return null;
  }
  try {
    return loadLlmClientFromEnv();
  } catch (error) {
    if (llmStrict) {
      throw error;
    }
    console.warn("[synthesis-agent] llm init failed; using heuristic mode fallback", error);
    return null;
  }
})();
const app = Fastify({ logger: true });
const pool = createDatabasePool();

let tickInFlight = false;
let lastTickAt: string | null = null;
let lastTickError: string | null = null;

function mapBeliefRow(row: BeliefHypothesisProposalRow): BeliefHypothesisProposal {
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
      ? parseJsonField(row.suggested_resolution_spec)
      : undefined,
    dedupe_key: row.dedupe_key,
    created_at: toIsoTimestamp(row.created_at),
  };
}

function mapScenarioRow(row: ScenarioPathProposalRow): ScenarioPathProposal {
  return {
    id: row.id,
    run_id: row.run_id,
    agent_id: row.agent_id,
    label: row.label,
    probability: Number(row.probability),
    narrative: row.narrative,
    factor_deltas: parseJsonField(row.factor_deltas),
    path_events: parseJsonField(row.path_events),
    path_hypotheses: parseJsonField(row.path_hypotheses),
    created_at: toIsoTimestamp(row.created_at),
  };
}

function mapSynthesizedBeliefRow(row: SynthesizedBeliefRow): SynthesizedBelief {
  return {
    id: row.id,
    run_id: row.run_id,
    agent_id: row.agent_id,
    parent_hypothesis_ids: parseJsonField<string[]>(row.parent_hypothesis_ids),
    agreement_score: Number(row.agreement_score),
    disagreement_score: Number(row.disagreement_score),
    confidence_score: Number(row.confidence_score),
    conflict_notes: row.conflict_notes,
    hypothesis: parseJsonField<BeliefHypothesisProposal>(row.hypothesis),
    status: row.status,
    suppression_reason: row.suppression_reason,
    linked_proposal_id: row.linked_proposal_id,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  };
}

async function fetchRuns(limit: number) {
  const result = await pool.query<SimulationRunRow>(
    `
      SELECT id, status, started_at
      FROM simulation_runs
      WHERE status = 'synthesis_pending'
        AND NOT EXISTS (
          SELECT 1
          FROM synthesized_beliefs
          WHERE synthesized_beliefs.run_id = simulation_runs.id
            AND synthesized_beliefs.agent_id = $1
        )
      ORDER BY started_at ASC, id ASC
      LIMIT $2
    `,
    [agentId, limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    started_at: toIsoTimestamp(row.started_at),
  }));
}

async function fetchDirectHypotheses(runId: string) {
  const result = await pool.query<BeliefHypothesisProposalRow>(
    `
      SELECT *
      FROM belief_hypothesis_proposals
      WHERE run_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [runId],
  );
  return result.rows.map(mapBeliefRow);
}

async function fetchScenarioPaths(runId: string) {
  const result = await pool.query<ScenarioPathProposalRow>(
    `
      SELECT *
      FROM scenario_path_proposals
      WHERE run_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [runId],
  );
  return result.rows.map(mapScenarioRow);
}

type CandidateAggregate = {
  base: BeliefHypothesisProposal;
  direct: BeliefHypothesisProposal[];
  scenarioEntries: Array<{ confidence: number; probability: number; label: string; reasoning: string }>;
};

function clamp(value: number, min = 0.05, max = 0.95) {
  return Math.max(min, Math.min(max, value));
}

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function upsertCandidate(aggregateMap: Map<string, CandidateAggregate>, belief: BeliefHypothesisProposal) {
  const existing = aggregateMap.get(belief.dedupe_key);
  if (existing) {
    existing.direct.push(belief);
    if (belief.confidence_score > existing.base.confidence_score) {
      existing.base = belief;
    }
    return;
  }

  aggregateMap.set(belief.dedupe_key, {
    base: belief,
    direct: [belief],
    scenarioEntries: [],
  });
}

function collectCandidates(
  directHypotheses: BeliefHypothesisProposal[],
  scenarioPaths: ScenarioPathProposal[],
) {
  const aggregates = new Map<string, CandidateAggregate>();

  for (const belief of directHypotheses) {
    upsertCandidate(aggregates, belief);
  }

  for (const path of scenarioPaths) {
    for (const hypothesis of path.path_hypotheses) {
      const existing = aggregates.get(hypothesis.key);
      if (!existing) {
        continue;
      }
      existing.scenarioEntries.push({
        confidence: hypothesis.confidence_score,
        probability: path.probability,
        label: path.label,
        reasoning: hypothesis.reasoning_summary,
      });
    }
  }

  return aggregates;
}

function synthesizeHeuristic(runId: string, aggregate: CandidateAggregate) {
  const directScores = aggregate.direct.map((entry) => entry.confidence_score);
  const scenarioScores = aggregate.scenarioEntries.map((entry) => entry.confidence);
  const weightedScenario =
    aggregate.scenarioEntries.reduce((sum, entry) => sum + entry.confidence * entry.probability, 0) /
    Math.max(
      aggregate.scenarioEntries.reduce((sum, entry) => sum + entry.probability, 0),
      1,
    );
  const directAverage = average(directScores);
  const combinedConfidence = clamp(directAverage * 0.6 + weightedScenario * 0.4);
  const allScores = [...directScores, ...scenarioScores];
  const minScore = Math.min(...allScores);
  const maxScore = Math.max(...allScores);
  const disagreementScore = clamp(maxScore - minScore, 0, 1);
  const agreementScore = clamp(1 - disagreementScore, 0, 1);
  const conflictNotes =
    disagreementScore > 0.22
      ? `Divergence observed across path labels: ${aggregate.scenarioEntries.map((entry) => entry.label).join(", ")}.`
      : null;
  const status: SynthesizedBelief["status"] =
    aggregate.base.machine_resolvable && combinedConfidence >= minConfidenceForNew && disagreementScore <= maxDisagreementForNew
      ? "new"
      : disagreementScore > maxDisagreementForNew
        ? "ambiguous"
        : "suppressed";
  const suppressionReason =
    status === "suppressed"
      ? "insufficient_combined_confidence"
      : status === "ambiguous"
        ? "agent_outputs_diverged"
        : null;

  const hypothesis: BeliefHypothesisProposal = {
    ...aggregate.base,
    id: randomUUID(),
    run_id: runId,
    agent_id: agentId,
    confidence_score: combinedConfidence,
    reasoning_summary: `${agentId} synthesized ${aggregate.direct.length} direct hypotheses and ${aggregate.scenarioEntries.length} path hypotheses into one belief.`,
    created_at: new Date().toISOString(),
  };

  const synthesized: SynthesizedBelief = {
    id: randomUUID(),
    run_id: runId,
    agent_id: agentId,
    parent_hypothesis_ids: aggregate.direct.map((entry) => entry.id),
    agreement_score: agreementScore,
    disagreement_score: disagreementScore,
    confidence_score: combinedConfidence,
    conflict_notes: conflictNotes,
    hypothesis,
    status,
    suppression_reason: suppressionReason,
    linked_proposal_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const validation = validateSynthesizedBelief(synthesized);
  if (!validation.ok) {
    throw new Error(`invalid_synthesized_belief:${validation.errors.join(",")}`);
  }

  return validation.belief;
}

function buildSynthesisLlmSystemPrompt() {
  return [
    "You are a synthesis agent for a prediction-market simulation fabric.",
    "Return strict JSON only.",
    "For each candidate key, output confidence, agreement, disagreement, status, and concise reasoning.",
    "Use only provided keys.",
    "All scores must be in [0,1].",
  ].join(" ");
}

function buildSynthesisLlmUserPayload(aggregates: Map<string, CandidateAggregate>) {
  return {
    agent_id: agentId,
    candidates: [...aggregates.entries()].map(([key, aggregate]) => ({
      key,
      hypothesis_kind: aggregate.base.hypothesis_kind,
      category: aggregate.base.category,
      subject: aggregate.base.subject,
      predicate: aggregate.base.predicate,
      target_time: aggregate.base.target_time,
      machine_resolvable: aggregate.base.machine_resolvable,
      direct: aggregate.direct.map((entry) => ({
        confidence: entry.confidence_score,
        reasoning: entry.reasoning_summary,
      })),
      scenario: aggregate.scenarioEntries.map((entry) => ({
        label: entry.label,
        confidence: entry.confidence,
        probability: entry.probability,
        reasoning: entry.reasoning,
      })),
    })),
  };
}

async function synthesizeWithLlm(runId: string, aggregates: Map<string, CandidateAggregate>) {
  if (!llmClient) {
    throw new Error("synthesis_llm_client_unavailable");
  }

  const response = await llmClient.chatJson<SynthesisLlmResponse>([
    { role: "system", content: buildSynthesisLlmSystemPrompt() },
    {
      role: "user",
      content: JSON.stringify(buildSynthesisLlmUserPayload(aggregates)),
    },
  ]);

  if (!response || typeof response !== "object" || !Array.isArray(response.beliefs)) {
    throw new Error("invalid_synthesis_llm_response");
  }

  const beliefs: SynthesizedBelief[] = [];
  for (const item of response.beliefs) {
    const aggregate = aggregates.get(item.key);
    if (!aggregate) {
      continue;
    }

    const hypothesis: BeliefHypothesisProposal = {
      ...aggregate.base,
      id: randomUUID(),
      run_id: runId,
      agent_id: agentId,
      confidence_score: clamp(Number(item.confidence_score)),
      reasoning_summary: item.reasoning_summary,
      created_at: new Date().toISOString(),
    };
    const synthesized: SynthesizedBelief = {
      id: randomUUID(),
      run_id: runId,
      agent_id: agentId,
      parent_hypothesis_ids: aggregate.direct.map((entry) => entry.id),
      agreement_score: clamp(Number(item.agreement_score), 0, 1),
      disagreement_score: clamp(Number(item.disagreement_score), 0, 1),
      confidence_score: clamp(Number(item.confidence_score), 0, 1),
      conflict_notes: item.conflict_notes ?? null,
      hypothesis,
      status: item.status,
      suppression_reason: item.suppression_reason ?? null,
      linked_proposal_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const validation = validateSynthesizedBelief(synthesized);
    if (validation.ok) {
      beliefs.push(validation.belief);
    }
  }

  if (beliefs.length === 0) {
    throw new Error("synthesis_llm_produced_no_valid_beliefs");
  }

  return beliefs;
}

async function upsertSynthesizedBelief(belief: SynthesizedBelief) {
  await pool.query(
    `
      INSERT INTO synthesized_beliefs (
        id,
        run_id,
        agent_id,
        belief_dedupe_key,
        parent_hypothesis_ids,
        agreement_score,
        disagreement_score,
        confidence_score,
        conflict_notes,
        hypothesis,
        status,
        suppression_reason,
        linked_proposal_id,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14::timestamptz, $15::timestamptz
      )
      ON CONFLICT (run_id, agent_id, belief_dedupe_key) DO UPDATE SET
        parent_hypothesis_ids = EXCLUDED.parent_hypothesis_ids,
        agreement_score = EXCLUDED.agreement_score,
        disagreement_score = EXCLUDED.disagreement_score,
        confidence_score = EXCLUDED.confidence_score,
        conflict_notes = EXCLUDED.conflict_notes,
        hypothesis = EXCLUDED.hypothesis,
        status = CASE
          WHEN synthesized_beliefs.status = 'proposed' THEN synthesized_beliefs.status
          ELSE EXCLUDED.status
        END,
        suppression_reason = EXCLUDED.suppression_reason,
        updated_at = EXCLUDED.updated_at
    `,
    [
      belief.id,
      belief.run_id,
      belief.agent_id,
      belief.hypothesis.dedupe_key,
      JSON.stringify(belief.parent_hypothesis_ids),
      belief.agreement_score,
      belief.disagreement_score,
      belief.confidence_score,
      belief.conflict_notes ?? null,
      JSON.stringify(belief.hypothesis),
      belief.status,
      belief.suppression_reason ?? null,
      belief.linked_proposal_id ?? null,
      belief.created_at,
      belief.updated_at,
    ],
  );
}

async function tick() {
  if (tickInFlight) {
    return;
  }

  tickInFlight = true;
  try {
    const runs = await fetchRuns(batchSize);
    for (const run of runs) {
      const directHypotheses = await fetchDirectHypotheses(run.id);
      const scenarioPaths = await fetchScenarioPaths(run.id);
      if (directHypotheses.length === 0 || scenarioPaths.length === 0) {
        continue;
      }

      const aggregates = collectCandidates(directHypotheses, scenarioPaths);
      let beliefs: SynthesizedBelief[] = [];
      if (mode === "llm" && llmClient) {
        try {
          beliefs = await synthesizeWithLlm(run.id, aggregates);
        } catch (error) {
          if (llmStrict) {
            throw error;
          }
          app.log.error({ err: error }, "synthesis-agent LLM generation failed; falling back to heuristic mode");
          beliefs = [...aggregates.values()].map((aggregate) => synthesizeHeuristic(run.id, aggregate));
        }
      } else {
        beliefs = [...aggregates.values()].map((aggregate) => synthesizeHeuristic(run.id, aggregate));
      }

      for (const belief of beliefs) {
        await upsertSynthesizedBelief(belief);
      }
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
  service: "synthesis-agent",
  status: "ok",
  agent_id: agentId,
  mode,
  last_tick_at: lastTickAt,
  last_tick_error: lastTickError,
}));

app.get("/v1/internal/synthesized-beliefs", async () => {
  const result = await pool.query<SynthesizedBeliefRow>(
    `
      SELECT *
      FROM synthesized_beliefs
      ORDER BY created_at DESC, id DESC
    `,
  );

  return {
    items: result.rows.map(mapSynthesizedBeliefRow),
  };
});

app.post("/v1/internal/synthesis-agent/run-once", async () => {
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
