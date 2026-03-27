import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabasePool, ensureCoreSchema, parseJsonField, toIsoTimestamp } from "@automakit/persistence";
import { validateResolutionSpec, type ResolutionSpec } from "@automakit/sdk-types";
import {
  type BeliefHypothesisProposal,
  normalizeAllowedDomainsFromUrl,
  type SynthesizedBelief,
} from "@automakit/world-sim";

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

type ApprovalCaseRow = {
  id: string;
  belief_id: string;
  run_id: string;
  status: "pending" | "approved" | "rejected" | "quarantined" | "proposed";
  quorum_required: number;
  min_approvals: number;
  approve_count: number;
  reject_count: number;
  quarantine_count: number;
  risk_veto: boolean;
  linked_proposal_id: string | null;
  last_reason: string | null;
  created_at: unknown;
  updated_at: unknown;
};

type ApprovalVoteRow = {
  id: string;
  case_id: string;
  belief_id: string;
  run_id: string;
  agent_id: string;
  decision: "approve" | "reject" | "quarantine";
  resolvability_score: unknown;
  ambiguity_score: unknown;
  manipulation_risk_score: unknown;
  reasons: unknown;
  created_at: unknown;
};

const port = Number(process.env.APPROVAL_AGENT_PORT ?? 4014);
const agentId = process.env.APPROVAL_AGENT_ID ?? "approval-core";
const intervalMs = Number(process.env.APPROVAL_AGENT_INTERVAL_MS ?? 1000);
const batchSize = Number(process.env.APPROVAL_AGENT_BATCH_SIZE ?? 20);
const quorumRequired = Math.max(1, Number(process.env.APPROVAL_QUORUM_REQUIRED ?? 3));
const minApprovals = Math.max(1, Number(process.env.APPROVAL_MIN_APPROVALS ?? 2));
const maxAmbiguity = Math.min(1, Math.max(0, Number(process.env.APPROVAL_MAX_AMBIGUITY ?? 0.35)));
const minResolvability = Math.min(1, Math.max(0, Number(process.env.APPROVAL_MIN_RESOLVABILITY ?? 0.65)));
const maxManipulationRisk = Math.min(1, Math.max(0, Number(process.env.APPROVAL_MAX_MANIPULATION_RISK ?? 0.45)));

const app = Fastify({ logger: true });
const pool = createDatabasePool();

let tickInFlight = false;
let lastTickAt: string | null = null;
let lastTickError: string | null = null;

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

function mapApprovalCaseRow(row: ApprovalCaseRow) {
  return {
    id: row.id,
    belief_id: row.belief_id,
    run_id: row.run_id,
    status: row.status,
    quorum_required: Number(row.quorum_required),
    min_approvals: Number(row.min_approvals),
    approve_count: Number(row.approve_count),
    reject_count: Number(row.reject_count),
    quarantine_count: Number(row.quarantine_count),
    risk_veto: Boolean(row.risk_veto),
    linked_proposal_id: row.linked_proposal_id,
    last_reason: row.last_reason,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  };
}

function mapApprovalVoteRow(row: ApprovalVoteRow) {
  return {
    id: row.id,
    case_id: row.case_id,
    belief_id: row.belief_id,
    run_id: row.run_id,
    agent_id: row.agent_id,
    decision: row.decision,
    resolvability_score: Number(row.resolvability_score),
    ambiguity_score: Number(row.ambiguity_score),
    manipulation_risk_score: Number(row.manipulation_risk_score),
    reasons: parseJsonField(row.reasons),
    created_at: toIsoTimestamp(row.created_at),
  };
}

