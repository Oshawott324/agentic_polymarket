import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { createDatabasePool, ensureCoreSchema, parseJsonField, toIsoTimestamp } from "@automakit/persistence";
import {
  type EventCase,
  type EventCaseStatus,
  type SourceAdapterKind,
  type WorldEntityRef,
  type WorldSignal,
  type WorldSignalSourceType,
  validateEventCase,
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

type EventCaseRow = {
  id: string;
  fingerprint: string;
  kind: string;
  title: string;
  summary: string;
  primary_entity: string;
  source_types: unknown;
  source_adapters: unknown;
  signal_count: unknown;
  first_signal_at: unknown;
  last_signal_at: unknown;
  status: EventCaseStatus;
  created_at: unknown;
  updated_at: unknown;
};

const port = Number(process.env.EVENT_BUILDER_PORT ?? 4019);
const intervalMs = Number(process.env.EVENT_BUILDER_INTERVAL_MS ?? 1_000);
const lookbackHours = Math.max(1, Number(process.env.EVENT_BUILDER_LOOKBACK_HOURS ?? 48));
const maxSignalsPerTick = Math.max(10, Number(process.env.EVENT_BUILDER_MAX_SIGNALS_PER_TICK ?? 500));
const bucketHours = Math.max(1, Number(process.env.EVENT_BUILDER_BUCKET_HOURS ?? 6));
const staleAfterHours = Math.max(1, Number(process.env.EVENT_BUILDER_STALE_AFTER_HOURS ?? 24));
const closeAfterHours = Math.max(staleAfterHours + 1, Number(process.env.EVENT_BUILDER_CLOSE_AFTER_HOURS ?? 168));

const app = Fastify({ logger: true });
const pool = createDatabasePool();

let tickInFlight = false;
let lastTickAt: string | null = null;
let lastTickError: string | null = null;
let lastProcessedSignals = 0;
let lastLinkedSignals = 0;

const stopWords = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "will",
  "have",
  "has",
  "was",
  "are",
  "you",
  "your",
  "about",
  "into",
  "over",
  "after",
  "before",
]);

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

function mapEventCaseRow(row: EventCaseRow): EventCase {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    primary_entity: row.primary_entity,
    source_types: parseJsonField<WorldSignalSourceType[]>(row.source_types),
    source_adapters: parseJsonField<SourceAdapterKind[]>(row.source_adapters),
    signal_count: Number(row.signal_count),
    first_signal_at: toIsoTimestamp(row.first_signal_at),
    last_signal_at: toIsoTimestamp(row.last_signal_at),
    status: row.status,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  };
}

function normalizeEntity(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function inferPrimaryEntity(signal: WorldSignal) {
  if (Array.isArray(signal.entity_refs) && signal.entity_refs.length > 0) {
    const value = signal.entity_refs[0]?.value;
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  const payload = signal.payload;
  const assetSymbol =
    typeof payload.asset_symbol === "string" && payload.asset_symbol.trim().length > 0
      ? payload.asset_symbol.trim()
      : null;
  if (assetSymbol) {
    return assetSymbol;
  }

  const tokens = signal.title
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !stopWords.has(token));
  if (tokens.length > 0) {
    return tokens[0];
  }

  return signal.source_adapter;
}

function caseKindFromSignal(signal: WorldSignal) {
  switch (signal.source_type) {
    case "price_feed":
      return "asset_price_observation";
    case "economic_calendar":
      return "calendar_event";
    case "filing":
      return "filing_event";
    case "official_announcement":
      return "official_announcement";
    case "market_internal":
      return "internal_market_event";
    case "news":
    default:
      return "news_event";
  }
}

function formatNumber(value: number, decimals = 2) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: decimals,
  }).format(value);
}

function bucketStartIso(timestampIso: string) {
  const milliseconds = new Date(timestampIso).getTime();
  const bucketSize = bucketHours * 60 * 60 * 1000;
  const bucketStart = Math.floor(milliseconds / bucketSize) * bucketSize;
  return new Date(bucketStart).toISOString();
}

function signalTimestamp(signal: WorldSignal) {
  return signal.effective_at ?? signal.fetched_at;
}

