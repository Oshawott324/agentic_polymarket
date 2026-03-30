import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { createDatabasePool, ensureCoreSchema, parseJsonField, toIsoTimestamp } from "@automakit/persistence";
import {
  ResolutionRuntimeError,
  collectObservationFromSource,
} from "@automakit/resolution-runtime";
import type { ResolutionSpec } from "@automakit/sdk-types";

type ResolutionCandidate = {
  market_id: string;
  title: string;
  status: string;
  category: string;
  close_time: string;
  resolution_spec: ResolutionSpec;
  evidence_count: number;
  distinct_collector_count: number;
};

type ResolutionCollectionJob = {
  id: string;
  market_id: string;
  collector_agent_id: string;
  status: "pending" | "claimed" | "succeeded" | "failed" | "quarantined";
  next_attempt_at: string;
  claimed_at: string | null;
  claim_expires_at: string | null;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type ResolutionCollectionJobRow = {
  id: string;
  market_id: string;
  collector_agent_id: string;
  status: ResolutionCollectionJob["status"];
  next_attempt_at: unknown;
  claimed_at: unknown;
  claim_expires_at: unknown;
  attempt_count: unknown;
  last_error: string | null;
  created_at: unknown;
  updated_at: unknown;
};

const port = Number(process.env.RESOLUTION_COLLECTOR_PORT ?? 4008);
const app = Fastify({ logger: true });
const pool = createDatabasePool();
const marketServiceUrl = process.env.MARKET_SERVICE_URL ?? "http://127.0.0.1:4003";
const resolutionServiceUrl = process.env.RESOLUTION_SERVICE_URL ?? "http://127.0.0.1:4006";
const collectorAgentId = process.env.COLLECTOR_AGENT_ID ?? "resolver-alpha";
const intervalMs = Number(process.env.RESOLUTION_COLLECTOR_INTERVAL_MS ?? 2000);
const batchSize = Number(process.env.RESOLUTION_COLLECTOR_BATCH_SIZE ?? 10);
const claimTtlMs = Number(process.env.RESOLUTION_COLLECTOR_CLAIM_TTL_MS ?? 15000);
const backoffBaseMs = Number(process.env.RESOLUTION_COLLECTOR_BACKOFF_BASE_MS ?? 1000);
const backoffMaxMs = Number(process.env.RESOLUTION_COLLECTOR_BACKOFF_MAX_MS ?? 30000);

let tickInFlight = false;
let lastTickAt: string | null = null;
let lastTickError: string | null = null;

function mapJobRow(row: ResolutionCollectionJobRow): ResolutionCollectionJob {
  return {
    id: row.id,
    market_id: row.market_id,
    collector_agent_id: row.collector_agent_id,
    status: row.status,
    next_attempt_at: toIsoTimestamp(row.next_attempt_at),
    claimed_at: row.claimed_at ? toIsoTimestamp(row.claimed_at) : null,
    claim_expires_at: row.claim_expires_at ? toIsoTimestamp(row.claim_expires_at) : null,
    attempt_count: Number(row.attempt_count),
    last_error: row.last_error,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  };
}

async function fetchResolutionCandidates(limit: number) {
  const response = await fetch(
    `${marketServiceUrl}/v1/internal/markets/resolution-candidates?limit=${encodeURIComponent(String(limit))}`,
  );
  if (!response.ok) {
    throw new Error(`resolution_candidate_lookup_failed:${response.status}`);
  }

  const payload = (await response.json()) as { items: Array<Omit<ResolutionCandidate, "resolution_spec"> & { resolution_spec: unknown }> };
  return payload.items.map((item) => ({
    ...item,
    resolution_spec: parseJsonField<ResolutionSpec>(item.resolution_spec),
  }));
}

async function ensureJobsForCandidates(candidates: ResolutionCandidate[]) {
  const now = new Date().toISOString();
  for (const candidate of candidates) {
    await pool.query(
      `
        INSERT INTO resolution_collection_jobs (
          id,
          market_id,
          collector_agent_id,
          status,
          next_attempt_at,
          claimed_at,
          claim_expires_at,
          attempt_count,
          last_error,
          created_at,
          updated_at
        )
        SELECT
          $1,
          $2,
          $3,
          'pending',
          $4::timestamptz,
          NULL,
          NULL,
          0,
          NULL,
          $4::timestamptz,
          $4::timestamptz
        WHERE EXISTS (
          SELECT 1
          FROM markets
          WHERE id = $2
        )
        ON CONFLICT (market_id, collector_agent_id) DO NOTHING
      `,
      [randomUUID(), candidate.market_id, collectorAgentId, now],
    );
  }
}

async function claimJobs(limit: number) {
  const result = await pool.query<ResolutionCollectionJobRow>(
    `
      UPDATE resolution_collection_jobs
      SET
        status = 'claimed',
        claimed_at = NOW(),
        claim_expires_at = NOW() + ($2 * INTERVAL '1 millisecond'),
        updated_at = NOW()
      WHERE id IN (
        SELECT id
        FROM resolution_collection_jobs
        WHERE collector_agent_id = $1
          AND status IN ('pending', 'failed')
          AND next_attempt_at <= NOW()
          AND (claim_expires_at IS NULL OR claim_expires_at <= NOW())
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `,
    [collectorAgentId, claimTtlMs, limit],
  );

  return result.rows.map(mapJobRow);
}

async function markJobSucceeded(jobId: string, status: ResolutionCollectionJob["status"] = "succeeded") {
  await pool.query(
    `
      UPDATE resolution_collection_jobs
      SET
        status = $2,
        claimed_at = NULL,
        claim_expires_at = NULL,
        updated_at = NOW()
      WHERE id = $1
    `,
    [jobId, status],
  );
}

async function markJobFailed(job: ResolutionCollectionJob, errorMessage: string) {
  const delayMs = Math.min(backoffMaxMs, backoffBaseMs * 2 ** job.attempt_count);
  await pool.query(
    `
      UPDATE resolution_collection_jobs
      SET
        status = 'failed',
        claimed_at = NULL,
        claim_expires_at = NULL,
        next_attempt_at = NOW() + ($2 * INTERVAL '1 millisecond'),
        attempt_count = attempt_count + 1,
        last_error = $3,
        updated_at = NOW()
      WHERE id = $1
    `,
    [job.id, delayMs, errorMessage],
  );
}

async function submitCollectedObservation(
  job: ResolutionCollectionJob,
  candidate: ResolutionCandidate,
) {
  const collected = await collectObservationFromSource(candidate.resolution_spec);
  const response = await fetch(`${resolutionServiceUrl}/v1/internal/resolution-observations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      market_id: candidate.market_id,
      collector_agent_id: job.collector_agent_id,
      source_url: collected.source_url,
      source_hash: collected.source_hash,
      source_adapter: collected.source_adapter,
      parser_version: collected.parser_version,
      observed_at: collected.observed_at,
      observation_payload: collected.observation_payload,
      summary: collected.summary,
    }),
  });

  return {
    ok: response.ok,
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function reportCollectionFailure(
  job: ResolutionCollectionJob,
  failureKind: "source_fetch" | "schema_validation" | "decision_rule" | "unknown",
  reason: string,
) {
  const response = await fetch(`${resolutionServiceUrl}/v1/internal/resolution-collection-failures`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      market_id: job.market_id,
      collector_agent_id: job.collector_agent_id,
      failure_kind: failureKind,
      reason,
    }),
  });

  return {
    ok: response.ok,
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

function classifyRuntimeFailure(error: unknown) {
  if (!(error instanceof ResolutionRuntimeError)) {
    return {
      kind: "unknown" as const,
      retriable: true,
      message: String(error),
    };
  }

  switch (error.code) {
    case "source_fetch_failed":
      return {
        kind: "source_fetch" as const,
        retriable: true,
        message: error.message,
      };
    case "observation_schema_validation_failed":
    case "source_payload_not_json":
    case "source_payload_not_extractable":
    case "observation_too_old":
      return {
        kind: "schema_validation" as const,
        retriable: false,
        message: error.message,
      };
    case "decision_rule_not_applicable":
      return {
        kind: "decision_rule" as const,
        retriable: false,
        message: error.message,
      };
    default:
      return {
        kind: "unknown" as const,
        retriable: true,
        message: error.message,
      };
  }
}

async function processClaimedJob(job: ResolutionCollectionJob, candidatesByMarketId: Map<string, ResolutionCandidate>) {
  const candidate = candidatesByMarketId.get(job.market_id);
  if (!candidate) {
    await markJobSucceeded(job.id);
    return;
  }

  try {
    const response = await submitCollectedObservation(job, candidate);
    if (response.ok || response.status === 409) {
      await markJobSucceeded(job.id);
      return;
    }

    const errorMessage = String(response.body.error ?? JSON.stringify(response.body));
    if (
      response.status === 200 &&
      String(response.body.status ?? "") === "noop_duplicate"
    ) {
      await markJobSucceeded(job.id);
      return;
    }

    await markJobFailed(job, errorMessage);
  } catch (error) {
    const failure = classifyRuntimeFailure(error);
    if (failure.retriable) {
      await markJobFailed(job, failure.message);
      return;
    }

    const report = await reportCollectionFailure(job, failure.kind, failure.message);
    if (report.ok && String(report.body.status ?? "") === "quarantined") {
      await markJobSucceeded(job.id, "quarantined");
      return;
    }

    await markJobFailed(job, failure.message);
  }
}

async function tick() {
  if (tickInFlight) {
    return;
  }

  tickInFlight = true;
  try {
    const candidates = await fetchResolutionCandidates(batchSize * 4);
    const candidatesByMarketId = new Map(candidates.map((candidate) => [candidate.market_id, candidate]));
    await ensureJobsForCandidates(candidates);
    const jobs = await claimJobs(batchSize);
    for (const job of jobs) {
      await processClaimedJob(job, candidatesByMarketId);
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

async function waitForService(serviceName: string, serviceUrl: string) {
  for (;;) {
    try {
      const response = await fetch(`${serviceUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {}
    app.log.info({ service: serviceName, service_url: serviceUrl }, "waiting_for_service_health");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

app.get("/health", async () => ({
  service: "resolution-collector",
  status: "ok",
  collector_agent_id: collectorAgentId,
  last_tick_at: lastTickAt,
  last_tick_error: lastTickError,
}));

async function start() {
  await ensureCoreSchema(pool);
  await app.listen({ port, host: "0.0.0.0" });
  await waitForService("market-service", marketServiceUrl);
  await waitForService("resolution-service", resolutionServiceUrl);
  void tick();
  setInterval(() => {
    void tick();
  }, intervalMs).unref();
}

void start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
