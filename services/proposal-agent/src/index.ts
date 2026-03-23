import Fastify from "fastify";
import { createDatabasePool, ensureCoreSchema, parseJsonField, toIsoTimestamp } from "@automakit/persistence";
import type { ResolutionSpec } from "@automakit/sdk-types";
import {
  normalizeAllowedDomainsFromUrl,
  type PriceThresholdHypothesisMetadata,
  type RateDecisionHypothesisMetadata,
  type SuggestedResolutionMetadata,
  type WorldHypothesis,
} from "@automakit/world-sim";

type WorldHypothesisRow = {
  id: string;
  source_signal_ids: unknown;
  category: string;
  subject: string;
  predicate: string;
  target_time: unknown;
  confidence_score: unknown;
  reasoning_summary: string;
  machine_resolvable: boolean;
  suggested_resolution_kind: "price_threshold" | "rate_decision" | null;
  suggested_resolution_source_url: string | null;
  suggested_resolution_metadata: unknown;
  status: WorldHypothesis["status"];
  suppression_reason: string | null;
  linked_proposal_id: string | null;
  dedupe_key: string;
  created_at: unknown;
  updated_at: unknown;
};

const port = Number(process.env.PROPOSAL_AGENT_PORT ?? 4012);
const proposalPipelineUrl = process.env.PROPOSAL_PIPELINE_URL ?? "http://localhost:4005";
const proposalAgentId = process.env.PROPOSAL_AGENT_ID ?? "automation-proposal-agent";
const intervalMs = Number(process.env.PROPOSAL_AGENT_INTERVAL_MS ?? 1000);
const batchSize = Number(process.env.PROPOSAL_AGENT_BATCH_SIZE ?? 50);
const app = Fastify({ logger: true });
const pool = createDatabasePool();

let tickInFlight = false;
let lastTickAt: string | null = null;
let lastTickError: string | null = null;

function mapHypothesisRow(row: WorldHypothesisRow): WorldHypothesis {
  return {
    id: row.id,
    source_signal_ids: parseJsonField<string[]>(row.source_signal_ids),
    category: row.category,
    subject: row.subject,
    predicate: row.predicate,
    target_time: toIsoTimestamp(row.target_time),
    confidence_score: Number(row.confidence_score),
    reasoning_summary: row.reasoning_summary,
    machine_resolvable: Boolean(row.machine_resolvable),
    suggested_resolution_kind: row.suggested_resolution_kind ?? undefined,
    suggested_resolution_source_url: row.suggested_resolution_source_url ?? undefined,
    suggested_resolution_metadata: row.suggested_resolution_metadata
      ? parseJsonField<SuggestedResolutionMetadata>(row.suggested_resolution_metadata)
      : undefined,
    status: row.status,
    suppression_reason: row.suppression_reason,
    linked_proposal_id: row.linked_proposal_id,
    dedupe_key: row.dedupe_key,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  };
}

function formatDateLabel(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(value));
}