type DbClient = {
  query: typeof pool.query;
};

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function normalizeHost(value: string) {
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

function hostMatchesAllowedDomains(hostname: string, allowedDomains: string[]) {
  const normalizedHost = hostname.toLowerCase();
  return allowedDomains.some((domain) => {
    const normalizedDomain = domain.toLowerCase().replace(/^www\./, "");
    return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
  });
}

function scoreBelief(belief: SynthesizedBelief, resolutionSpec: ResolutionSpec) {
  const confidence = clamp(Number(belief.hypothesis.confidence_score));
  const agreement = clamp(Number(belief.agreement_score));
  const disagreement = clamp(Number(belief.disagreement_score));
  const sourceHost = normalizeHost(resolutionSpec.source.canonical_url);
  const allowedDomains = resolutionSpec.source.allowed_domains.length > 0
    ? resolutionSpec.source.allowed_domains
    : normalizeAllowedDomainsFromUrl(resolutionSpec.source.canonical_url);
  const sourceRisk = hostMatchesAllowedDomains(sourceHost, allowedDomains) ? 0 : 1;
  const resolvabilityScore = clamp(confidence * 0.45 + agreement * 0.35 + (belief.hypothesis.machine_resolvable ? 0.2 : 0));
  const ambiguityScore = clamp(disagreement * 0.7 + (1 - confidence) * 0.3);
  const manipulationRiskScore = clamp((1 - agreement) * 0.35 + (1 - confidence) * 0.35 + sourceRisk * 0.3);

  return {
    resolvabilityScore,
    ambiguityScore,
    manipulationRiskScore,
  };
}

function decideVote(input: {
  belief: SynthesizedBelief;
  resolutionSpec: ResolutionSpec | null;
  validationErrors: string[];
}) {
  if (!input.resolutionSpec || input.validationErrors.length > 0) {
    return {
      decision: "quarantine" as const,
      resolvabilityScore: 0,
      ambiguityScore: 1,
      manipulationRiskScore: 1,
      reasons: {
        decision_reason: "hard_failure",
        errors: input.validationErrors,
      },
    };
  }

  const scored = scoreBelief(input.belief, input.resolutionSpec);
  if (scored.manipulationRiskScore > maxManipulationRisk) {
    return {
      decision: "quarantine" as const,
      ...scored,
      reasons: {
        decision_reason: "risk_veto",
        max_manipulation_risk: maxManipulationRisk,
      },
    };
  }

  if (scored.resolvabilityScore < minResolvability || scored.ambiguityScore > maxAmbiguity) {
    return {
      decision: "reject" as const,
      ...scored,
      reasons: {
        decision_reason: "low_quality",
        min_resolvability: minResolvability,
        max_ambiguity: maxAmbiguity,
      },
    };
  }

  return {
    decision: "approve" as const,
    ...scored,
    reasons: {
      decision_reason: "approved",
      min_resolvability: minResolvability,
      max_ambiguity: maxAmbiguity,
      max_manipulation_risk: maxManipulationRisk,
    },
  };
}

async function fetchCandidateBeliefs(limit: number) {
  const result = await pool.query<SynthesizedBeliefRow>(
    `
      SELECT beliefs.*
      FROM synthesized_beliefs beliefs
      LEFT JOIN listing_approval_cases cases
        ON cases.belief_id = beliefs.id
      WHERE beliefs.status = 'new'
        AND beliefs.hypothesis->>'machine_resolvable' = 'true'
        AND beliefs.linked_proposal_id IS NULL
        AND COALESCE(cases.status, 'pending') = 'pending'
      ORDER BY beliefs.created_at ASC, beliefs.id ASC
      LIMIT $1
    `,
    [limit],
  );

  return result.rows.map(mapSynthesizedBeliefRow);
}

async function ensureApprovalCase(client: DbClient, belief: SynthesizedBelief) {
  const result = await client.query<ApprovalCaseRow>(
    `
      INSERT INTO listing_approval_cases (
        id,
        belief_id,
        run_id,
        status,
        quorum_required,
        min_approvals,
        approve_count,
        reject_count,
        quarantine_count,
        risk_veto,
        linked_proposal_id,
        last_reason,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, 'pending', $4, $5, 0, 0, 0, FALSE, NULL, NULL, NOW(), NOW())
      ON CONFLICT (belief_id) DO UPDATE SET
        updated_at = NOW()
      RETURNING *
    `,
    [randomUUID(), belief.id, belief.run_id, quorumRequired, minApprovals],
  );

  return mapApprovalCaseRow(result.rows[0]);
}

async function insertVote(
  client: DbClient,
  approvalCase: ReturnType<typeof mapApprovalCaseRow>,
  belief: SynthesizedBelief,
  decision: ReturnType<typeof decideVote>,
) {
  await client.query(
    `
      INSERT INTO listing_approval_votes (
        id,
        case_id,
        belief_id,
        run_id,
        agent_id,
        decision,
        resolvability_score,
        ambiguity_score,
        manipulation_risk_score,
        reasons,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW())
      ON CONFLICT (case_id, agent_id) DO NOTHING
    `,
    [
      randomUUID(),
      approvalCase.id,
      belief.id,
      belief.run_id,
      agentId,
      decision.decision,
      decision.resolvabilityScore,
      decision.ambiguityScore,
      decision.manipulationRiskScore,
      JSON.stringify(decision.reasons),
    ],
  );
}

async function reconcileCase(client: DbClient, caseId: string) {
  const aggregate = await client.query<{
    approve_count: string;
    reject_count: string;
    quarantine_count: string;
    risk_veto: boolean;
    last_reason: string | null;
    vote_count: string;
  }>(
    `
      SELECT
        COUNT(*) FILTER (WHERE decision = 'approve')::text AS approve_count,
        COUNT(*) FILTER (WHERE decision = 'reject')::text AS reject_count,
        COUNT(*) FILTER (WHERE decision = 'quarantine')::text AS quarantine_count,
        BOOL_OR(COALESCE((reasons->>'decision_reason') = 'risk_veto', FALSE)) AS risk_veto,
        (
          SELECT reasons::text
          FROM listing_approval_votes votes
          WHERE votes.case_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) AS last_reason,
        COUNT(*)::text AS vote_count
      FROM listing_approval_votes
      WHERE case_id = $1
    `,
    [caseId],
  );

  const counts = aggregate.rows[0] ?? {
    approve_count: "0",
    reject_count: "0",
    quarantine_count: "0",
    risk_veto: false,
    last_reason: null,
    vote_count: "0",
  };
  const approveCount = Number(counts.approve_count);
  const rejectCount = Number(counts.reject_count);
  const quarantineCount = Number(counts.quarantine_count);
  const voteCount = Number(counts.vote_count);
  const riskVeto = Boolean(counts.risk_veto) || quarantineCount > 0;

  let nextStatus: ApprovalCaseRow["status"] = "pending";
  if (quarantineCount > 0 || riskVeto) {
    nextStatus = "quarantined";
  } else if (voteCount >= quorumRequired && approveCount >= minApprovals) {
    nextStatus = "approved";
  } else if (voteCount >= quorumRequired && approveCount < minApprovals) {
    nextStatus = "rejected";
  }

  const updated = await client.query<ApprovalCaseRow>(
    `
      UPDATE listing_approval_cases
      SET
        status = $2,
        approve_count = $3,
        reject_count = $4,
        quarantine_count = $5,
        risk_veto = $6,
        last_reason = $7,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [
      caseId,
      nextStatus,
      approveCount,
      rejectCount,
      quarantineCount,
      riskVeto,
      counts.last_reason,
    ],
  );

  return mapApprovalCaseRow(updated.rows[0]);
}

async function processBelief(belief: SynthesizedBelief) {
  const resolutionSpecCandidate = belief.hypothesis.suggested_resolution_spec ?? null;
  const validation = resolutionSpecCandidate ? validateResolutionSpec(resolutionSpecCandidate) : { ok: false as const, errors: ["missing_resolution_spec"] };
  const resolutionSpec = validation.ok ? validation.spec : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const approvalCase = await ensureApprovalCase(client, belief);
    if (approvalCase.status !== "pending") {
      await client.query("COMMIT");
      return;
    }

    const decision = decideVote({
      belief,
      resolutionSpec,
      validationErrors: validation.ok ? [] : validation.errors,
    });
    await insertVote(client, approvalCase, belief, decision);
    const updatedCase = await reconcileCase(client, approvalCase.id);

    app.log.info(
      {
        belief_id: belief.id,
        case_status: updatedCase.status,
        approve_count: updatedCase.approve_count,
        reject_count: updatedCase.reject_count,
        quarantine_count: updatedCase.quarantine_count,
      },
      "approval_case_reconciled",
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
    const beliefs = await fetchCandidateBeliefs(batchSize);
    for (const belief of beliefs) {
      try {
        await processBelief(belief);
      } catch (error) {
        app.log.error({ error: String(error), belief_id: belief.id }, "approval_agent_failed_to_process_belief");
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
  service: "approval-agent",
  status: "ok",
  agent_id: agentId,
  last_tick_at: lastTickAt,
  last_tick_error: lastTickError,
}));

app.get("/v1/internal/listing-approval-cases", async (request) => {
  const limit = Math.max(1, Math.min(200, Number((request.query as { limit?: string }).limit ?? "50") || 50));
  const result = await pool.query<ApprovalCaseRow>(
    `
      SELECT *
      FROM listing_approval_cases
      ORDER BY created_at DESC, id DESC
      LIMIT $1
    `,
    [limit],
  );

  return {
    items: result.rows.map(mapApprovalCaseRow),
  };
});

app.get("/v1/internal/listing-approval-votes", async (request) => {
  const limit = Math.max(1, Math.min(200, Number((request.query as { limit?: string }).limit ?? "50") || 50));
  const result = await pool.query<ApprovalVoteRow>(
    `
      SELECT *
      FROM listing_approval_votes
      ORDER BY created_at DESC, id DESC
      LIMIT $1
    `,
    [limit],
  );

  return {
    items: result.rows.map(mapApprovalVoteRow),
  };
});

app.post("/v1/internal/approval-agent/run-once", async () => {
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
