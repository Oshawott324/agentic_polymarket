import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { createDatabasePool, ensureCoreSchema, parseJsonField, toIsoTimestamp } from "@automakit/persistence";
import type { ResolutionKind } from "@automakit/sdk-types";
import {
  buildDedupeKey,
  type PriceThresholdHypothesisMetadata,
  type RateDecisionHypothesisMetadata,
  type SuggestedResolutionMetadata,
  type WorldEntityRef,
  type WorldHypothesis,
  type WorldSignal,
  validateWorldHypothesis,
} from "@automakit/world-sim";

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
  suggested_resolution_kind: ResolutionKind | null;
  suggested_resolution_source_url: string | null;
  suggested_resolution_metadata: unknown;
  status: WorldHypothesis["status"];
  suppression_reason: string | null;
  linked_proposal_id: string | null;
  dedupe_key: string;
  created_at: unknown;
  updated_at: unknown;
};

type DerivedHypothesis = {
  category: string;
  subject: string;
  predicate: string;
  target_time: string;
  machine_resolvable: boolean;
  suggested_resolution_kind?: ResolutionKind;
  suggested_resolution_source_url?: string;
  suggested_resolution_metadata?: SuggestedResolutionMetadata;
  suppression_reason: string | null;
};

const port = Number(process.env.WORLD_MODEL_PORT ?? 4011);
const intervalMs = Number(process.env.WORLD_MODEL_INTERVAL_MS ?? 1000);
const batchSize = Number(process.env.WORLD_MODEL_BATCH_SIZE ?? 100);
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

function baseConfidenceForTrustTier(signal: WorldSignal) {
  switch (signal.trust_tier) {
    case "official":
      return 0.84;
    case "exchange":
      return 0.82;
    case "curated":
      return 0.68;
    case "derived":
      return 0.55;
    default:
      return 0.5;
  }
}

function findEntityValue(signal: WorldSignal, kind: WorldEntityRef["kind"]) {
  return signal.entity_refs.find((entry) => entry.kind === kind)?.value;
}

function derivePriceThresholdHypothesis(signal: WorldSignal) {
  const assetSymbol =
    typeof signal.payload.asset_symbol === "string"
      ? signal.payload.asset_symbol
      : findEntityValue(signal, "asset");
  const threshold = Number(signal.payload.threshold);
  const operator =
    signal.payload.operator === "gte" ||
    signal.payload.operator === "lt" ||
    signal.payload.operator === "lte"
      ? signal.payload.operator
      : "gt";
  const targetTime =
    typeof signal.payload.target_time === "string" ? signal.payload.target_time : signal.effective_at;
  const canonicalSourceUrl =
    typeof signal.payload.canonical_source_url === "string"
      ? signal.payload.canonical_source_url
      : signal.source_url;
  const category =
    typeof signal.payload.category === "string" && signal.payload.category.length > 0
      ? signal.payload.category
      : "crypto";
  const machineResolvable =
    typeof assetSymbol === "string" &&
    assetSymbol.length > 0 &&
    Number.isFinite(threshold) &&
    typeof targetTime === "string" &&
    typeof canonicalSourceUrl === "string";

  const metadata: PriceThresholdHypothesisMetadata | undefined = machineResolvable
    ? {
        kind: "price_threshold",
        asset_symbol: assetSymbol!,
        threshold,
        operator,
        canonical_source_url: canonicalSourceUrl,
        category,
      }
    : undefined;

  const derived: DerivedHypothesis = {
    category,
    subject: assetSymbol ?? signal.title,
    predicate: "price_threshold",
    target_time: targetTime ?? new Date().toISOString(),
    machine_resolvable: Boolean(machineResolvable),
    suggested_resolution_kind: machineResolvable ? ("price_threshold" satisfies ResolutionKind) : undefined,
    suggested_resolution_source_url: machineResolvable ? canonicalSourceUrl : undefined,
    suggested_resolution_metadata: metadata,
    suppression_reason: machineResolvable ? null : "incomplete_price_threshold_signal",
  };

  return derived;
}

