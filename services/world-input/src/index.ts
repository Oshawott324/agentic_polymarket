import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { createDatabasePool, ensureCoreSchema, parseJsonField, toIsoTimestamp } from "@automakit/persistence";
import {
  buildDedupeKey,
  inferEntityRefs,
  sourceAdapterToSignalType,
  type SourceAdapterKind,
  type WorldEntityRef,
  type WorldInputSourceConfig,
  type WorldSignal,
  validateWorldInputSourceConfig,
  validateWorldSignal,
} from "@automakit/world-sim";

type WorldSignalRow = {
  id: string;
  source_type: WorldSignal["source_type"];
  source_adapter: SourceAdapterKind;
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

type WorldInputCursorRow = {
  source_key: string;
  cursor_value: string | null;
  last_polled_at: unknown;
  next_poll_at: unknown;
  backoff_until: unknown;
  failure_count: number;
  last_error: string | null;
  updated_at: unknown;
};

const port = Number(process.env.WORLD_INPUT_PORT ?? 4010);
const intervalMs = Number(process.env.WORLD_INPUT_INTERVAL_MS ?? 1000);
const backoffBaseMs = Number(process.env.WORLD_INPUT_BACKOFF_BASE_MS ?? 1000);
const backoffMaxMs = Number(process.env.WORLD_INPUT_BACKOFF_MAX_MS ?? 60_000);
const app = Fastify({ logger: true });
const pool = createDatabasePool();

let tickInFlight = false;
let lastTickAt: string | null = null;
let lastTickError: string | null = null;

function parseSourceConfigs() {
  const raw = process.env.WORLD_INPUT_SOURCES_JSON ?? "[]";
  const parsed = JSON.parse(raw) as unknown[];
  const configs: WorldInputSourceConfig[] = [];

  for (const entry of parsed) {
    const validation = validateWorldInputSourceConfig(entry);
    if (!validation.ok) {
      throw new Error(`invalid_world_input_source:${validation.errors.join(",")}`);
    }
    configs.push(validation.config);
  }

  return configs;
}

const sourceConfigs = parseSourceConfigs();

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

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function ensureObjectPayload(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function normalizeSignalFromItem(source: WorldInputSourceConfig, item: unknown): WorldSignal {
  const input = ensureObjectPayload(item);
  const payload = ensureObjectPayload(input.payload);
  const mergedPayload = Object.keys(payload).length > 0 ? payload : input;
  const effectiveAt =
    normalizeTimestamp(input.effective_at) ??
    normalizeTimestamp(input.target_time) ??
    normalizeTimestamp(input.observed_at) ??
    normalizeTimestamp(mergedPayload.effective_at) ??
    normalizeTimestamp(mergedPayload.target_time) ??
    normalizeTimestamp(mergedPayload.observed_at);
  const sourceId =
    typeof input.source_id === "string"
      ? input.source_id
      : typeof input.id === "string"
        ? input.id
        : buildDedupeKey({
            source: source.key,
            title: input.title ?? input.headline ?? input.name ?? "signal",
            effective_at: effectiveAt,
          });
  const sourceUrl =
    typeof input.source_url === "string"
      ? input.source_url
      : typeof input.url === "string"
        ? input.url
        : source.url ?? "internal://market";
  const entityRefs =
    Array.isArray(input.entity_refs) && input.entity_refs.every((entry) => entry && typeof entry === "object")
      ? (input.entity_refs as WorldEntityRef[])
      : inferEntityRefs(mergedPayload);
  const signal: WorldSignal = {
    id: randomUUID(),
    source_type: sourceAdapterToSignalType(source.adapter),
    source_adapter: source.adapter,
    source_id: sourceId,
    source_url: sourceUrl,
    trust_tier: source.trust_tier,
    title:
      typeof input.title === "string"
        ? input.title
        : typeof input.headline === "string"
          ? input.headline
          : typeof input.name === "string"
            ? input.name
            : `${source.key}:${sourceId}`,
    summary:
      typeof input.summary === "string"
        ? input.summary
        : typeof input.description === "string"
          ? input.description
          : typeof input.title === "string"
            ? input.title
            : `${source.key}:${sourceId}`,
    payload: mergedPayload,
    entity_refs: entityRefs,
    dedupe_key: buildDedupeKey({
      source_key: source.key,
      source_id: sourceId,
      source_url: sourceUrl,
      effective_at: effectiveAt,
      title: input.title ?? input.headline ?? input.name ?? null,
      payload: mergedPayload,
    }),
    fetched_at: new Date().toISOString(),
    effective_at: effectiveAt,
    created_at: new Date().toISOString(),
  };

  const validation = validateWorldSignal(signal);
  if (!validation.ok) {
    throw new Error(`invalid_world_signal:${validation.errors.join(",")}`);
  }

  return validation.signal;
}

async function ensureCursor(source: WorldInputSourceConfig) {
  const now = new Date().toISOString();
  await pool.query(
    `
      INSERT INTO world_input_cursors (
        source_key,
        cursor_value,
        last_polled_at,
        next_poll_at,
        backoff_until,
        failure_count,
        last_error,
        updated_at
      )
      VALUES ($1, NULL, NULL, $2::timestamptz, NULL, 0, NULL, $2::timestamptz)
      ON CONFLICT (source_key) DO NOTHING
    `,
    [source.key, now],
  );
}

async function getCursor(sourceKey: string) {
  const result = await pool.query<WorldInputCursorRow>(
    `
      SELECT *
      FROM world_input_cursors
      WHERE source_key = $1
    `,
    [sourceKey],
  );

  return result.rowCount ? result.rows[0] : null;
}

async function upsertSignal(signal: WorldSignal) {
  await pool.query(
    `
      INSERT INTO world_signals (
        id,
        source_type,
        source_adapter,
        source_id,
        source_url,
        trust_tier,
        title,
        summary,
        payload,
        entity_refs,
        dedupe_key,
        fetched_at,
        effective_at,
        created_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12::timestamptz, $13::timestamptz, $14::timestamptz
      )
      ON CONFLICT (dedupe_key) DO NOTHING
    `,
    [
      signal.id,
      signal.source_type,
      signal.source_adapter,
      signal.source_id,
      signal.source_url,
      signal.trust_tier,
      signal.title,
      signal.summary,
      JSON.stringify(signal.payload),
      JSON.stringify(signal.entity_refs),
      signal.dedupe_key,
      signal.fetched_at,
      signal.effective_at,
      signal.created_at,
    ],
  );
}

async function fetchSourceItems(source: WorldInputSourceConfig) {
  if (source.adapter === "market_internal") {
    return [] as unknown[];
  }

  const response = await fetch(source.url!, {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`world_input_source_fetch_failed:${source.key}:${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object" && Array.isArray((payload as { items?: unknown[] }).items)) {
    return (payload as { items: unknown[] }).items;
  }
  return [payload];
}

async function updateCursorOnSuccess(source: WorldInputSourceConfig) {
  await pool.query(
    `
      UPDATE world_input_cursors
      SET
        last_polled_at = NOW(),
        next_poll_at = NOW() + ($2 * INTERVAL '1 second'),
        backoff_until = NULL,
        failure_count = 0,
        last_error = NULL,
        updated_at = NOW()
      WHERE source_key = $1
    `,
    [source.key, source.poll_interval_seconds],
  );
}

async function updateCursorOnFailure(source: WorldInputSourceConfig, failureCount: number, errorMessage: string) {
  const backoffMs = Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.max(0, failureCount));
  await pool.query(
    `
      UPDATE world_input_cursors
      SET
        last_polled_at = NOW(),
        next_poll_at = NOW() + ($2 * INTERVAL '1 millisecond'),
        backoff_until = NOW() + ($2 * INTERVAL '1 millisecond'),
        failure_count = failure_count + 1,
        last_error = $3,
        updated_at = NOW()
      WHERE source_key = $1
    `,
    [source.key, backoffMs, errorMessage],
  );
}

async function pollSource(source: WorldInputSourceConfig, cursor: WorldInputCursorRow) {
  const nextPollAt = new Date(String(cursor.next_poll_at)).getTime();
  const backoffUntil = cursor.backoff_until ? new Date(String(cursor.backoff_until)).getTime() : null;
  const now = Date.now();
  if (nextPollAt > now) {
    return;
  }
  if (backoffUntil && backoffUntil > now) {
    return;
  }

  try {
    const items = await fetchSourceItems(source);
    for (const item of items) {
      const signal = normalizeSignalFromItem(source, item);
      await upsertSignal(signal);
    }
    await updateCursorOnSuccess(source);
  } catch (error) {
    await updateCursorOnFailure(source, Number(cursor.failure_count), String(error));
    throw error;
  }
}

async function tick() {
  if (tickInFlight) {
    return;
  }

  tickInFlight = true;
  try {
    for (const source of sourceConfigs) {
      await ensureCursor(source);
      const cursor = await getCursor(source.key);
      if (!cursor) {
        continue;
      }
      await pollSource(source, cursor);
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
  service: "world-input",
  status: "ok",
  configured_sources: sourceConfigs.map((source) => source.key),
  last_tick_at: lastTickAt,
  last_tick_error: lastTickError,
}));

app.get("/v1/internal/world-signals", async (request) => {
  const limit = Math.max(1, Math.min(200, Number((request.query as { limit?: string }).limit ?? "50") || 50));
  const result = await pool.query<WorldSignalRow>(
    `
      SELECT *
      FROM world_signals
      ORDER BY created_at DESC, id DESC
      LIMIT $1
    `,
    [limit],
  );

  return {
    items: result.rows.map(mapSignalRow),
  };
});

async function start() {
  await ensureCoreSchema(pool);
  for (const source of sourceConfigs) {
    await ensureCursor(source);
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