function buildEventCaseCandidate(signal: WorldSignal): EventCase {
  const kind = caseKindFromSignal(signal);
  const primaryEntity = inferPrimaryEntity(signal);
  const eventAt = signalTimestamp(signal);
  const bucketStart = bucketStartIso(eventAt);
  const fingerprint = `${kind}:${normalizeEntity(primaryEntity)}:${bucketStart}:${signal.source_type}`;
  const payload = signal.payload;
  const assetSymbol =
    typeof payload.asset_symbol === "string" && payload.asset_symbol.trim().length > 0
      ? payload.asset_symbol.trim().toUpperCase()
      : null;
  const quoteSymbol =
    typeof payload.quote_symbol === "string" && payload.quote_symbol.trim().length > 0
      ? payload.quote_symbol.trim().toUpperCase()
      : "USD";
  const directPrice = typeof payload.price === "number" && Number.isFinite(payload.price) ? payload.price : null;
  const legacyPrice =
    typeof payload.current_price === "number" && Number.isFinite(payload.current_price) ? payload.current_price : null;
  const priceValue = directPrice ?? legacyPrice;

  const title =
    kind === "asset_price_observation"
      ? `${assetSymbol ?? primaryEntity} price observation`
      : signal.title;
  const summary =
    kind === "asset_price_observation" && priceValue !== null
      ? `${assetSymbol ?? primaryEntity}/${quoteSymbol} observed at ${formatNumber(priceValue)}.`
      : signal.summary.slice(0, 600);

  const candidate: EventCase = {
    id: randomUUID(),
    fingerprint,
    kind,
    title,
    summary,
    primary_entity: primaryEntity,
    source_types: [signal.source_type],
    source_adapters: [signal.source_adapter],
    signal_count: 0,
    first_signal_at: eventAt,
    last_signal_at: eventAt,
    status: "open",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const validation = validateEventCase({
    ...candidate,
    signal_count: 1,
  });
  if (!validation.ok) {
    throw new Error(`invalid_event_case_candidate:${validation.errors.join(",")}`);
  }

  return candidate;
}

async function fetchRecentSignals(limit: number) {
  const result = await pool.query<WorldSignalRow>(
    `
      SELECT signals.*
      FROM world_signals signals
      LEFT JOIN event_case_signals links
        ON links.signal_id = signals.id
      WHERE signals.fetched_at >= NOW() - ($1::text || ' hours')::interval
        AND links.signal_id IS NULL
        AND NOT (
          signals.source_type = 'price_feed'
          AND COALESCE(signals.payload->>'kind', '') = 'price_threshold'
        )
      ORDER BY signals.fetched_at DESC, signals.id DESC
      LIMIT $2
    `,
    [lookbackHours, limit],
  );

  return result.rows.map(mapSignalRow);
}

async function cleanupLegacySyntheticPriceCases() {
  await pool.query(
    `
      DELETE FROM event_cases cases
      WHERE
        cases.kind = 'asset_price_observation'
        AND EXISTS (
          SELECT 1
          FROM event_case_signals links
          INNER JOIN world_signals signals
            ON signals.id = links.signal_id
          WHERE
            links.event_case_id = cases.id
            AND signals.source_type = 'price_feed'
            AND COALESCE(signals.payload->>'kind', '') = 'price_threshold'
        )
    `,
  );
}

async function upsertEventCase(candidate: EventCase) {
  const result = await pool.query<EventCaseRow>(
    `
      INSERT INTO event_cases (
        id,
        fingerprint,
        kind,
        title,
        summary,
        primary_entity,
        source_types,
        source_adapters,
        signal_count,
        first_signal_at,
        last_signal_at,
        status,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 0, $9::timestamptz, $10::timestamptz, 'open', NOW(), NOW()
      )
      ON CONFLICT (fingerprint) DO UPDATE SET
        title = CASE WHEN event_cases.last_signal_at <= EXCLUDED.last_signal_at THEN EXCLUDED.title ELSE event_cases.title END,
        summary = CASE WHEN event_cases.last_signal_at <= EXCLUDED.last_signal_at THEN EXCLUDED.summary ELSE event_cases.summary END,
        first_signal_at = LEAST(event_cases.first_signal_at, EXCLUDED.first_signal_at),
        last_signal_at = GREATEST(event_cases.last_signal_at, EXCLUDED.last_signal_at),
        source_types = (
          SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
          FROM jsonb_array_elements_text(event_cases.source_types || EXCLUDED.source_types) AS merged(value)
        ),
        source_adapters = (
          SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
          FROM jsonb_array_elements_text(event_cases.source_adapters || EXCLUDED.source_adapters) AS merged(value)
        ),
        status = CASE WHEN event_cases.status = 'closed' THEN 'stale' ELSE event_cases.status END,
        updated_at = NOW()
      RETURNING *
    `,
    [
      candidate.id,
      candidate.fingerprint,
      candidate.kind,
      candidate.title,
      candidate.summary,
      candidate.primary_entity,
      JSON.stringify(candidate.source_types),
      JSON.stringify(candidate.source_adapters),
      candidate.first_signal_at,
      candidate.last_signal_at,
    ],
  );

  return mapEventCaseRow(result.rows[0]);
}

async function linkSignalToCase(eventCaseId: string, signal: WorldSignal) {
  const role = signal.source_type === "price_feed" ? "primary" : "supporting";
  const linkResult = await pool.query(
    `
      INSERT INTO event_case_signals (event_case_id, signal_id, role, added_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (event_case_id, signal_id) DO NOTHING
    `,
    [eventCaseId, signal.id, role],
  );

  if ((linkResult.rowCount ?? 0) === 0) {
    return 0;
  }

  await pool.query(
    `
      UPDATE event_cases
      SET
        signal_count = signal_count + 1,
        first_signal_at = LEAST(first_signal_at, $2::timestamptz),
        last_signal_at = GREATEST(last_signal_at, $2::timestamptz),
        updated_at = NOW()
      WHERE id = $1
    `,
    [eventCaseId, signalTimestamp(signal)],
  );
  return 1;
}

async function refreshCaseStatuses() {
  await pool.query(
    `
      UPDATE event_cases
      SET
        status = CASE
          WHEN last_signal_at < NOW() - ($1::text || ' hours')::interval THEN 'closed'
          WHEN last_signal_at < NOW() - ($2::text || ' hours')::interval THEN 'stale'
          ELSE 'open'
        END,
        updated_at = NOW()
      WHERE status IS DISTINCT FROM CASE
        WHEN last_signal_at < NOW() - ($1::text || ' hours')::interval THEN 'closed'
        WHEN last_signal_at < NOW() - ($2::text || ' hours')::interval THEN 'stale'
        ELSE 'open'
      END
    `,
    [closeAfterHours, staleAfterHours],
  );
}

async function tick() {
  if (tickInFlight) {
    return;
  }

  tickInFlight = true;
  try {
    const recentSignals = await fetchRecentSignals(maxSignalsPerTick);
    let linkedSignals = 0;
    for (const signal of recentSignals) {
      const candidate = buildEventCaseCandidate(signal);
      const eventCase = await upsertEventCase(candidate);
      linkedSignals += await linkSignalToCase(eventCase.id, signal);
    }
    await refreshCaseStatuses();

    lastProcessedSignals = recentSignals.length;
    lastLinkedSignals = linkedSignals;
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

app.get("/health", async () => {
  const counts = await pool.query<{ open_count: string; stale_count: string; closed_count: string }>(
    `
      SELECT
        COUNT(*) FILTER (WHERE status = 'open') AS open_count,
        COUNT(*) FILTER (WHERE status = 'stale') AS stale_count,
        COUNT(*) FILTER (WHERE status = 'closed') AS closed_count
      FROM event_cases
    `,
  );

  return {
    service: "event-builder",
    status: "ok",
    open_case_count: Number(counts.rows[0]?.open_count ?? 0),
    stale_case_count: Number(counts.rows[0]?.stale_count ?? 0),
    closed_case_count: Number(counts.rows[0]?.closed_count ?? 0),
    last_tick_at: lastTickAt,
    last_tick_error: lastTickError,
    last_processed_signals: lastProcessedSignals,
    last_linked_signals: lastLinkedSignals,
  };
});

app.post("/v1/internal/event-builder/run-once", async () => {
  await tick();
  return {
    status: "ok",
    last_tick_at: lastTickAt,
    last_tick_error: lastTickError,
    last_processed_signals: lastProcessedSignals,
    last_linked_signals: lastLinkedSignals,
  };
});

app.get("/v1/internal/event-cases", async (request) => {
  const query = request.query as { limit?: string; status?: EventCaseStatus };
  const limit = Math.max(1, Math.min(200, Number(query.limit ?? "50") || 50));

  if (query.status && !["open", "stale", "closed"].includes(query.status)) {
    return { items: [] };
  }

  const result = query.status
    ? await pool.query<EventCaseRow>(
        `
          SELECT *
          FROM event_cases
          WHERE status = $1
          ORDER BY last_signal_at DESC, id DESC
          LIMIT $2
        `,
        [query.status, limit],
      )
    : await pool.query<EventCaseRow>(
        `
          SELECT *
          FROM event_cases
          ORDER BY last_signal_at DESC, id DESC
          LIMIT $1
        `,
        [limit],
      );

  return {
    items: result.rows.map(mapEventCaseRow),
  };
});

app.get("/v1/internal/event-cases/:eventCaseId/signals", async (request, reply) => {
  const eventCaseId = (request.params as { eventCaseId: string }).eventCaseId;
  const eventCaseResult = await pool.query<EventCaseRow>(
    `
      SELECT *
      FROM event_cases
      WHERE id = $1
      LIMIT 1
    `,
    [eventCaseId],
  );

  if ((eventCaseResult.rowCount ?? 0) === 0) {
    reply.code(404);
    return { error: "event_case_not_found" };
  }

  const signalRows = await pool.query<WorldSignalRow>(
    `
      SELECT signals.*
      FROM event_case_signals links
      INNER JOIN world_signals signals
        ON signals.id = links.signal_id
      WHERE links.event_case_id = $1
      ORDER BY signals.fetched_at DESC, signals.id DESC
      LIMIT 200
    `,
    [eventCaseId],
  );

  return {
    event_case: mapEventCaseRow(eventCaseResult.rows[0]),
    signals: signalRows.rows.map(mapSignalRow),
  };
});

async function start() {
  await ensureCoreSchema(pool);
  await cleanupLegacySyntheticPriceCases();
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