function deriveRateDecisionHypothesis(signal: WorldSignal) {
  const institution =
    typeof signal.payload.institution === "string"
      ? signal.payload.institution
      : findEntityValue(signal, "institution");
  const direction =
    signal.payload.direction === "hold" || signal.payload.direction === "hike"
      ? signal.payload.direction
      : "cut";
  const targetTime =
    typeof signal.payload.target_time === "string" ? signal.payload.target_time : signal.effective_at;
  const canonicalSourceUrl =
    typeof signal.payload.canonical_source_url === "string"
      ? signal.payload.canonical_source_url
      : signal.source_url;
  const category =
    typeof signal.payload.category === "string" && signal.payload.category.length > 0
      ? signal.payload.category
      : "macro";
  const machineResolvable =
    typeof institution === "string" &&
    institution.length > 0 &&
    typeof targetTime === "string" &&
    typeof canonicalSourceUrl === "string";

  const metadata: RateDecisionHypothesisMetadata | undefined = machineResolvable
    ? {
        kind: "rate_decision",
        institution: institution!,
        direction,
        canonical_source_url: canonicalSourceUrl,
        category,
      }
    : undefined;

  const derived: DerivedHypothesis = {
    category,
    subject: institution ?? signal.title,
    predicate: `rate_decision_${direction}`,
    target_time: targetTime ?? new Date().toISOString(),
    machine_resolvable: Boolean(machineResolvable),
    suggested_resolution_kind: machineResolvable ? ("rate_decision" satisfies ResolutionKind) : undefined,
    suggested_resolution_source_url: machineResolvable ? canonicalSourceUrl : undefined,
    suggested_resolution_metadata: metadata,
    suppression_reason: machineResolvable ? null : "incomplete_rate_decision_signal",
  };

  return derived;
}

