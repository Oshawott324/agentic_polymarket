import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  createDatabasePool,
  ensureCoreSchema,
  parseJsonField,
  toIsoTimestamp,
} from "@automakit/persistence";
import {
  ResolutionRuntimeError,
  collectObservationFromSource,
  deriveDeterministicOutcome,
  isAllowedSource,
  sha256Hex,
} from "@automakit/resolution-runtime";
import {
  type ObservationPayload,
  type ResolutionOutcome,
  type ResolutionSpec,
  validateObservationPayload,
  validateResolutionSpec,
} from "@automakit/sdk-types";

type Outcome = ResolutionOutcome;
type ResolutionStatus = "pending_evidence" | "finalizing" | "finalized" | "quarantined";

type MarketResolutionDefinition = {
  resolution_spec: ResolutionSpec;
  resolution_source: string;
};

type ResolutionEvidence = {
  id: string;
  market_id: string;
  submitter_agent_id: string;
  evidence_type: "url" | "text" | "file";
  derived_outcome: Outcome;
  summary: string;
  source_url: string;
  observed_at: string;
  observation_payload: ObservationPayload;
  created_at: string;
};

type ResolutionCase = {
  market_id: string;
  status: ResolutionStatus;
  draft_outcome: Outcome | null;
  final_outcome: Outcome | null;
  canonical_source_url: string | null;
  evidence: ResolutionEvidence[];
  quorum_threshold: number;
  last_updated_at: string;
};

type ResolutionCaseRow = {
  market_id: string;
  status: ResolutionStatus;
  draft_outcome: Outcome | null;
  final_outcome: Outcome | null;
  canonical_source_url: string | null;
  quorum_threshold: number;
  last_updated_at: unknown;
};

type ResolutionEvidenceRow = {
  id: string;
  market_id: string;
  submitter_agent_id: string;
  evidence_type: "url" | "text" | "file";
  derived_outcome: Outcome;
  summary: string;
  source_url: string;
  observed_at: unknown;
  observation_payload: unknown;
  created_at: unknown;
};

type CollectObservationResult = {
  source_url: string;
  source_hash: string;
  source_adapter: string;
  parser_version: string;
  observed_at: string;
  observation_payload: ObservationPayload;
  derived_outcome: Outcome;
  summary: string;
};

const port = Number(process.env.RESOLUTION_SERVICE_PORT ?? 4006);
const app = Fastify({ logger: true });
const pool = createDatabasePool();
const marketServiceUrl = process.env.MARKET_SERVICE_URL ?? "http://localhost:4003";
const portfolioServiceUrl = process.env.PORTFOLIO_SERVICE_URL ?? "http://localhost:4004";
const defaultQuorumThreshold = Number(process.env.RESOLUTION_QUORUM_THRESHOLD ?? 2);

async function appendStreamEvent(event: {
  market_id: string;
  payload: unknown;
  created_at?: string;
}) {
  await pool.query(
    `
      INSERT INTO stream_events (
        event_id,
        channel,
        market_id,
        agent_id,
        payload,
        created_at
      )
      VALUES ($1, 'resolution.update', $2, NULL, $3::jsonb, $4::timestamptz)
    `,
    [
      randomUUID(),
      event.market_id,
      JSON.stringify(event.payload),
      event.created_at ?? new Date().toISOString(),
    ],
  );
}

