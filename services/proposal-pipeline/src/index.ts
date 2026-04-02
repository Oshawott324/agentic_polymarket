import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { createDatabasePool, ensureCoreSchema, parseJsonField, toIsoTimestamp } from "@automakit/persistence";
import {
  type ResolutionKind,
  type ResolutionSpec,
  validateResolutionSpec,
} from "@automakit/sdk-types";

type Proposal = {
  id: string;
  proposer_agent_id: string;
  title: string;
  category: string;
  close_time: string;
  resolution_criteria: string;
  resolution_spec: ResolutionSpec;
  source_of_truth_url: string;
  resolution_kind: ResolutionKind;
  resolution_metadata: ResolutionSpec["decision_rule"];
  dedupe_key: string;
  semantic_dedupe_key?: string;
  origin: "agent" | "automation";
  signal_source_id?: string;
  signal_source_type?: "calendar" | "news" | "agent";
  status: "queued" | "published" | "suppressed";
  confidence_score: number;
  observation_count: number;
  autonomy_note: string;
  linked_market_id?: string;
  created_at: string;
};

type ProposalRow = {
  id: string;
  proposer_agent_id: string;
  title: string;
  category: string;
  close_time: unknown;
  resolution_criteria: string;
  resolution_spec: unknown;
  source_of_truth_url: string;
  resolution_kind: ResolutionKind;
  resolution_metadata: unknown;
  dedupe_key: string;
  semantic_dedupe_key: string | null;
  origin: Proposal["origin"];
  signal_source_id: string | null;
  signal_source_type: Proposal["signal_source_type"] | null;
  status: Proposal["status"];
  confidence_score: number;
  observation_count: number;
  autonomy_note: string;
  linked_market_id: string | null;
  created_at: unknown;
};

const port = Number(process.env.PROPOSAL_PIPELINE_PORT ?? 4005);
const app = Fastify({ logger: true });
const pool = createDatabasePool();
const marketServiceUrl = process.env.MARKET_SERVICE_URL ?? "http://localhost:4003";
const autoPublishThreshold = Math.max(0, Math.min(1, Number(process.env.PROPOSAL_AUTO_PUBLISH_THRESHOLD ?? 0.7)));
const autoQueueThreshold = Math.max(0, Math.min(1, Number(process.env.PROPOSAL_AUTO_QUEUE_THRESHOLD ?? 0.45)));
const semanticDuplicateWindowHours = Math.max(6, Number(process.env.PROPOSAL_SEMANTIC_DUP_WINDOW_HOURS ?? 72));
const semanticPriceThresholdTolerance = Math.max(0.001, Number(process.env.PROPOSAL_SEMANTIC_PRICE_REL_TOLERANCE ?? 0.025));
const semanticTitleSimilarityThreshold = Math.max(0.2, Math.min(1, Number(process.env.PROPOSAL_SEMANTIC_TITLE_SIMILARITY ?? 0.45)));

function mapProposalRow(row: ProposalRow): Proposal {
  return {
    id: row.id,
    proposer_agent_id: row.proposer_agent_id,
    title: row.title,
    category: row.category,
    close_time: toIsoTimestamp(row.close_time),
    resolution_criteria: row.resolution_criteria,
    resolution_spec: parseJsonField<ResolutionSpec>(row.resolution_spec),
    source_of_truth_url: row.source_of_truth_url,
    resolution_kind: row.resolution_kind,
    resolution_metadata: parseJsonField<ResolutionSpec["decision_rule"]>(row.resolution_metadata),
    dedupe_key: row.dedupe_key,
    semantic_dedupe_key: row.semantic_dedupe_key ?? undefined,
    origin: row.origin,
    signal_source_id: row.signal_source_id ?? undefined,
    signal_source_type: row.signal_source_type ?? undefined,
    status: row.status,
    confidence_score: Number(row.confidence_score),
    observation_count: Number(row.observation_count),
    autonomy_note: row.autonomy_note,
    linked_market_id: row.linked_market_id ?? undefined,
    created_at: toIsoTimestamp(row.created_at),
  };
}

async function getProposalByDedupeKey(dedupeKey: string) {
  const result = await pool.query<ProposalRow>(
    `
      SELECT *
      FROM proposals
      WHERE dedupe_key = $1
    `,
    [dedupeKey],
  );

  return result.rowCount ? mapProposalRow(result.rows[0]) : null;
}