function deriveHypothesis(signal: WorldSignal): WorldHypothesis {
  const explicitKind =
    signal.payload.kind === "price_threshold" || signal.payload.kind === "rate_decision"
      ? signal.payload.kind
      : null;

  const derived: DerivedHypothesis =
    explicitKind === "price_threshold" || signal.source_type === "price_feed"
      ? derivePriceThresholdHypothesis(signal)
      : explicitKind === "rate_decision" || signal.source_type === "economic_calendar"
        ? deriveRateDecisionHypothesis(signal)
        : {
            category:
              typeof signal.payload.category === "string" && signal.payload.category.length > 0
                ? signal.payload.category
                : "general",
            subject: signal.title,
            predicate: "unsupported_signal",
            target_time: signal.effective_at ?? signal.created_at,
            machine_resolvable: false,
            suggested_resolution_kind: undefined,
            suggested_resolution_source_url: undefined,
            suggested_resolution_metadata: undefined,
            suppression_reason: "unsupported_signal_type",
          };

  const hypothesis: WorldHypothesis = {
    id: randomUUID(),
    source_signal_ids: [signal.id],
    category: derived.category,
    subject: derived.subject,
    predicate: derived.predicate,
    target_time: derived.target_time,
    confidence_score: baseConfidenceForTrustTier(signal),
    reasoning_summary: signal.summary,
    machine_resolvable: derived.machine_resolvable,
    suggested_resolution_kind: derived.suggested_resolution_kind,
    suggested_resolution_source_url: derived.suggested_resolution_source_url,
    suggested_resolution_metadata: derived.suggested_resolution_metadata,
    status: derived.machine_resolvable ? "new" : "suppressed",
    suppression_reason: derived.suppression_reason,
    linked_proposal_id: null,
    dedupe_key: buildDedupeKey({
      signal: signal.dedupe_key,
      predicate: derived.predicate,
      target_time: derived.target_time,
    }),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const validation = validateWorldHypothesis(hypothesis);
  if (!validation.ok) {
    throw new Error(`invalid_world_hypothesis:${validation.errors.join(",")}`);
  }

  return validation.hypothesis;
}

async function fetchSignals(limit: number) {
  const result = await pool.query<WorldSignalRow>(
    `
      SELECT *
      FROM world_signals
      ORDER BY created_at DESC, id DESC
      LIMIT $1
    `,
    [limit],
  );

  return result.rows.map(mapSignalRow);
}

async function upsertHypothesis(hypothesis: WorldHypothesis) {
  await pool.query(
    `
      INSERT INTO world_hypotheses (
        id,
        source_signal_ids,
        category,
        subject,
        predicate,
        target_time,
        confidence_score,
        reasoning_summary,
        machine_resolvable,
        suggested_resolution_kind,
        suggested_resolution_source_url,
        suggested_resolution_metadata,
        dedupe_key,
        status,
        suppression_reason,
        linked_proposal_id,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2::jsonb, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17::timestamptz, $18::timestamptz
      )
      ON CONFLICT (dedupe_key) DO UPDATE SET
        source_signal_ids = EXCLUDED.source_signal_ids,
        category = EXCLUDED.category,
        subject = EXCLUDED.subject,
        predicate = EXCLUDED.predicate,
        target_time = EXCLUDED.target_time,
        confidence_score = EXCLUDED.confidence_score,
        reasoning_summary = EXCLUDED.reasoning_summary,
        machine_resolvable = EXCLUDED.machine_resolvable,
        suggested_resolution_kind = EXCLUDED.suggested_resolution_kind,
        suggested_resolution_source_url = EXCLUDED.suggested_resolution_source_url,
        suggested_resolution_metadata = EXCLUDED.suggested_resolution_metadata,
        status = CASE
          WHEN world_hypotheses.status = 'proposed' THEN world_hypotheses.status
          ELSE EXCLUDED.status
        END,
        suppression_reason = EXCLUDED.suppression_reason,
        updated_at = EXCLUDED.updated_at
    `,
    [
      hypothesis.id,
      JSON.stringify(hypothesis.source_signal_ids),
      hypothesis.category,
      hypothesis.subject,
      hypothesis.predicate,
      hypothesis.target_time,
      hypothesis.confidence_score,
      hypothesis.reasoning_summary,
      hypothesis.machine_resolvable,
      hypothesis.suggested_resolution_kind ?? null,
      hypothesis.suggested_resolution_source_url ?? null,
      JSON.stringify(hypothesis.suggested_resolution_metadata ?? null),
      hypothesis.dedupe_key,
      hypothesis.status,
      hypothesis.suppression_reason ?? null,
      hypothesis.linked_proposal_id ?? null,
      hypothesis.created_at,
      hypothesis.updated_at,
    ],
  );
}

async function tick() {
  if (tickInFlight) {
    return;
  }

  tickInFlight = true;
  try {
    const signals = await fetchSignals(batchSize);
    for (const signal of signals) {
      const hypothesis = deriveHypothesis(signal);
      await upsertHypothesis(hypothesis);
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
  last_tick_at: lastTickAt,
  last_tick_error: lastTickError,
}));

app.get("/v1/internal/world-hypotheses", async (request) => {
  const query = request.query as { status?: WorldHypothesis["status"]; limit?: string };
  const limit = Math.max(1, Math.min(200, Number(query.limit ?? "50") || 50));
  const values: unknown[] = [];
  let whereClause = "";
  if (query.status) {
    values.push(query.status);
    whereClause = `WHERE status = $${values.length}`;
  }
  values.push(limit);

  const result = await pool.query<WorldHypothesisRow>(
    `
      SELECT *
      FROM world_hypotheses
      ${whereClause}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}
    `,
    values,
  );

  return {
    items: result.rows.map(mapHypothesisRow),
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
