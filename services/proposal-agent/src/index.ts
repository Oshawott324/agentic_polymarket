import Fastify from "fastify";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabasePool, ensureCoreSchema, parseJsonField, toIsoTimestamp } from "@automakit/persistence";
import type { ResolutionSpec } from "@automakit/sdk-types";
import {
  normalizeAllowedDomainsFromUrl,
  type BeliefHypothesisProposal,
  type ProposalCandidate,
  type SynthesizedBelief,
} from "@automakit/world-sim";

type SynthesizedBeliefRow = {
  id: string;
  run_id: string;
  agent_id: string;
  approval_case_id: string;
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

type ApprovedSynthesizedBelief = SynthesizedBelief & {
  approval_case_id: string;
};

const port = Number(process.env.PROPOSAL_AGENT_PORT ?? 4012);
const proposalPipelineUrl = process.env.PROPOSAL_PIPELINE_URL ?? "http://localhost:4005";
const proposalAgentId = process.env.PROPOSAL_AGENT_ID ?? "automation-proposal-agent";
const intervalMs = Number(process.env.PROPOSAL_AGENT_INTERVAL_MS ?? 1000);
const batchSize = Number(process.env.PROPOSAL_AGENT_BATCH_SIZE ?? 50);
const beliefConcurrency = Math.max(1, Number(process.env.PROPOSAL_AGENT_BELIEF_CONCURRENCY ?? 8));
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

function mapApprovedSynthesizedBeliefRow(row: SynthesizedBeliefRow): ApprovedSynthesizedBelief {
  return {
    ...mapSynthesizedBeliefRow(row),
    approval_case_id: row.approval_case_id,
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

function operatorPhrase(operator: "gt" | "gte" | "lt" | "lte") {
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

function buildPriceThresholdCandidate(belief: SynthesizedBelief, resolutionSpec: ResolutionSpec): ProposalCandidate {
  if (resolutionSpec.kind !== "price_threshold") {
    throw new Error("belief_resolution_kind_mismatch");
  }

  const threshold = resolutionSpec.decision_rule.threshold;
  const operator = resolutionSpec.decision_rule.operator;
  const thresholdLabel = formatThreshold(threshold);
  const dateLabel = formatDateLabel(belief.hypothesis.target_time);
  const asset = belief.hypothesis.subject;

  return {
    title: `Will ${asset} trade ${operatorPhrase(operator)} $${thresholdLabel} by ${dateLabel}?`,
    category: belief.hypothesis.category,
    close_time: belief.hypothesis.target_time,
    resolution_criteria: `Resolve YES if ${asset} spot price trades ${operatorPhrase(operator)} $${thresholdLabel} on or before ${dateLabel} using ${resolutionSpec.source.canonical_url}.`,
    resolution_spec: {
      ...resolutionSpec,
      source: {
        ...resolutionSpec.source,
        allowed_domains: normalizeAllowedDomainsFromUrl(resolutionSpec.source.canonical_url),
      },
    },
    dedupe_key: belief.hypothesis.dedupe_key,
    source_belief_id: belief.id,
  };
}

function buildRateDecisionCandidate(belief: SynthesizedBelief, resolutionSpec: ResolutionSpec): ProposalCandidate {
  if (resolutionSpec.kind !== "rate_decision") {
    throw new Error("belief_resolution_kind_mismatch");
  }

  const direction = resolutionSpec.decision_rule.direction;
  const verb = direction === "hold" ? "hold rates" : direction === "hike" ? "hike rates" : "cut rates";
  const dateLabel = formatDateLabel(belief.hypothesis.target_time);
  const institution = belief.hypothesis.subject;

  return {
    title: `Will ${institution} ${verb} by ${dateLabel}?`,
    category: belief.hypothesis.category,
    close_time: belief.hypothesis.target_time,
    resolution_criteria: `Resolve YES if ${institution} ${verb} on or before ${dateLabel} using ${resolutionSpec.source.canonical_url}.`,
    resolution_spec: {
      ...resolutionSpec,
      source: {
        ...resolutionSpec.source,
        allowed_domains: normalizeAllowedDomainsFromUrl(resolutionSpec.source.canonical_url),
      },
    },
    dedupe_key: belief.hypothesis.dedupe_key,
    source_belief_id: belief.id,
  };
}

function buildEventOccurrenceCandidate(belief: SynthesizedBelief, resolutionSpec: ResolutionSpec): ProposalCandidate {
  if (resolutionSpec.kind !== "event_occurrence") {
    throw new Error("belief_resolution_kind_mismatch");
  }

  const dateLabel = formatDateLabel(belief.hypothesis.target_time);
  const subject = belief.hypothesis.subject;
  const predicate = belief.hypothesis.predicate.replace(/\s+by target date$/i, "").trim();
  const readablePredicate = predicate.length > 0 ? predicate : `${subject} will occur`;

  return {
    title: `Will ${subject} occur by ${dateLabel}?`,
    category: belief.hypothesis.category,
    close_time: belief.hypothesis.target_time,
    resolution_criteria: `Resolve YES if ${readablePredicate} by ${dateLabel} using ${resolutionSpec.source.canonical_url}.`,
    resolution_spec: {
      ...resolutionSpec,
      source: {
        ...resolutionSpec.source,
        allowed_domains: normalizeAllowedDomainsFromUrl(resolutionSpec.source.canonical_url),
      },
    },
    dedupe_key: belief.hypothesis.dedupe_key,
    source_belief_id: belief.id,
  };
}

function buildProposalCandidate(belief: SynthesizedBelief) {
  const resolutionSpec = belief.hypothesis.suggested_resolution_spec;
  if (!belief.hypothesis.machine_resolvable || !resolutionSpec) {
    throw new Error("belief_not_machine_resolvable");
  }

  switch (resolutionSpec.kind) {
    case "price_threshold":
      return buildPriceThresholdCandidate(belief, resolutionSpec);
    case "rate_decision":
      return buildRateDecisionCandidate(belief, resolutionSpec);
    case "event_occurrence":
      return buildEventOccurrenceCandidate(belief, resolutionSpec);
    default:
      throw new Error("belief_resolution_kind_unsupported");
  }
}

async function fetchApprovedBeliefs(limit: number) {
  const result = await pool.query<SynthesizedBeliefRow>(
    `
      SELECT
        beliefs.*,
        cases.id AS approval_case_id
      FROM synthesized_beliefs beliefs
      INNER JOIN listing_approval_cases cases
        ON cases.belief_id = beliefs.id
      WHERE (
        (
          beliefs.status = 'new'
          AND cases.status = 'approved'
          AND cases.linked_proposal_id IS NULL
          AND beliefs.linked_proposal_id IS NULL
        )
        OR (
          beliefs.status = 'proposed'
          AND cases.status = 'proposed'
          AND beliefs.linked_proposal_id IS NOT NULL
          AND cases.linked_proposal_id = beliefs.linked_proposal_id
        )
      )
      ORDER BY beliefs.updated_at DESC, beliefs.created_at DESC, beliefs.id DESC
      LIMIT $1
    `,
    [limit],
  );

  return result.rows.map(mapApprovedSynthesizedBeliefRow);
}

async function updateBeliefStatus(
  beliefId: string,
  status: SynthesizedBelief["status"],
  options: { reason?: string | null; proposalId?: string | null } = {},
) {
  await pool.query(
    `
      UPDATE synthesized_beliefs
      SET
        status = $2,
        suppression_reason = COALESCE($3, suppression_reason),
        linked_proposal_id = COALESCE($4, linked_proposal_id),
        updated_at = NOW()
      WHERE id = $1
    `,
    [beliefId, status, options.reason ?? null, options.proposalId ?? null],
  );
}

async function submitProposal(belief: SynthesizedBelief) {
  const proposal = buildProposalCandidate(belief);
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
      signal_source_id: proposal.source_belief_id,
      signal_source_type: "agent",
    }),
  });

  const payload = (await response.json()) as { id?: string; error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `proposal_submission_failed:${response.status}`);
  }

  return payload.id ?? null;
}