async function getProposalBySemanticDedupeKey(semanticDedupeKey: string) {
  const result = await pool.query<ProposalRow>(
    `
      SELECT *
      FROM proposals
      WHERE semantic_dedupe_key = $1
    `,
    [semanticDedupeKey],
  );

  return result.rowCount ? mapProposalRow(result.rows[0]) : null;
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string) {
  const stop = new Set(["the", "a", "an", "will", "be", "by", "on", "of", "to", "for", "at"]);
  return normalizeText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !stop.has(token));
}

function jaccardSimilarity(left: string, right: string) {
  const leftSet = new Set(tokenize(left));
  const rightSet = new Set(tokenize(right));
  if (leftSet.size === 0 || rightSet.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function normalizeCanonicalUrl(raw: string) {
  try {
    const url = new URL(raw);
    url.hash = "";
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

function operatorDirection(operator: "gt" | "gte" | "lt" | "lte") {
  return operator === "gt" || operator === "gte" ? "up" : "down";
}

function isCloseTimeNear(leftIso: string, rightIso: string, windowHours: number) {
  const leftMs = new Date(leftIso).getTime();
  const rightMs = new Date(rightIso).getTime();
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) {
    return false;
  }
  return Math.abs(leftMs - rightMs) <= windowHours * 60 * 60 * 1000;
}

function closeTimeDayBucket(closeTimeIso: string) {
  const closeMs = new Date(closeTimeIso).getTime();
  if (!Number.isFinite(closeMs)) {
    return normalizeText(closeTimeIso);
  }
  return new Date(closeMs).toISOString().slice(0, 10);
}

function buildSemanticDedupeKey(input: {
  title: string;
  category: string;
  close_time: string;
  resolution_spec: ResolutionSpec;
}) {
  const category = normalizeText(input.category) || "uncategorized";
  const closeBucket = closeTimeDayBucket(input.close_time);
  const canonicalUrl = normalizeCanonicalUrl(input.resolution_spec.source.canonical_url);

  if (input.resolution_spec.kind === "price_threshold") {
    return [
      "price_threshold",
      category,
      canonicalUrl,
      operatorDirection(input.resolution_spec.decision_rule.operator),
      closeBucket,
    ].join(":");
  }

  if (input.resolution_spec.kind === "rate_decision") {
    return [
      "rate_decision",
      category,
      canonicalUrl,
      input.resolution_spec.decision_rule.direction,
      closeBucket,
    ].join(":");
  }

  return [
    "event_occurrence",
    category,
    canonicalUrl || normalizeText(input.title),
    closeBucket,
  ].join(":");
}

function isSemanticNearDuplicate(existing: Proposal, incoming: {
  title: string;
  category: string;
  close_time: string;
  resolution_spec: ResolutionSpec;
}) {
  if (existing.resolution_kind !== incoming.resolution_spec.kind) {
    return false;
  }
  if (normalizeText(existing.category) !== normalizeText(incoming.category)) {
    return false;
  }

  const titleSimilarity = jaccardSimilarity(existing.title, incoming.title);
  const closeNear = isCloseTimeNear(existing.close_time, incoming.close_time, semanticDuplicateWindowHours);
  if (!closeNear) {
    return false;
  }

  if (incoming.resolution_spec.kind === "price_threshold" && existing.resolution_spec.kind === "price_threshold") {
    const existingSource = normalizeCanonicalUrl(existing.resolution_spec.source.canonical_url);
    const incomingSource = normalizeCanonicalUrl(incoming.resolution_spec.source.canonical_url);
    if (existingSource !== incomingSource) {
      return false;
    }
    if (operatorDirection(existing.resolution_spec.decision_rule.operator) !== operatorDirection(incoming.resolution_spec.decision_rule.operator)) {
      return false;
    }
    const left = Number(existing.resolution_spec.decision_rule.threshold);
    const right = Number(incoming.resolution_spec.decision_rule.threshold);
    if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) {
      return false;
    }
    const relativeDelta = Math.abs(left - right) / Math.max(left, right);
    return relativeDelta <= semanticPriceThresholdTolerance;
  }

  if (incoming.resolution_spec.kind === "rate_decision" && existing.resolution_spec.kind === "rate_decision") {
    const existingSource = normalizeCanonicalUrl(existing.resolution_spec.source.canonical_url);
    const incomingSource = normalizeCanonicalUrl(incoming.resolution_spec.source.canonical_url);
    return (
      existingSource === incomingSource &&
      existing.resolution_spec.decision_rule.direction === incoming.resolution_spec.decision_rule.direction
    );
  }

  return titleSimilarity >= 0.9;
}

async function findSemanticDuplicate(incoming: {
  title: string;
  category: string;
  close_time: string;
  resolution_spec: ResolutionSpec;
}) {
  const result = await pool.query<ProposalRow>(
    `
      SELECT *
      FROM proposals
      WHERE
        resolution_kind = $1
        AND category = $2
        AND close_time BETWEEN ($3::timestamptz - ($4 * INTERVAL '1 hour')) AND ($3::timestamptz + ($4 * INTERVAL '1 hour'))
      ORDER BY created_at DESC, id DESC
      LIMIT 200
    `,
    [incoming.resolution_spec.kind, incoming.category, incoming.close_time, semanticDuplicateWindowHours],
  );

  for (const row of result.rows) {
    const proposal = mapProposalRow(row);
    if (isSemanticNearDuplicate(proposal, incoming)) {
      return proposal;
    }
  }
  return null;
}

async function getProposalById(proposalId: string) {
  const result = await pool.query<ProposalRow>(
    `
      SELECT *
      FROM proposals
      WHERE id = $1
    `,
    [proposalId],
  );

  return result.rowCount ? mapProposalRow(result.rows[0]) : null;
}

async function saveProposal(proposal: Proposal) {
  const updated = await pool.query<ProposalRow>(
    `
      UPDATE proposals
      SET
        proposer_agent_id = $2,
        title = $3,
        category = $4,
        close_time = $5::timestamptz,
        resolution_criteria = $6,
        resolution_spec = $7::jsonb,
        source_of_truth_url = $8,
        resolution_kind = $9,
        resolution_metadata = $10::jsonb,
        dedupe_key = $11,
        semantic_dedupe_key = $12,
        origin = $13,
        signal_source_id = $14,
        signal_source_type = $15,
        status = $16,
        confidence_score = $17,
        observation_count = $18,
        autonomy_note = $19,
        linked_market_id = $20,
        created_at = $21::timestamptz
      WHERE id = $1
      RETURNING *
    `,
    [
      proposal.id,
      proposal.proposer_agent_id,
      proposal.title,
      proposal.category,
      proposal.close_time,
      proposal.resolution_criteria,
      JSON.stringify(proposal.resolution_spec),
      proposal.source_of_truth_url,
      proposal.resolution_kind,
      JSON.stringify(proposal.resolution_metadata),
      proposal.dedupe_key,
      proposal.semantic_dedupe_key ?? null,
      proposal.origin,
      proposal.signal_source_id ?? null,
      proposal.signal_source_type ?? null,
      proposal.status,
      proposal.confidence_score,
      proposal.observation_count,
      proposal.autonomy_note,
      proposal.linked_market_id ?? null,
      proposal.created_at,
    ],
  );

  if (updated.rowCount) {
    return mapProposalRow(updated.rows[0]);
  }

  const result = await pool.query<ProposalRow>(
    `
      INSERT INTO proposals (
        id,
        proposer_agent_id,
        title,
        category,
        close_time,
        resolution_criteria,
        resolution_spec,
        source_of_truth_url,
        resolution_kind,
        resolution_metadata,
        dedupe_key,
        semantic_dedupe_key,
        origin,
        signal_source_id,
        signal_source_type,
        status,
        confidence_score,
        observation_count,
        autonomy_note,
        linked_market_id,
        created_at
      )
      VALUES (
        $1, $2, $3, $4, $5::timestamptz, $6, $7::jsonb, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::timestamptz
      )
      ON CONFLICT (semantic_dedupe_key) WHERE semantic_dedupe_key IS NOT NULL DO UPDATE SET
        proposer_agent_id = EXCLUDED.proposer_agent_id,
        title = EXCLUDED.title,
        category = EXCLUDED.category,
        close_time = EXCLUDED.close_time,
        resolution_criteria = EXCLUDED.resolution_criteria,
        resolution_spec = EXCLUDED.resolution_spec,
        source_of_truth_url = EXCLUDED.source_of_truth_url,
        resolution_kind = EXCLUDED.resolution_kind,
        resolution_metadata = EXCLUDED.resolution_metadata,
        semantic_dedupe_key = EXCLUDED.semantic_dedupe_key,
        origin = EXCLUDED.origin,
        signal_source_id = EXCLUDED.signal_source_id,
        signal_source_type = EXCLUDED.signal_source_type,
        status = CASE
          WHEN proposals.status = 'published' THEN proposals.status
          WHEN proposals.linked_market_id IS NOT NULL THEN 'published'
          ELSE EXCLUDED.status
        END,
        confidence_score = GREATEST(proposals.confidence_score, EXCLUDED.confidence_score),
        observation_count = proposals.observation_count + EXCLUDED.observation_count,
        autonomy_note = EXCLUDED.autonomy_note,
        linked_market_id = COALESCE(proposals.linked_market_id, EXCLUDED.linked_market_id),
        created_at = LEAST(proposals.created_at, EXCLUDED.created_at)
      RETURNING *
    `,
    [
      proposal.id,
      proposal.proposer_agent_id,
      proposal.title,
      proposal.category,
      proposal.close_time,
      proposal.resolution_criteria,
      JSON.stringify(proposal.resolution_spec),
      proposal.source_of_truth_url,
      proposal.resolution_kind,
      JSON.stringify(proposal.resolution_metadata),
      proposal.dedupe_key,
      proposal.semantic_dedupe_key ?? null,
      proposal.origin,
      proposal.signal_source_id ?? null,
      proposal.signal_source_type ?? null,
      proposal.status,
      proposal.confidence_score,
      proposal.observation_count,
      proposal.autonomy_note,
      proposal.linked_market_id ?? null,
      proposal.created_at,
    ],
  );

  return mapProposalRow(result.rows[0]);
}

app.get("/health", async () => ({ service: "proposal-pipeline", status: "ok" }));

function scoreProposal(input: {
  category?: string;
  title?: string;
  signal_source_type?: "calendar" | "news" | "agent";
  resolution_spec?: ResolutionSpec;
}): { confidenceScore: number; status: Proposal["status"]; autonomyNote: string } {
  if (!input.title || !input.resolution_spec) {
    return {
      confidenceScore: 0,
      status: "suppressed" as const,
      autonomyNote: "Missing required title or resolution specification.",
    };
  }

  const validation = validateResolutionSpec(input.resolution_spec);
  if (!validation.ok) {
    return {
      confidenceScore: 0,
      status: "suppressed" as const,
      autonomyNote: `Suppressed because resolution specification is invalid: ${validation.errors.join(", ")}`,
    };
  }

  let confidenceScore = 0.55;
  const extractionMode = input.resolution_spec.source.extraction_mode ?? "deterministic_json";
  const canonicalUrl = input.resolution_spec.source.canonical_url;
  if (input.signal_source_type === "calendar") {
    confidenceScore += 0.2;
  }
  if (input.signal_source_type === "agent") {
    confidenceScore += 0.22;
  }
  if (input.signal_source_type === "news") {
    confidenceScore -= 0.03;
  }
  if (/federalreserve|cmegroup|sec|treasury|noaa|weather\.gov|nws|coingecko|coinbase|kraken|binance/i.test(canonicalUrl)) {
    confidenceScore += 0.12;
  }
  if (/localhost|127\.0\.0\.1/i.test(canonicalUrl)) {
    confidenceScore += 0.06;
  }
  if (input.category === "macro" || input.category === "economy") {
    confidenceScore += 0.05;
  }
  if (input.resolution_spec.kind === "price_threshold") {
    confidenceScore += 0.12;
  }
  if (input.resolution_spec.kind === "event_occurrence") {
    confidenceScore += 0.06;
  }
  if (extractionMode === "agent_extract") {
    confidenceScore += 0.1;
  }
  if (
    input.signal_source_type === "news" &&
    input.resolution_spec.kind === "event_occurrence" &&
    extractionMode === "agent_extract"
  ) {
    confidenceScore += 0.08;
  }
  if (
    input.resolution_spec.kind === "event_occurrence" &&
    ["world", "weather", "sports", "business"].includes((input.category ?? "").toLowerCase())
  ) {
    confidenceScore += 0.04;
  }
  if (input.category === "crypto" && input.resolution_spec.kind === "price_threshold") {
    confidenceScore -= 0.03;
  }

  confidenceScore = Math.max(0, Math.min(1, confidenceScore));

  const status: Proposal["status"] =
    confidenceScore >= autoPublishThreshold
      ? "published"
      : confidenceScore >= autoQueueThreshold
        ? "queued"
        : "suppressed";
  const autonomyNote =
    status === "published"
      ? "Published automatically because confidence exceeded the autonomous publication threshold."
      : status === "queued"
        ? "Queued for autonomous republication once repeated signals increase confidence."
        : "Suppressed automatically because confidence was too low.";

  return {
    confidenceScore,
    status,
    autonomyNote,
  };
}

async function publishMarketFromProposal(proposal: Proposal) {
  const response = await fetch(`${marketServiceUrl}/v1/internal/markets`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      proposal_id: proposal.id,
      title: proposal.title,
      category: proposal.category,
      close_time: proposal.close_time,
      resolution_criteria: proposal.resolution_criteria,
      resolution_spec: proposal.resolution_spec,
    }),
  });

  if (!response.ok) {
    throw new Error(`market publication failed with ${response.status}`);
  }

  const payload = (await response.json()) as { id?: string };
  return payload.id ?? proposal.id;
}

