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

type CaseAwareBeliefHypothesisProposal = BeliefHypothesisProposal & {
  event_case_id?: string | null;
  case_family_key?: string | null;
  belief_role?: "primary" | "secondary";
  publishability_score?: number;
};

type CaseAwareSynthesizedBelief = Omit<SynthesizedBelief, "hypothesis"> & {
  hypothesis: CaseAwareBeliefHypothesisProposal;
};

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
  event_case_id: string | null;
  case_family_key: string | null;
  belief_role: "primary" | "secondary" | null;
  publishability_score: unknown;
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
  beliefs?: Array<{
    key: string;
    agreement_score?: number;
    disagreement_score?: number;
    confidence_score?: number;
    status?: SynthesizedBelief["status"] | string;
    conflict_notes?: string | null;
    suppression_reason?: string | null;
    reasoning_summary?: string;
  }>;
  results?: Array<{
    key: string;
    agreement?: number;
    disagreement?: number;
    confidence?: number;
    status?: string;
    conflict_notes?: string | null;
    suppression_reason?: string | null;
    reasoning?: string;
  }>;
  candidates?: Array<{
    key: string;
    agreement_score?: number;
    disagreement_score?: number;
    confidence_score?: number;
    agreement?: number;
    disagreement?: number;
    confidence?: number;
    status?: string;
    conflict_notes?: string | null;
    suppression_reason?: string | null;
    reasoning_summary?: string;
    reasoning?: string;
  }>;
};

const port = Number(process.env.SYNTHESIS_AGENT_PORT ?? 4015);
const intervalMs = Number(process.env.SYNTHESIS_AGENT_INTERVAL_MS ?? 1000);
const batchSize = Number(process.env.SYNTHESIS_AGENT_BATCH_SIZE ?? 10);
const runConcurrency = Math.max(1, Number(process.env.SYNTHESIS_AGENT_RUN_CONCURRENCY ?? 4));
const agentId = process.env.SYNTHESIS_AGENT_ID ?? "synthesis-core";
const minConfidenceForNew = Math.max(0, Math.min(1, Number(process.env.SYNTHESIS_MIN_CONFIDENCE_FOR_NEW ?? 0.52)));
const maxDisagreementForNew = Math.max(0, Math.min(1, Number(process.env.SYNTHESIS_MAX_DISAGREEMENT_FOR_NEW ?? 0.35)));
const mode = process.env.SYNTHESIS_AGENT_MODE ?? "llm";
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

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  if (items.length === 0) {
    return;
  }

  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        await worker(items[currentIndex]);
      }
    }),
  );
}