async function fetchProposalStatus(proposalId: string) {
  const response = await fetch(`${proposalPipelineUrl}/v1/market-proposals/${proposalId}`);
  if (!response.ok) {
    throw new Error(`proposal_lookup_failed:${response.status}`);
  }

  const payload = (await response.json()) as { status?: "queued" | "published" | "suppressed" };
  return payload.status ?? null;
}

async function markBeliefAndCaseProposed(belief: ApprovedSynthesizedBelief, proposalId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        UPDATE synthesized_beliefs
        SET
          status = 'proposed',
          linked_proposal_id = $2,
          updated_at = NOW()
        WHERE id = $1
      `,
      [belief.id, proposalId],
    );
    await client.query(
      `
        UPDATE listing_approval_cases
        SET
          status = 'proposed',
          linked_proposal_id = $2,
          last_reason = $3,
          updated_at = NOW()
        WHERE id = $1
      `,
      [belief.approval_case_id, proposalId, `proposal_published:${proposalId}`],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function tick() {
  if (tickInFlight) {
    return;
  }

  tickInFlight = true;
  try {
    const beliefs = await fetchApprovedBeliefs(batchSize);
    const errors: string[] = [];
    await runWithConcurrency(beliefs, beliefConcurrency, async (belief) => {
      try {
        if (belief.linked_proposal_id) {
          const currentStatus = await fetchProposalStatus(belief.linked_proposal_id);
          if (currentStatus === "published") {
            return;
          }
        }

        const proposalId = await submitProposal(belief);
        if (proposalId) {
          if (belief.linked_proposal_id) {
            await updateBeliefStatus(belief.id, "proposed", { proposalId });
          } else {
            await markBeliefAndCaseProposed(belief, proposalId);
          }
        } else {
          await updateBeliefStatus(belief.id, "suppressed", { reason: "proposal_missing_id" });
        }
      } catch (error) {
        if (
          String(error).includes("belief_not_machine_resolvable") ||
          String(error).includes("belief_resolution_kind_unsupported") ||
          String(error).includes("belief_resolution_kind_mismatch")
        ) {
          await updateBeliefStatus(belief.id, "suppressed", { reason: String(error) });
          return;
        }

        errors.push(`${belief.id}:${String(error)}`);
        app.log.error(error);
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
  service: "proposal-agent",
  status: "ok",
  proposal_agent_id: proposalAgentId,
  last_tick_at: lastTickAt,
  last_tick_error: lastTickError,
}));

app.get("/v1/internal/proposal-agent/candidates", async () => {
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

app.post("/v1/internal/proposal-agent/run-once", async () => {
  await tick();
  return { status: "ok", last_tick_at: lastTickAt, last_tick_error: lastTickError };
});

async function start() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await ensureCoreSchema(pool);
      break;
    } catch (error) {
      if (attempt === 19) {
        throw error;
      }
      await delay(250);
    }
  }
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