async function ensurePublishedProposalHasMarket(proposal: Proposal) {
  if (proposal.status !== "published" || proposal.linked_market_id) {
    return proposal;
  }

  try {
    proposal.linked_market_id = await publishMarketFromProposal(proposal);
  } catch (error) {
    proposal.status = "suppressed";
    proposal.autonomy_note = `Suppressed because market publication failed: ${String(error)}`;
  }

  return proposal;
}

async function maybePublishQueuedProposal(proposal: Proposal) {
  if (proposal.status !== "queued") {
    return proposal;
  }

  const validation = validateResolutionSpec(proposal.resolution_spec);
  if (!validation.ok) {
    proposal.status = "suppressed";
    proposal.autonomy_note = `Suppressed because resolution specification is invalid: ${validation.errors.join(", ")}`;
    return proposal;
  }

  const adjustedConfidence = Math.min(1, proposal.confidence_score + (proposal.observation_count - 1) * 0.12);
  proposal.confidence_score = adjustedConfidence;

  if (adjustedConfidence < autoPublishThreshold) {
    proposal.autonomy_note =
      "Queued for autonomous republication until repeated signals raise confidence above the publication threshold.";
    return proposal;
  }

  try {
    proposal.linked_market_id = await publishMarketFromProposal(proposal);
    proposal.status = "published";
    proposal.autonomy_note =
      "Published automatically after repeated signal confirmations raised confidence above the publication threshold.";
  } catch (error) {
    proposal.status = "suppressed";
    proposal.autonomy_note = `Suppressed because market publication failed: ${String(error)}`;
  }

  return proposal;
}