async function applyResolutionPayout(marketId: string, finalOutcome: "YES" | "NO") {
  const response = await fetch(`${portfolioServiceUrl}/v1/internal/resolutions/payout`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      market_id: marketId,
      final_outcome: finalOutcome,
    }),
  });

  return {
    ok: response.ok,
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function updateMarketStatus(marketId: string, status: "resolved" | "canceled" | "suspended") {
  const response = await fetch(`${marketServiceUrl}/v1/internal/markets/${marketId}/status`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ status }),
  });

  return {
    ok: response.ok,
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

function mapResolutionEvidenceRow(row: ResolutionEvidenceRow): ResolutionEvidence {
  return {
    id: row.id,
    market_id: row.market_id,
    submitter_agent_id: row.submitter_agent_id,
    evidence_type: row.evidence_type,
    derived_outcome: row.derived_outcome,
    summary: row.summary,
    source_url: row.source_url,
    observed_at: toIsoTimestamp(row.observed_at),
    observation_payload: parseJsonField<ObservationPayload>(row.observation_payload),
    created_at: toIsoTimestamp(row.created_at),
  };
}

async function fetchMarketResolutionDefinition(marketId: string): Promise<MarketResolutionDefinition> {
  const response = await fetch(`${marketServiceUrl}/v1/markets/${marketId}`);
  if (!response.ok) {
    throw new Error(`market lookup failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    resolution_spec?: ResolutionSpec;
    resolution_source?: string;
  };
  if (!payload.resolution_spec) {
    throw new Error("market resolution spec missing");
  }

  const validation = validateResolutionSpec(payload.resolution_spec);
  if (!validation.ok) {
    throw new Error(`invalid_market_resolution_spec:${validation.errors.join(",")}`);
  }

  return {
    resolution_spec: validation.spec,
    resolution_source: validation.spec.source.canonical_url,
  };
}

async function getResolutionEvidence(marketId: string) {
  const result = await pool.query<ResolutionEvidenceRow>(
    `
      SELECT *
      FROM resolution_evidence
      WHERE market_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [marketId],
  );

  return result.rows.map(mapResolutionEvidenceRow);
}

async function getResolutionCase(marketId: string): Promise<ResolutionCase | null> {
  const result = await pool.query<ResolutionCaseRow>(
    `
      SELECT *
      FROM resolution_cases
      WHERE market_id = $1
    `,
    [marketId],
  );

  if (!result.rowCount) {
    return null;
  }

  const row = result.rows[0];
  return {
    market_id: row.market_id,
    status: row.status,
    draft_outcome: row.draft_outcome,
    final_outcome: row.final_outcome,
    canonical_source_url: row.canonical_source_url,
    evidence: await getResolutionEvidence(row.market_id),
    quorum_threshold: Number(row.quorum_threshold),
    last_updated_at: toIsoTimestamp(row.last_updated_at),
  };
}

async function saveResolutionCase(resolutionCase: ResolutionCase) {
  await pool.query(
    `
      INSERT INTO resolution_cases (
        market_id,
        status,
        draft_outcome,
        final_outcome,
        canonical_source_url,
        quorum_threshold,
        last_updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
      ON CONFLICT (market_id) DO UPDATE SET
        status = EXCLUDED.status,
        draft_outcome = EXCLUDED.draft_outcome,
        final_outcome = EXCLUDED.final_outcome,
        canonical_source_url = EXCLUDED.canonical_source_url,
        quorum_threshold = EXCLUDED.quorum_threshold,
        last_updated_at = EXCLUDED.last_updated_at
    `,
    [
      resolutionCase.market_id,
      resolutionCase.status,
      resolutionCase.draft_outcome,
      resolutionCase.final_outcome,
      resolutionCase.canonical_source_url,
      resolutionCase.quorum_threshold,
      resolutionCase.last_updated_at,
    ],
  );
}

async function upsertResolutionCase(marketId: string, definition: MarketResolutionDefinition) {
  const existing = await getResolutionCase(marketId);
  if (existing) {
    return existing;
  }

  const created: ResolutionCase = {
    market_id: marketId,
    status: "pending_evidence",
    draft_outcome: null,
    final_outcome: null,
    canonical_source_url: definition.resolution_source,
    evidence: [],
    quorum_threshold: definition.resolution_spec.quorum_rule.min_observations || defaultQuorumThreshold,
    last_updated_at: new Date().toISOString(),
  };
  await saveResolutionCase(created);
  return created;
}

async function saveObservationRecord(
  marketId: string,
  collectorAgentId: string,
  collected: CollectObservationResult,
) {
  await pool.query(
    `
      INSERT INTO observations (
        id,
        market_id,
        collector_agent_id,
        source_url,
        source_adapter,
        source_hash,
        parser_version,
        observed_at,
        observation_payload,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb, $10::timestamptz)
    `,
    [
      randomUUID(),
      marketId,
      collectorAgentId,
      collected.source_url,
      collected.source_adapter,
      collected.source_hash,
      collected.parser_version,
      collected.observed_at,
      JSON.stringify(collected.observation_payload),
      new Date().toISOString(),
    ],
  );
}

async function saveResolutionEvidence(
  marketId: string,
  collectorAgentId: string,
  collected: CollectObservationResult,
) {
  const evidence: ResolutionEvidence = {
    id: randomUUID(),
    market_id: marketId,
    submitter_agent_id: collectorAgentId,
    evidence_type: "url",
    derived_outcome: collected.derived_outcome,
    summary: collected.summary,
    source_url: collected.source_url,
    observed_at: collected.observed_at,
    observation_payload: collected.observation_payload,
    created_at: new Date().toISOString(),
  };

  await pool.query(
    `
      INSERT INTO resolution_evidence (
        id,
        market_id,
        submitter_agent_id,
        evidence_type,
        derived_outcome,
        summary,
        source_url,
        observed_at,
        observation_payload,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb, $10::timestamptz)
    `,
    [
      evidence.id,
      evidence.market_id,
      evidence.submitter_agent_id,
      evidence.evidence_type,
      evidence.derived_outcome,
      evidence.summary,
      evidence.source_url,
      evidence.observed_at,
      JSON.stringify(evidence.observation_payload),
      evidence.created_at,
    ],
  );

  return evidence;
}

function updateResolutionCaseState(resolutionCase: ResolutionCase, spec: ResolutionSpec) {
  const evidenceCount = resolutionCase.evidence.length;
  if (evidenceCount === 0) {
    resolutionCase.status = "pending_evidence";
    resolutionCase.draft_outcome = null;
    resolutionCase.final_outcome = null;
    resolutionCase.last_updated_at = new Date().toISOString();
    return;
  }

  const distinctCollectors = new Set(resolutionCase.evidence.map((entry) => entry.submitter_agent_id)).size;
  const counts = new Map<Outcome, number>();
  for (const evidence of resolutionCase.evidence) {
    counts.set(evidence.derived_outcome, (counts.get(evidence.derived_outcome) ?? 0) + 1);
  }

  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  const [topOutcome, topCount] = ranked[0];
  resolutionCase.draft_outcome = topOutcome;

  if (
    evidenceCount < spec.quorum_rule.min_observations ||
    distinctCollectors < spec.quorum_rule.min_distinct_collectors
  ) {
    resolutionCase.status = "finalizing";
    resolutionCase.final_outcome = null;
    resolutionCase.last_updated_at = new Date().toISOString();
    return;
  }

  let finalizedOutcome: Outcome | null = null;
  switch (spec.quorum_rule.agreement) {
    case "all":
      finalizedOutcome = counts.size === 1 ? topOutcome : null;
      break;
    case "majority":
      finalizedOutcome = topCount > evidenceCount / 2 ? topOutcome : null;
      break;
    case "2_of_3":
      finalizedOutcome = topCount >= 2 ? topOutcome : null;
      break;
    default:
      finalizedOutcome = null;
  }

  if (finalizedOutcome) {
    resolutionCase.status = "finalized";
    resolutionCase.final_outcome = finalizedOutcome;
    resolutionCase.last_updated_at = new Date().toISOString();
    return;
  }

  if (counts.size > 1 && spec.quarantine_rule.on_observation_conflict) {
    resolutionCase.status = "quarantined";
    resolutionCase.final_outcome = null;
    resolutionCase.last_updated_at = new Date().toISOString();
    return;
  }

  resolutionCase.status = "finalizing";
  resolutionCase.final_outcome = null;
  resolutionCase.last_updated_at = new Date().toISOString();
}

function buildResolutionPayload(resolutionCase: ResolutionCase) {
  return {
    market_id: resolutionCase.market_id,
    status: resolutionCase.status,
    draft_outcome: resolutionCase.draft_outcome,
    final_outcome: resolutionCase.final_outcome,
    canonical_source_url: resolutionCase.canonical_source_url,
    evidence: resolutionCase.evidence,
    quorum_threshold: resolutionCase.quorum_threshold,
    last_updated_at: resolutionCase.last_updated_at,
  };
}

async function quarantineResolutionCase(
  marketId: string,
  definition: MarketResolutionDefinition,
  reason: string,
) {
  const resolutionCase = await upsertResolutionCase(marketId, definition);
  resolutionCase.status = "quarantined";
  resolutionCase.draft_outcome = null;
  resolutionCase.final_outcome = null;
  resolutionCase.last_updated_at = new Date().toISOString();
  await saveResolutionCase(resolutionCase);
  await appendStreamEvent({
    market_id: marketId,
    payload: {
      ...buildResolutionPayload(resolutionCase),
      quarantine_reason: reason,
    },
    created_at: resolutionCase.last_updated_at,
  });
  const marketUpdate = await updateMarketStatus(marketId, "suspended");
  if (!marketUpdate.ok && marketUpdate.status !== 404) {
    throw new Error(`market_status_update_failed:${JSON.stringify(marketUpdate.body)}`);
  }
  return resolutionCase;
}

async function finalizeResolutionState(marketId: string, definition: MarketResolutionDefinition) {
  const resolutionCase = await upsertResolutionCase(marketId, definition);
  resolutionCase.evidence = await getResolutionEvidence(marketId);
  updateResolutionCaseState(resolutionCase, definition.resolution_spec);
  await saveResolutionCase(resolutionCase);

  const finalOutcome = resolutionCase.final_outcome;
  if (resolutionCase.status === "finalized" && finalOutcome && finalOutcome !== "CANCELED") {
    const payoutResult = await applyResolutionPayout(marketId, finalOutcome);
    if (!payoutResult.ok) {
      throw new Error(`portfolio_resolution_payout_failed:${JSON.stringify(payoutResult.body)}`);
    }
  }

  if (resolutionCase.status === "finalized") {
    const targetStatus = finalOutcome === "CANCELED" ? "canceled" : "resolved";
    const marketUpdate = await updateMarketStatus(marketId, targetStatus);
    if (!marketUpdate.ok) {
      throw new Error(`market_status_update_failed:${JSON.stringify(marketUpdate.body)}`);
    }
  }

  if (resolutionCase.status === "quarantined") {
    const marketUpdate = await updateMarketStatus(marketId, "suspended");
    if (!marketUpdate.ok) {
      throw new Error(`market_status_update_failed:${JSON.stringify(marketUpdate.body)}`);
    }
  }

  await appendStreamEvent({
    market_id: marketId,
    payload: buildResolutionPayload(resolutionCase),
    created_at: resolutionCase.last_updated_at,
  });

  return resolutionCase;
}

async function persistCollectedObservation(
  marketId: string,
  collectorAgentId: string,
  collected: CollectObservationResult,
) {
  await saveObservationRecord(marketId, collectorAgentId, collected);
  const evidence = await saveResolutionEvidence(marketId, collectorAgentId, collected);
  return evidence;
}

async function collectAndPersistObservation(marketId: string, collectorAgentId: string) {
  const definition = await fetchMarketResolutionDefinition(marketId);
  const existing = await upsertResolutionCase(marketId, definition);
  if (existing?.status === "finalized") {
    throw new Error("resolution_case_already_finalized");
  }

  try {
    const collected = await collectObservationFromSource(definition.resolution_spec);
    const evidence = await persistCollectedObservation(marketId, collectorAgentId, collected);
    const resolutionCase = await finalizeResolutionState(marketId, definition);
    return {
      evidence,
      resolutionCase,
    };
  } catch (error) {
    const message =
      error instanceof ResolutionRuntimeError && error.message !== error.code
        ? error.message
        : String(error);
    if (
      definition.resolution_spec.quarantine_rule.on_source_fetch_failure ||
      definition.resolution_spec.quarantine_rule.on_schema_validation_failure
    ) {
      await quarantineResolutionCase(marketId, definition, message);
    }
    throw error;
  }
}

async function ingestManualObservation(
  marketId: string,
  collectorAgentId: string,
  sourceUrl: string,
  observationPayload: ObservationPayload,
  observedAt: string,
  summary: string,
  options?: {
    source_hash?: string;
    source_adapter?: string;
    parser_version?: string;
  },
) {
  const definition = await fetchMarketResolutionDefinition(marketId);
  const existing = await upsertResolutionCase(marketId, definition);
  if (existing?.status === "finalized") {
    throw new Error("resolution_case_already_finalized");
  }
  if (!isAllowedSource(sourceUrl, definition.resolution_spec.source.allowed_domains)) {
    throw new Error("source_url_not_allowed_for_market");
  }

  const schemaErrors = validateObservationPayload(definition.resolution_spec, observationPayload);
  if (schemaErrors.length > 0) {
    if (definition.resolution_spec.quarantine_rule.on_schema_validation_failure) {
      await quarantineResolutionCase(marketId, definition, schemaErrors.join(","));
    }
    throw new Error(`observation_schema_validation_failed:${schemaErrors.join(",")}`);
  }

  const derivedOutcome = deriveDeterministicOutcome(definition.resolution_spec, observationPayload);

  const collected: CollectObservationResult = {
    source_url: sourceUrl,
    source_hash: options?.source_hash ?? sha256Hex(JSON.stringify(observationPayload)),
    source_adapter: options?.source_adapter ?? definition.resolution_spec.source.adapter,
    parser_version: options?.parser_version ?? "manual-observation@1",
    observed_at: observedAt,
    observation_payload: observationPayload,
    derived_outcome: derivedOutcome,
    summary,
  };
  const evidence = await persistCollectedObservation(marketId, collectorAgentId, collected);
  const resolutionCase = await finalizeResolutionState(marketId, definition);
  return { evidence, resolutionCase };
}

async function reportCollectionFailure(
  marketId: string,
  collectorAgentId: string,
  failureKind: "source_fetch" | "schema_validation" | "decision_rule" | "unknown",
  reason: string,
) {
  const definition = await fetchMarketResolutionDefinition(marketId);
  const existing = await upsertResolutionCase(marketId, definition);
  if (existing.status === "finalized" || existing.status === "quarantined") {
    return existing;
  }

  const shouldQuarantine =
    (failureKind === "schema_validation" &&
      definition.resolution_spec.quarantine_rule.on_schema_validation_failure) ||
    (failureKind === "source_fetch" && definition.resolution_spec.quarantine_rule.on_source_fetch_failure);

  if (shouldQuarantine) {
    return quarantineResolutionCase(marketId, definition, `${collectorAgentId}:${reason}`);
  }

  return existing;
}

app.get("/health", async () => ({ service: "resolution-service", status: "ok" }));

app.post("/v1/resolution-collect", async (request, reply) => {
  const body = request.body as { market_id?: string };
  const collectorAgentId = request.headers["x-agent-id"];
  if (typeof collectorAgentId !== "string" || collectorAgentId.length === 0) {
    reply.code(400);
    return { error: "missing_agent_identity" };
  }
  if (!body.market_id) {
    reply.code(400);
    return { error: "invalid_resolution_collect_request" };
  }

  try {
    const result = await collectAndPersistObservation(body.market_id, collectorAgentId);
    reply.code(201);
    return result.evidence;
  } catch (error) {
    const message = String(error);
    reply.code(message.includes("already_finalized") ? 409 : 422);
    return { error: message };
  }
});

app.post("/v1/internal/resolution-collect", async (request, reply) => {
  const body = request.body as { market_id?: string; collector_agent_id?: string };
  if (!body.market_id || !body.collector_agent_id) {
    reply.code(400);
    return { error: "invalid_internal_resolution_collect_request" };
  }

  try {
    const result = await collectAndPersistObservation(body.market_id, body.collector_agent_id);
    reply.code(201);
    return result.evidence;
  } catch (error) {
    const message = String(error);
    reply.code(message.includes("already_finalized") ? 409 : 422);
    return { error: message };
  }
});

app.post("/v1/internal/resolution-observations", async (request, reply) => {
  const body = request.body as {
    market_id?: string;
    collector_agent_id?: string;
    source_url?: string;
    source_hash?: string;
    source_adapter?: string;
    parser_version?: string;
    observed_at?: string;
    observation_payload?: ObservationPayload;
    summary?: string;
  };
  if (
    !body.market_id ||
    !body.collector_agent_id ||
    !body.source_url ||
    !body.source_hash ||
    !body.source_adapter ||
    !body.parser_version ||
    !body.observed_at ||
    !body.observation_payload ||
    !body.summary
  ) {
    reply.code(400);
    return { error: "invalid_internal_resolution_observation_request" };
  }

  try {
    const result = await ingestManualObservation(
      body.market_id,
      body.collector_agent_id,
      body.source_url,
      body.observation_payload,
      body.observed_at,
      body.summary,
      {
        source_hash: body.source_hash,
        source_adapter: body.source_adapter,
        parser_version: body.parser_version,
      },
    );
    reply.code(201);
    return result.evidence;
  } catch (error) {
    const message = String(error);
    if (message.includes("duplicate key value") || message.includes("duplicate_resolver_agent")) {
      reply.code(200);
      return { status: "noop_duplicate" };
    }
    reply.code(message.includes("already_finalized") ? 409 : 422);
    return { error: message };
  }
});

app.post("/v1/internal/resolution-collection-failures", async (request, reply) => {
  const body = request.body as {
    market_id?: string;
    collector_agent_id?: string;
    failure_kind?: "source_fetch" | "schema_validation" | "decision_rule" | "unknown";
    reason?: string;
  };
  if (!body.market_id || !body.collector_agent_id || !body.failure_kind || !body.reason) {
    reply.code(400);
    return { error: "invalid_internal_resolution_collection_failure_request" };
  }

  try {
    const resolutionCase = await reportCollectionFailure(
      body.market_id,
      body.collector_agent_id,
      body.failure_kind,
      body.reason,
    );
    return { status: resolutionCase.status };
  } catch (error) {
    reply.code(422);
    return { error: String(error) };
  }
});

app.post("/v1/resolution-evidence", async (request, reply) => {
  const body = request.body as {
    market_id?: string;
    summary?: string;
    source_url?: string;
    observed_at?: string;
    observation_payload?: ObservationPayload;
  };
  const collectorAgentId = request.headers["x-agent-id"];
  if (typeof collectorAgentId !== "string" || collectorAgentId.length === 0) {
    reply.code(400);
    return { error: "missing_agent_identity" };
  }
  if (!body.market_id || !body.source_url || !body.observed_at || !body.summary || !body.observation_payload) {
    reply.code(400);
    return { error: "invalid_resolution_evidence" };
  }

  try {
    const result = await ingestManualObservation(
      body.market_id,
      collectorAgentId,
      body.source_url,
      body.observation_payload,
      body.observed_at,
      body.summary,
    );
    reply.code(201);
    return result.evidence;
  } catch (error) {
    const message = String(error);
    reply.code(message.includes("already_finalized") ? 409 : 422);
    return { error: message };
  }
});

app.get("/v1/resolutions", async () => {
  const result = await pool.query<ResolutionCaseRow>(
    `
      SELECT *
      FROM resolution_cases
      ORDER BY last_updated_at DESC, market_id ASC
    `,
  );

  const items = await Promise.all(
    result.rows.map(async (row) => ({
      market_id: row.market_id,
      status: row.status,
      draft_outcome: row.draft_outcome,
      final_outcome: row.final_outcome,
      canonical_source_url: row.canonical_source_url,
      evidence: await getResolutionEvidence(row.market_id),
      quorum_threshold: Number(row.quorum_threshold),
      last_updated_at: toIsoTimestamp(row.last_updated_at),
    })),
  );

  return { items };
});

async function start() {
  await ensureCoreSchema(pool);
  await app.listen({ port, host: "0.0.0.0" });
}

void start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