function formatThreshold(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function operatorPhrase(operator: PriceThresholdHypothesisMetadata["operator"]) {
  switch (operator) {
    case "gte":
      return "at or above";
    case "lt":
      return "below";
    case "lte":
      return "at or below";
    case "gt":
    default:
      return "above";
  }
}

function buildPriceThresholdCandidate(hypothesis: WorldHypothesis, metadata: PriceThresholdHypothesisMetadata) {
  const allowedDomains = normalizeAllowedDomainsFromUrl(metadata.canonical_source_url);
  const thresholdLabel = formatThreshold(metadata.threshold);
  const dateLabel = formatDateLabel(hypothesis.target_time);
  const resolutionSpec: ResolutionSpec = {
    kind: "price_threshold",
    source: {
      adapter: "http_json",
      canonical_url: metadata.canonical_source_url,
      allowed_domains: allowedDomains,
    },
    observation_schema: {
      type: "object",
      fields: {
        price: {
          type: "number",
          path: "price",
        },
        observed_at: {
          type: "string",
          path: "observed_at",
          required: false,
        },
      },
    },
    decision_rule: {
      kind: "price_threshold",
      observation_field: "price",
      operator: metadata.operator,
      threshold: metadata.threshold,
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

  return {
    title: `Will ${metadata.asset_symbol} trade ${operatorPhrase(metadata.operator)} $${thresholdLabel} by ${dateLabel}?`,
    category: metadata.category,
    close_time: hypothesis.target_time,
    resolution_criteria: `Resolve YES if ${metadata.asset_symbol} spot price trades ${operatorPhrase(
      metadata.operator,
    )} $${thresholdLabel} on or before ${dateLabel} using ${metadata.canonical_source_url}.`,
    resolution_spec: resolutionSpec,
  };
}

function buildRateDecisionCandidate(hypothesis: WorldHypothesis, metadata: RateDecisionHypothesisMetadata) {
  const allowedDomains = normalizeAllowedDomainsFromUrl(metadata.canonical_source_url);
  const dateLabel = formatDateLabel(hypothesis.target_time);
  const verb =
    metadata.direction === "hold" ? "hold rates" : metadata.direction === "hike" ? "hike rates" : "cut rates";
  const resolutionSpec: ResolutionSpec = {
    kind: "rate_decision",
    source: {
      adapter: "http_json",
      canonical_url: metadata.canonical_source_url,
      allowed_domains: allowedDomains,
    },
    observation_schema: {
      type: "object",
      fields: {
        previous_upper_bound_bps: {
          type: "number",
          path: "previous_upper_bound_bps",
        },
        current_upper_bound_bps: {
          type: "number",
          path: "current_upper_bound_bps",
        },
        observed_at: {
          type: "string",
          path: "observed_at",
          required: false,
        },
      },
    },
    decision_rule: {
      kind: "rate_decision",
      previous_field: "previous_upper_bound_bps",
      current_field: "current_upper_bound_bps",
      direction: metadata.direction,
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

  return {
    title: `Will ${metadata.institution} ${verb} by ${dateLabel}?`,
    category: metadata.category,
    close_time: hypothesis.target_time,
    resolution_criteria: `Resolve YES if ${metadata.institution} ${verb} on or before ${dateLabel} using ${metadata.canonical_source_url}.`,
    resolution_spec: resolutionSpec,
  };
}

function buildProposalCandidate(hypothesis: WorldHypothesis) {
  if (!hypothesis.machine_resolvable) {
    throw new Error("hypothesis_not_machine_resolvable");
  }
  if (!hypothesis.suggested_resolution_kind || !hypothesis.suggested_resolution_metadata) {
    throw new Error("hypothesis_missing_resolution_metadata");
  }

  const base =
    hypothesis.suggested_resolution_kind === "price_threshold"
      ? buildPriceThresholdCandidate(
          hypothesis,
          hypothesis.suggested_resolution_metadata as PriceThresholdHypothesisMetadata,
        )
      : hypothesis.suggested_resolution_kind === "rate_decision"
        ? buildRateDecisionCandidate(
            hypothesis,
            hypothesis.suggested_resolution_metadata as RateDecisionHypothesisMetadata,
          )
        : null;

  if (!base) {
    throw new Error("hypothesis_resolution_kind_unsupported");
  }

  return {
    ...base,
    dedupe_key: hypothesis.dedupe_key,
  };
}

async function fetchNewHypotheses(limit: number) {
  const result = await pool.query<WorldHypothesisRow>(
    `
      SELECT *
      FROM world_hypotheses
      WHERE status = 'new'
      ORDER BY created_at ASC, id ASC
      LIMIT $1
    `,
    [limit],
  );

  return result.rows.map(mapHypothesisRow);
}

async function suppressHypothesis(hypothesisId: string, reason: string) {
  await pool.query(
    `
      UPDATE world_hypotheses
      SET
        status = 'suppressed',
        suppression_reason = $2,
        updated_at = NOW()
      WHERE id = $1
    `,
    [hypothesisId, reason],
  );
}

async function markHypothesisProposed(hypothesisId: string, proposalId: string | null) {
  await pool.query(
    `
      UPDATE world_hypotheses
      SET
        status = 'proposed',
        linked_proposal_id = COALESCE($2, linked_proposal_id),
        updated_at = NOW()
      WHERE id = $1
    `,
    [hypothesisId, proposalId],
  );
}

async function submitProposal(hypothesis: WorldHypothesis) {
  const proposal = buildProposalCandidate(hypothesis);
  const response = await fetch(`${proposalPipelineUrl}/v1/market-proposals`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer automation-worker",
      "idempotency-key": proposal.dedupe_key,
    },
    body: JSON.stringify({
      proposer_agent_id: proposalAgentId,
      title: proposal.title,
      category: proposal.category,
      close_time: proposal.close_time,
      resolution_criteria: proposal.resolution_criteria,
      resolution_spec: proposal.resolution_spec,
      dedupe_key: proposal.dedupe_key,
      origin: "automation",
      signal_source_id: hypothesis.id,
      signal_source_type: "agent",
    }),
  });

  const payload = (await response.json()) as { id?: string; error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `proposal_submission_failed:${response.status}`);
  }

  return payload.id ?? null;
}

async function tick() {
  if (tickInFlight) {
    return;
  }

  tickInFlight = true;
  try {
    const hypotheses = await fetchNewHypotheses(batchSize);
    for (const hypothesis of hypotheses) {
      try {
        const proposalId = await submitProposal(hypothesis);
        await markHypothesisProposed(hypothesis.id, proposalId);
      } catch (error) {
        if (
          String(error).includes("hypothesis_not_machine_resolvable") ||
          String(error).includes("hypothesis_missing_resolution_metadata") ||
          String(error).includes("hypothesis_resolution_kind_unsupported")
        ) {
          await suppressHypothesis(hypothesis.id, String(error));
          continue;
        }

        app.log.error(error);
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
  service: "proposal-agent",
  status: "ok",
  proposal_agent_id: proposalAgentId,
  last_tick_at: lastTickAt,
  last_tick_error: lastTickError,
}));

app.post("/v1/internal/proposal-agent/run-once", async () => {
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