app.post("/v1/market-proposals", async (request, reply) => {
  const body = request.body as {
    proposer_agent_id?: string;
    title?: string;
    category?: string;
    close_time?: string;
    resolution_criteria?: string;
    resolution_spec?: ResolutionSpec;
    dedupe_key?: string;
    origin?: "agent" | "automation";
    signal_source_id?: string;
    signal_source_type?: "calendar" | "news" | "agent";
  };

  const dedupeKey =
    body.dedupe_key ??
    `${body.category ?? "uncategorized"}:${body.title ?? "Untitled proposal"}:${body.close_time ?? ""}`;
  const normalizedTitle = body.title ?? "Untitled proposal";
  const normalizedCategory = body.category ?? "uncategorized";
  const normalizedCloseTime = body.close_time ?? new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
  const resolutionSpecValidation = body.resolution_spec ? validateResolutionSpec(body.resolution_spec) : null;
  const resolutionSpec =
    resolutionSpecValidation && resolutionSpecValidation.ok ? resolutionSpecValidation.spec : null;
  const semanticDedupeKey = resolutionSpec
    ? buildSemanticDedupeKey({
        title: normalizedTitle,
        category: normalizedCategory,
        close_time: normalizedCloseTime,
        resolution_spec: resolutionSpec,
      })
    : null;

  const existing = await getProposalByDedupeKey(dedupeKey);
  if (existing) {
    existing.observation_count += 1;
    await maybePublishQueuedProposal(existing);
    await ensurePublishedProposalHasMarket(existing);
    const savedProposal = await saveProposal(existing);
    return {
      ...savedProposal,
      deduped: true,
    };
  }

  if (semanticDedupeKey) {
    const semanticExisting = await getProposalBySemanticDedupeKey(semanticDedupeKey);
    if (semanticExisting) {
      semanticExisting.observation_count += 1;
      semanticExisting.semantic_dedupe_key ??= semanticDedupeKey;
      await maybePublishQueuedProposal(semanticExisting);
      await ensurePublishedProposalHasMarket(semanticExisting);
      const savedProposal = await saveProposal(semanticExisting);
      return {
        ...savedProposal,
        deduped: true,
      };
    }
  }

  if (resolutionSpec) {
    const semanticDuplicate = await findSemanticDuplicate({
      title: normalizedTitle,
      category: normalizedCategory,
      close_time: normalizedCloseTime,
      resolution_spec: resolutionSpec,
    });
    if (semanticDuplicate) {
      semanticDuplicate.observation_count += 1;
      semanticDuplicate.semantic_dedupe_key ??= semanticDedupeKey ?? undefined;
      await maybePublishQueuedProposal(semanticDuplicate);
      await ensurePublishedProposalHasMarket(semanticDuplicate);
      const savedProposal = await saveProposal(semanticDuplicate);
      return {
        ...savedProposal,
        deduped: true,
      };
    }
  }

  const decision = scoreProposal(body);

  const proposal: Proposal = {
    id: randomUUID(),
    proposer_agent_id: body.proposer_agent_id ?? "seed-agent",
    title: normalizedTitle,
    category: normalizedCategory,
    close_time: normalizedCloseTime,
    resolution_criteria: body.resolution_criteria ?? "TBD",
    resolution_spec:
      resolutionSpec ??
      ({
        kind: "price_threshold",
        source: {
          adapter: "http_json",
          canonical_url: "https://invalid.example",
          allowed_domains: ["invalid.example"],
        },
        observation_schema: {
          type: "object",
          fields: {
            price: {
              type: "number",
              path: "price",
            },
          },
        },
        decision_rule: {
          kind: "price_threshold",
          observation_field: "price",
          operator: "gt",
          threshold: 0,
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
      } satisfies ResolutionSpec),
    source_of_truth_url: resolutionSpec?.source.canonical_url ?? "https://invalid.example",
    resolution_kind: resolutionSpec?.kind ?? "price_threshold",
    resolution_metadata:
      resolutionSpec?.decision_rule ??
      ({
        kind: "price_threshold",
        observation_field: "price",
        operator: "gt",
        threshold: 0,
      } satisfies ResolutionSpec["decision_rule"]),
    dedupe_key: dedupeKey,
    semantic_dedupe_key: semanticDedupeKey ?? undefined,
    origin: body.origin ?? "agent",
    signal_source_id: body.signal_source_id,
    signal_source_type: body.signal_source_type,
    status: decision.status,
    confidence_score: decision.confidenceScore,
    observation_count: 1,
    autonomy_note: decision.autonomyNote,
    created_at: new Date().toISOString(),
  };

  let savedProposal = await saveProposal(proposal);
  await ensurePublishedProposalHasMarket(savedProposal);
  savedProposal = await saveProposal(savedProposal);
  reply.code(201);
  return {
    ...savedProposal,
    deduped: false,
  };
});

app.get("/v1/market-proposals/:proposalId", async (request, reply) => {
  const proposalId = (request.params as { proposalId: string }).proposalId;
  const proposal = await getProposalById(proposalId);
  if (!proposal) {
    reply.code(404);
    return { error: "proposal_not_found" };
  }
  return proposal;
});

app.get("/v1/proposals", async () => {
  const result = await pool.query<ProposalRow>(
    `
      SELECT *
      FROM proposals
      ORDER BY created_at DESC, id DESC
    `,
  );

  return {
    items: result.rows.map(mapProposalRow),
  };
});

async function start() {
  await ensureCoreSchema(pool);
  await app.listen({ port, host: "0.0.0.0" });
}

void start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