function mapBeliefRow(row: BeliefHypothesisProposalRow): CaseAwareBeliefHypothesisProposal {
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
    event_case_id: row.event_case_id,
    case_family_key: row.case_family_key,
    belief_role: row.belief_role ?? undefined,
    publishability_score:
      row.publishability_score === null || row.publishability_score === undefined
        ? undefined
        : Number(row.publishability_score),
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

function mapSynthesizedBeliefRow(row: SynthesizedBeliefRow): CaseAwareSynthesizedBelief {
  return {
    id: row.id,
    run_id: row.run_id,
    agent_id: row.agent_id,
    parent_hypothesis_ids: parseJsonField<string[]>(row.parent_hypothesis_ids),
    agreement_score: Number(row.agreement_score),
    disagreement_score: Number(row.disagreement_score),
    confidence_score: Number(row.confidence_score),
    conflict_notes: row.conflict_notes,
    hypothesis: parseJsonField<CaseAwareBeliefHypothesisProposal>(row.hypothesis),
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
  base: CaseAwareBeliefHypothesisProposal;
  direct: CaseAwareBeliefHypothesisProposal[];
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

function deriveAggregateScores(aggregate: CandidateAggregate) {
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
  const allScores = [...directScores, ...scenarioScores].filter((value) => Number.isFinite(value));
  const minScore = allScores.length > 0 ? Math.min(...allScores) : combinedConfidence;
  const maxScore = allScores.length > 0 ? Math.max(...allScores) : combinedConfidence;
  const disagreementScore = clamp(maxScore - minScore, 0, 1);
  const agreementScore = clamp(1 - disagreementScore, 0, 1);

  return {
    confidenceScore: combinedConfidence,
    agreementScore,
    disagreementScore,
  };
}

function upsertCandidate(aggregateMap: Map<string, CandidateAggregate>, belief: CaseAwareBeliefHypothesisProposal) {
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
  directHypotheses: CaseAwareBeliefHypothesisProposal[],
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

function caseGroupKeyForBelief(belief: CaseAwareSynthesizedBelief) {
  return (
    belief.hypothesis.event_case_id ??
    belief.hypothesis.case_family_key ??
    `${belief.hypothesis.category}:${belief.hypothesis.subject}:${belief.hypothesis.target_time.slice(0, 10)}`
  );
}

function compareCaseBeliefs(left: CaseAwareSynthesizedBelief, right: CaseAwareSynthesizedBelief) {
  const leftStatusRank = left.status === "new" ? 3 : left.status === "ambiguous" ? 2 : left.status === "proposed" ? 1 : 0;
  const rightStatusRank =
    right.status === "new" ? 3 : right.status === "ambiguous" ? 2 : right.status === "proposed" ? 1 : 0;

  return (
    rightStatusRank - leftStatusRank ||
    Number(right.hypothesis.machine_resolvable) - Number(left.hypothesis.machine_resolvable) ||
    (right.hypothesis.publishability_score ?? right.confidence_score) -
      (left.hypothesis.publishability_score ?? left.confidence_score) ||
    right.confidence_score - left.confidence_score ||
    right.agreement_score - left.agreement_score ||
    left.disagreement_score - right.disagreement_score ||
    right.created_at.localeCompare(left.created_at)
  );
}

function promoteCasePrimaryBeliefs(beliefs: CaseAwareSynthesizedBelief[]) {
  const groups = new Map<string, CaseAwareSynthesizedBelief[]>();
  for (const belief of beliefs) {
    const key = caseGroupKeyForBelief(belief);
    groups.set(key, [...(groups.get(key) ?? []), belief]);
  }

  const finalized: CaseAwareSynthesizedBelief[] = [];
  for (const group of groups.values()) {
    const ranked = [...group].sort(compareCaseBeliefs);
    const primary = ranked[0];
    for (const belief of ranked) {
      if (belief.id === primary.id) {
        finalized.push({
          ...belief,
          hypothesis: {
            ...belief.hypothesis,
            belief_role: "primary",
          },
        });
        continue;
      }

      finalized.push({
        ...belief,
        status: "suppressed",
        suppression_reason: "case_secondary",
        hypothesis: {
          ...belief.hypothesis,
          belief_role: "secondary",
        },
        updated_at: new Date().toISOString(),
      });
    }
  }

  return finalized.sort((left, right) => right.created_at.localeCompare(left.created_at));
}

function buildSynthesisLlmSystemPrompt() {
  return [
    "You are a synthesis agent for a prediction-market simulation fabric.",
    "Return strict JSON only.",
    "For each candidate key, output confidence_score, agreement_score, disagreement_score, status, and concise reasoning_summary.",
    "Preserve distinction across event cases and avoid treating same-case variants as separate publishable winners.",
    "Use only provided keys.",
    "Status must be one of: new, ambiguous, suppressed.",
    "All scores must be in [0,1].",
  ].join(" ");
}

function normalizeSynthesisStatus(
  rawStatus: unknown,
  aggregate: CandidateAggregate,
  confidenceScore: number,
  disagreementScore: number,
): SynthesizedBelief["status"] {
  if (rawStatus === "new" || rawStatus === "ambiguous" || rawStatus === "suppressed") {
    return rawStatus;
  }
  if (rawStatus === "active" || rawStatus === "stable") {
    return aggregate.base.machine_resolvable &&
      confidenceScore >= minConfidenceForNew &&
      disagreementScore <= maxDisagreementForNew
      ? "new"
      : "suppressed";
  }
  if (disagreementScore > maxDisagreementForNew) {
    return "ambiguous";
  }
  return aggregate.base.machine_resolvable && confidenceScore >= minConfidenceForNew ? "new" : "suppressed";
}

function buildSynthesisLlmUserPayload(aggregates: Map<string, CandidateAggregate>) {
  return {
    agent_id: agentId,
    candidates: [...aggregates.entries()].map(([key, aggregate]) => ({
      key,
      hypothesis_kind: aggregate.base.hypothesis_kind,
      category: aggregate.base.category,
      subject: aggregate.base.subject,
      event_case_id: aggregate.base.event_case_id ?? null,
      case_family_key: aggregate.base.case_family_key ?? null,
      belief_role: aggregate.base.belief_role ?? null,
      publishability_score: aggregate.base.publishability_score ?? null,
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

  if (!response || typeof response !== "object") {
    throw new Error("invalid_synthesis_llm_response");
  }

  const beliefItems = Array.isArray(response.beliefs)
    ? response.beliefs
    : Array.isArray(response.results)
      ? response.results.map((item) => ({
          key: item.key,
          agreement_score: item.agreement,
          disagreement_score: item.disagreement,
          confidence_score: item.confidence,
          status: item.status,
          conflict_notes: item.conflict_notes,
          suppression_reason: item.suppression_reason,
          reasoning_summary: item.reasoning,
        }))
      : Array.isArray(response.candidates)
        ? response.candidates.map((item) => ({
            key: item.key,
            agreement_score: item.agreement_score ?? item.agreement,
            disagreement_score: item.disagreement_score ?? item.disagreement,
            confidence_score: item.confidence_score ?? item.confidence,
            status: item.status,
            conflict_notes: item.conflict_notes,
            suppression_reason: item.suppression_reason,
            reasoning_summary: item.reasoning_summary ?? item.reasoning,
          }))
      : null;
  if (!beliefItems) {
    throw new Error("invalid_synthesis_llm_response");
  }

  const beliefs: CaseAwareSynthesizedBelief[] = [];
  for (const item of beliefItems) {
    const aggregate = aggregates.get(item.key);
    if (!aggregate) {
      continue;
    }

    const defaults = deriveAggregateScores(aggregate);
    const confidenceScore = Number.isFinite(Number(item.confidence_score))
      ? clamp(Number(item.confidence_score), 0, 1)
      : defaults.confidenceScore;
    const agreementScore = Number.isFinite(Number(item.agreement_score))
      ? clamp(Number(item.agreement_score), 0, 1)
      : defaults.agreementScore;
    const disagreementScore = Number.isFinite(Number(item.disagreement_score))
      ? clamp(Number(item.disagreement_score), 0, 1)
      : defaults.disagreementScore;
    const reasoningSummary =
      typeof item.reasoning_summary === "string" && item.reasoning_summary.trim().length > 0
        ? item.reasoning_summary
        : `${agentId} synthesized direct and scenario evidence for ${aggregate.base.subject}.`;
    const status = normalizeSynthesisStatus(item.status, aggregate, confidenceScore, disagreementScore);
    const suppressionReason =
      status === "suppressed"
        ? item.suppression_reason ?? "insufficient_combined_confidence"
        : status === "ambiguous"
          ? item.suppression_reason ?? "agent_outputs_diverged"
          : null;

    const hypothesis: CaseAwareBeliefHypothesisProposal = {
      ...aggregate.base,
      id: randomUUID(),
      run_id: runId,
      agent_id: agentId,
      confidence_score: confidenceScore,
      reasoning_summary: reasoningSummary,
      created_at: new Date().toISOString(),
    };
    const synthesized: CaseAwareSynthesizedBelief = {
      id: randomUUID(),
      run_id: runId,
      agent_id: agentId,
      parent_hypothesis_ids: aggregate.direct.map((entry) => entry.id),
      agreement_score: agreementScore,
      disagreement_score: disagreementScore,
      confidence_score: confidenceScore,
      conflict_notes: item.conflict_notes ?? null,
      hypothesis,
      status,
      suppression_reason: suppressionReason,
      linked_proposal_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const validation = validateSynthesizedBelief(synthesized);
    if (validation.ok) {
      beliefs.push(synthesized);
    }
  }

  if (beliefs.length === 0) {
    throw new Error("synthesis_llm_produced_no_valid_beliefs");
  }

  return promoteCasePrimaryBeliefs(beliefs);
}

async function upsertSynthesizedBelief(belief: CaseAwareSynthesizedBelief) {
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
    const errors: string[] = [];
    await runWithConcurrency(runs, runConcurrency, async (run) => {
      const directHypotheses = await fetchDirectHypotheses(run.id);
      const scenarioPaths = await fetchScenarioPaths(run.id);
      if (directHypotheses.length === 0 || scenarioPaths.length === 0) {
        return;
      }

      try {
        if (mode !== "llm" || !llmClient) {
          throw new Error("synthesis_agent_requires_llm_mode");
        }

        const aggregates = collectCandidates(directHypotheses, scenarioPaths);
        const beliefs = await synthesizeWithLlm(run.id, aggregates);

        for (const belief of beliefs) {
          await upsertSynthesizedBelief(belief);
        }
      } catch (error) {
        errors.push(`${run.id}:${String(error)}`);
        app.log.error({ run_id: run.id, error: String(error) }, "synthesis_agent_failed_to_process_run");
      }
    });
    lastTickAt = new Date().toISOString();
    lastTickError = errors.length > 0 ? errors.join(" | ").slice(0, 4_000) : null;
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
