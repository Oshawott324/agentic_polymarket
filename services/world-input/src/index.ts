import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import Fastify from "fastify";
import { createDatabasePool, ensureCoreSchema, parseJsonField, toIsoTimestamp } from "@automakit/persistence";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import {
  buildDedupeKey,
  defaultSignalRoleForAdapter,
  inferEntityRefs,
  normalizeWorldSignalRole,
  sourceAdapterToSignalType,
  type SourceAdapterKind,
  type TrustTier,
  type WorldEntityRef,
  type WorldInputSourceConfig,
  type WorldSignal,
  validateWorldInputSourceConfig,
  validateWorldSignal,
} from "@automakit/world-sim";

type WorldInputAdapterKind =
  | SourceAdapterKind
  | "opencli_command"
  | "x_api_recent_search"
  | "reddit_api_subreddit_new"
  | "news_rss";

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

type WorldInputSourceRow = {
  id: string;
  key: string;
  adapter: WorldInputAdapterKind;
  kind: string;
  status: string;
  enabled: boolean;
  poll_interval_seconds: number;
  source_url: string | null;
  trust_tier: TrustTier;
  config_json: unknown;
  auth_secret_ref: string | null;
  cursor_value: string | null;
  last_polled_at: unknown;
  next_poll_at: unknown;
  backoff_until: unknown;
  failure_count: number;
  last_error: string | null;
  created_at: unknown;
  updated_at: unknown;
};

type SourceWithConfig = {
  id: string;
  key: string;
  adapter: WorldInputAdapterKind;
  kind: string;
  status: string;
  enabled: boolean;
  poll_interval_seconds: number;
  source_url: string | null;
  trust_tier: TrustTier;
  config_json: Record<string, unknown>;
  auth_secret_ref: string | null;
  cursor_value: string | null;
  last_polled_at: string | null;
  next_poll_at: string;
  backoff_until: string | null;
  failure_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type SourcePollResult = {
  items: Record<string, unknown>[];
  next_cursor: string | null;
  metadata: Record<string, unknown>;
};

type SourceTestResponse = {
  source: SourceWithConfig;
  fetched_count: number;
  next_cursor: string | null;
  sample_signals: WorldSignal[];
};

const port = Number(process.env.WORLD_INPUT_PORT ?? 4010);
const intervalMs = Number(process.env.WORLD_INPUT_INTERVAL_MS ?? 1000);
const backoffBaseMs = Number(process.env.WORLD_INPUT_BACKOFF_BASE_MS ?? 1000);
const backoffMaxMs = Number(process.env.WORLD_INPUT_BACKOFF_MAX_MS ?? 60_000);
const claimBatchSize = Math.max(1, Number(process.env.WORLD_INPUT_CLAIM_BATCH_SIZE ?? 8));
const claimLeaseMs = Math.max(1_000, Number(process.env.WORLD_INPUT_CLAIM_LEASE_MS ?? 30_000));
const maxSourcesPerTick = Math.max(claimBatchSize, Number(process.env.WORLD_INPUT_MAX_SOURCES_PER_TICK ?? 64));
const sourceConcurrency = Math.max(1, Number(process.env.WORLD_INPUT_SOURCE_CONCURRENCY ?? claimBatchSize));
const app = Fastify({ logger: true });
const pool = createDatabasePool();
const execFileAsync = promisify(execFile);

const outboundProxyUrl =
  process.env.HTTPS_PROXY ??
  process.env.https_proxy ??
  process.env.HTTP_PROXY ??
  process.env.http_proxy ??
  process.env.ALL_PROXY ??
  process.env.all_proxy;

if (outboundProxyUrl) {
  try {
    setGlobalDispatcher(new ProxyAgent(outboundProxyUrl));
    app.log.info({ outbound_proxy_url: outboundProxyUrl }, "world_input_proxy_enabled");
  } catch (error) {
    app.log.error({ err: error }, "world_input_proxy_configuration_failed");
  }
}

let tickInFlight = false;
let lastTickAt: string | null = null;
let lastTickError: string | null = null;

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...(parsed as Record<string, unknown>) }
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readPath(root: unknown, path: string) {
  const segments = path
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  let current: unknown = root;
  for (const segment of segments) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

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

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

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

function mapSourceRow(row: WorldInputSourceRow): SourceWithConfig {
  return {
    id: row.id,
    key: row.key,
    adapter: row.adapter,
    kind: row.kind,
    status: row.status,
    enabled: row.enabled,
    poll_interval_seconds: row.poll_interval_seconds,
    source_url: row.source_url,
    trust_tier: row.trust_tier,
    config_json: parseJsonObject(row.config_json),
    auth_secret_ref: row.auth_secret_ref,
    cursor_value: row.cursor_value,
    last_polled_at: row.last_polled_at ? toIsoTimestamp(row.last_polled_at) : null,
    next_poll_at: toIsoTimestamp(row.next_poll_at),
    backoff_until: row.backoff_until ? toIsoTimestamp(row.backoff_until) : null,
    failure_count: Number(row.failure_count),
    last_error: row.last_error,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  };
}

function sourceKindFromAdapter(adapter: WorldInputAdapterKind): string {
  switch (adapter) {
    case "opencli_command":
      return "news";
    case "x_api_recent_search":
    case "reddit_api_subreddit_new":
      return "social";
    case "news_rss":
      return "news";
    case "http_json_calendar":
      return "calendar";
    case "http_json_price":
    case "http_csv_price":
      return "price";
    case "http_json_filing":
      return "filing";
    case "http_json_official_announcement":
      return "official";
    case "market_internal":
      return "internal";
    default:
      return "external";
  }
}

function sanitizeSummary(value: string | null, fallback: string) {
  if (!value) {
    return fallback;
  }
  return value.replace(/\s+/g, " ").trim().slice(0, 600) || fallback;
}

function stripHtml(value: string) {
  return value
    .replace(/<!\[CDATA\[(.*?)\]\]>/gis, "$1")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAssetEntityRefs(text: string) {
  const refs: WorldEntityRef[] = [];
  const matches = text.match(/\$[A-Z]{2,10}/g) ?? [];
  const seen = new Set<string>();
  for (const match of matches) {
    const symbol = match.slice(1);
    if (!seen.has(symbol)) {
      seen.add(symbol);
      refs.push({ kind: "asset", value: symbol });
    }
  }
  return refs;
}

function ensureObjectPayload(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function resolveConfigPathValue(input: Record<string, unknown>, payload: Record<string, unknown>, path: string) {
  return readPath(input, path) ?? readPath(payload, path);
}

function normalizePublishCategory(value: string | null) {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "met":
    case "meteorological":
      return "weather";
    case "geo":
    case "geological":
      return "weather";
    default:
      return normalized;
  }
}

function inferSignalRole(
  source: SourceWithConfig,
  payload: Record<string, unknown>,
  normalizedCategory: string | null,
) {
  const configuredRole = normalizeWorldSignalRole(asString(source.config_json.signal_role));
  if (configuredRole) {
    return configuredRole;
  }

  const payloadRole = normalizeWorldSignalRole(payload.signal_role);
  if (payloadRole) {
    return payloadRole;
  }

  if (source.adapter === "opencli_command" && normalizedCategory === "markets") {
    return "precursor";
  }
  if (
    (source.adapter === "opencli_command" || source.adapter === "x_api_recent_search" || source.adapter === "reddit_api_subreddit_new") &&
    normalizedCategory &&
    ["sports", "weather", "world", "business", "technology", "politics"].includes(normalizedCategory)
  ) {
    return "precursor";
  }

  return defaultSignalRoleForAdapter(source.adapter);
}

function buildSignalPayloadEnrichments(
  source: SourceWithConfig,
  input: Record<string, unknown>,
  payload: Record<string, unknown>,
  sourceUrl: string | null,
) {
  const config = source.config_json;
  const enrichments: Record<string, unknown> = {};
  const rawPayloadCategory = asString(payload.category);
  const configuredCategory = normalizePublishCategory(asString(config.category));
  const payloadCategory = normalizePublishCategory(rawPayloadCategory);
  const normalizedCategory =
    configuredCategory && (!payloadCategory || payloadCategory === "weather" || payloadCategory === "met")
      ? configuredCategory
      : payloadCategory ?? configuredCategory;
  const signalRole = inferSignalRole(source, payload, normalizedCategory);

  const shouldDefaultAgentExtract =
    asString(payload.resolution_extraction_mode) === null &&
    asString(config.resolution_extraction_mode) === null &&
    source.trust_tier !== "derived" &&
    (
      source.adapter === "http_json_official_announcement" ||
      ((source.adapter === "news_rss" || source.adapter === "opencli_command") &&
        normalizedCategory !== null &&
        ["sports", "weather", "world", "business", "technology", "politics"].includes(normalizedCategory))
    );
  if (normalizedCategory && normalizedCategory !== rawPayloadCategory?.trim().toLowerCase()) {
    enrichments.category = normalizedCategory;
  }
  if (signalRole && normalizeWorldSignalRole(payload.signal_role) === null) {
    enrichments.signal_role = signalRole;
  }

  const extractionMode = asString(config.resolution_extraction_mode) ?? (shouldDefaultAgentExtract ? "agent_extract" : null);
  if (extractionMode && asString(payload.resolution_extraction_mode) === null) {
    enrichments.resolution_extraction_mode = extractionMode;
  }

  const observationOccurrencePath =
    asString(config.observation_occurrence_path) ??
    ((source.adapter === "news_rss" || source.adapter === "http_json_official_announcement" || source.adapter === "opencli_command")
      && extractionMode === "agent_extract"
      ? "occurred"
      : null);
  if (observationOccurrencePath && asString(payload.observation_occurrence_path) === null) {
    enrichments.observation_occurrence_path = observationOccurrencePath;
  }

  const observationPricePath = asString(config.observation_price_path);
  if (observationPricePath && asString(payload.observation_price_path) === null) {
    enrichments.observation_price_path = observationPricePath;
  }

  const directCanonicalSourceUrl = asString(config.canonical_source_url);
  const canonicalSourceUrlPath = asString(config.canonical_source_url_path);
  const canonicalSourceUrl =
    (canonicalSourceUrlPath
      ? asString(resolveConfigPathValue(input, payload, canonicalSourceUrlPath))
      : null) ??
    directCanonicalSourceUrl ??
    ((source.adapter === "news_rss" || source.adapter === "opencli_command" || source.adapter === "http_json_official_announcement")
      ? sourceUrl
      : null);
  if (canonicalSourceUrl && asString(payload.canonical_source_url) === null) {
    enrichments.canonical_source_url = canonicalSourceUrl;
  }

  const eventName =
    (asString(config.event_name_path)
      ? asString(resolveConfigPathValue(input, payload, asString(config.event_name_path)!))
      : null) ??
    asString(config.event_name) ??
    asString(input.title) ??
    asString(payload.title) ??
    asString(resolveConfigPathValue(input, payload, "properties.headline")) ??
    asString(resolveConfigPathValue(input, payload, "properties.event"));
  if (eventName && asString(payload.event_name) === null) {
    enrichments.event_name = eventName;
  }

  if (normalizedCategory === "sports" && asString(payload.publishability_class) === null) {
    enrichments.publishability_class = "sports_event";
  } else if (normalizedCategory === "weather" && asString(payload.publishability_class) === null) {
    enrichments.publishability_class = "weather_event";
  } else if (
    (source.adapter === "http_json_official_announcement" || source.kind === "official") &&
    asString(payload.publishability_class) === null
  ) {
    enrichments.publishability_class = "official_news";
  }

  return enrichments;
}

function extractArrayItemsFromPayload(payload: unknown, itemsPath?: string | null) {
  if (Array.isArray(payload)) {
    return payload
      .map((entry) => ensureObjectPayload(entry))
      .filter((entry) => Object.keys(entry).length > 0);
  }

  const objectPayload = ensureObjectPayload(payload);
  const configuredItems = itemsPath ? readPath(objectPayload, itemsPath) : undefined;
  const implicitItems =
    configuredItems === undefined && Array.isArray(objectPayload.items) ? objectPayload.items : configuredItems;

  if (Array.isArray(implicitItems)) {
    return implicitItems
      .map((entry) => ensureObjectPayload(entry))
      .filter((entry) => Object.keys(entry).length > 0);
  }

  return Object.keys(objectPayload).length > 0 ? [objectPayload] : [];
}

function extractXmlTag(source: string, tag: string) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = regex.exec(source);
  return match ? stripHtml(match[1]) : null;
}

function extractXmlLink(block: string) {
  const atomLink = /<link[^>]*href=["']([^"']+)["'][^>]*>/i.exec(block);
  if (atomLink?.[1]) {
    return atomLink[1].trim();
  }
  return extractXmlTag(block, "link");
}

function parseCompactUtcTimestamp(dateRaw: string | null, timeRaw: string | null) {
  if (!dateRaw || !/^\d{8}$/.test(dateRaw)) {
    return null;
  }
  const year = Number(dateRaw.slice(0, 4));
  const month = Number(dateRaw.slice(4, 6));
  const day = Number(dateRaw.slice(6, 8));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  const hh = timeRaw && /^\d{6}$/.test(timeRaw) ? Number(timeRaw.slice(0, 2)) : 0;
  const mm = timeRaw && /^\d{6}$/.test(timeRaw) ? Number(timeRaw.slice(2, 4)) : 0;
  const ss = timeRaw && /^\d{6}$/.test(timeRaw) ? Number(timeRaw.slice(4, 6)) : 0;
  const millis = Date.UTC(year, month - 1, day, hh, mm, ss, 0);
  if (!Number.isFinite(millis)) {
    return null;
  }
  return new Date(millis).toISOString();
}

function parseRssEntries(xml: string) {
  const entries: Array<Record<string, unknown>> = [];
  const itemMatches = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  for (const block of itemMatches) {
    entries.push({
      source_id: extractXmlTag(block, "guid") ?? extractXmlLink(block),
      source_url: extractXmlLink(block),
      title: extractXmlTag(block, "title"),
      summary: extractXmlTag(block, "description"),
      effective_at: extractXmlTag(block, "pubDate"),
      payload: {
        title: extractXmlTag(block, "title"),
        description: extractXmlTag(block, "description"),
        pubDate: extractXmlTag(block, "pubDate"),
        guid: extractXmlTag(block, "guid"),
        link: extractXmlLink(block),
      },
    });
  }

  if (entries.length > 0) {
    return entries;
  }

  const atomMatches = xml.match(/<entry[\s\S]*?<\/entry>/gi) ?? [];
  for (const block of atomMatches) {
    entries.push({
      source_id: extractXmlTag(block, "id") ?? extractXmlLink(block),
      source_url: extractXmlLink(block),
      title: extractXmlTag(block, "title"),
      summary: extractXmlTag(block, "summary") ?? extractXmlTag(block, "content"),
      effective_at: extractXmlTag(block, "updated") ?? extractXmlTag(block, "published"),
      payload: {
        title: extractXmlTag(block, "title"),
        summary: extractXmlTag(block, "summary"),
        content: extractXmlTag(block, "content"),
        id: extractXmlTag(block, "id"),
        updated: extractXmlTag(block, "updated"),
        published: extractXmlTag(block, "published"),
        link: extractXmlLink(block),
      },
    });
  }

  return entries;
}

function parseBootstrapSourceConfigs() {
  const raw = process.env.WORLD_INPUT_BOOTSTRAP_SOURCES_JSON ?? process.env.WORLD_INPUT_SOURCES_JSON ?? "[]";
  try {
    const parsed = JSON.parse(raw) as unknown[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function configWithoutKnownKeys(input: Record<string, unknown>) {
  const clone = { ...input };
  delete clone.key;
  delete clone.adapter;
  delete clone.url;
  delete clone.poll_interval_seconds;
  delete clone.backfill_hours;
  delete clone.trust_tier;
  delete clone.auth_secret_ref;
  delete clone.status;
  delete clone.enabled;
  delete clone.kind;
  return clone;
}

function cursorAsNumber(cursor: string | null) {
  if (!cursor) {
    return null;
  }
  const numeric = Number(cursor);
  return Number.isFinite(numeric) ? numeric : null;
}

function resolveBearerToken(source: SourceWithConfig) {
  const config = source.config_json;
  if (source.auth_secret_ref) {
    const token = process.env[source.auth_secret_ref];
    if (token && token.trim().length > 0) {
      return token.trim();
    }
    throw new Error(`world_input_source_missing_secret:${source.key}:${source.auth_secret_ref}`);
  }
  if (typeof config.auth_bearer === "string" && config.auth_bearer.trim().length > 0) {
    return config.auth_bearer.trim();
  }
  return null;
}

async function upsertSignal(signal: WorldSignal) {
  const result = await pool.query<{ id: string }>(
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
      RETURNING id
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

  return (result.rowCount ?? 0) > 0;
}

function normalizeSignalFromItem(source: SourceWithConfig, item: Record<string, unknown>): WorldSignal {
  const config = source.config_json;
  const input = ensureObjectPayload(item);
  const basePayload = ensureObjectPayload(input.payload);
  const payload =
    (() => {
      const payloadPath = asString(config.payload_path);
      if (!payloadPath) {
        return basePayload;
      }
      const resolved = resolveConfigPathValue(input, basePayload, payloadPath);
      return ensureObjectPayload(resolved);
    })() || basePayload;
  const resolveConfiguredString = (pathKey: string, fallback: string | null = null) => {
    const path = asString(config[pathKey]);
    if (!path) {
      return fallback;
    }
    return asString(resolveConfigPathValue(input, payload, path)) ?? fallback;
  };
  const configuredEffectiveAt =
    (() => {
      const path = asString(config.effective_at_path);
      if (!path) {
        return null;
      }
      return normalizeTimestamp(resolveConfigPathValue(input, payload, path));
    })();
  const effectiveAt =
    configuredEffectiveAt ??
    normalizeTimestamp(input.effective_at) ??
    normalizeTimestamp(input.target_time) ??
    normalizeTimestamp(input.observed_at) ??
    normalizeTimestamp(payload.effective_at) ??
    normalizeTimestamp(payload.target_time) ??
    normalizeTimestamp(payload.observed_at) ??
    normalizeTimestamp(resolveConfigPathValue(input, payload, "properties.sent")) ??
    normalizeTimestamp(resolveConfigPathValue(input, payload, "properties.effective"));
  const sourceId =
    resolveConfiguredString("source_id_path") ??
    asString(input.source_id) ??
    asString(input.id) ??
    buildDedupeKey({
      source_key: source.key,
      title: input.title ?? input.headline ?? input.name ?? "signal",
      effective_at: effectiveAt,
      payload: Object.keys(payload).length > 0 ? payload : input,
    });
  const sourceUrl =
    resolveConfiguredString("source_url_path") ??
    asString(input.source_url) ??
    asString(input.url) ??
    asString(resolveConfigPathValue(input, payload, "id")) ??
    source.source_url ??
    "internal://world-input";
  const payloadBase = Object.keys(payload).length > 0 ? payload : input;
  const mergedPayload = {
    ...payloadBase,
    ...buildSignalPayloadEnrichments(source, input, payloadBase, sourceUrl),
  };
  const entityRefs =
    Array.isArray(input.entity_refs) && input.entity_refs.every((entry) => entry && typeof entry === "object")
      ? (input.entity_refs as WorldEntityRef[])
      : [
          ...inferEntityRefs(mergedPayload),
          ...extractAssetEntityRefs(
            [asString(input.title), asString(input.summary), asString(input.description), asString(input.text)]
              .filter((value): value is string => Boolean(value))
              .join(" "),
          ),
        ];

  const title =
    resolveConfiguredString("title_path") ??
    asString(input.title) ??
    asString(input.headline) ??
    asString(input.name) ??
    asString(resolveConfigPathValue(input, payload, "properties.headline")) ??
    asString(resolveConfigPathValue(input, payload, "properties.event")) ??
    `${source.key}:${sourceId.slice(0, 20)}`;
  const summary = sanitizeSummary(
    resolveConfiguredString("summary_path") ??
      asString(input.summary) ??
      asString(input.description) ??
      asString(input.text) ??
      asString(resolveConfigPathValue(input, payload, "properties.description")) ??
      asString(resolveConfigPathValue(input, payload, "properties.areaDesc")),
    title,
  );
  const signal: WorldSignal = {
    id: randomUUID(),
    source_type: sourceAdapterToSignalType(source.adapter),
    source_adapter: source.adapter as WorldSignal["source_adapter"],
    source_id: sourceId,
    source_url: sourceUrl,
    trust_tier: source.trust_tier,
    title,
    summary,
    payload: mergedPayload,
    entity_refs: entityRefs,
    dedupe_key: buildDedupeKey({
      source_key: source.key,
      source_id: sourceId,
      source_url: sourceUrl,
      effective_at: effectiveAt,
      title,
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

async function fetchHttpJsonSourceItems(source: SourceWithConfig): Promise<SourcePollResult> {
  if (!source.source_url) {
    throw new Error(`world_input_source_url_missing:${source.key}`);
  }

  const response = await fetch(source.source_url, {
    headers: {
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`world_input_source_fetch_failed:${source.key}:${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  const items = extractArrayItemsFromPayload(payload, asString(source.config_json.items_path));

  return {
    items,
    next_cursor: source.cursor_value,
    metadata: { adapter: source.adapter },
  };
}

async function fetchOpenCliCommandItems(source: SourceWithConfig): Promise<SourcePollResult> {
  const config = source.config_json;
  const command = asString(config.command);
  if (!command) {
    throw new Error(`world_input_source_opencli_command_missing:${source.key}`);
  }

  const args = Array.isArray(config.args)
    ? config.args.map((value) => String(value))
    : [];
  const cwd = asString(config.cwd) ?? process.cwd();
  const timeoutMs = Math.max(1_000, Number(asNumber(config.timeout_ms) ?? 30_000));
  const maxBuffer = Math.max(1024 * 32, Number(asNumber(config.max_buffer_bytes) ?? 1024 * 1024));
  const envOverrides =
    config.env && typeof config.env === "object" && !Array.isArray(config.env)
      ? Object.fromEntries(
          Object.entries(config.env as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
        )
      : {};

  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd,
    env: {
      ...process.env,
      ...envOverrides,
    },
    timeout: timeoutMs,
    maxBuffer,
  });

  const trimmedStdout = stdout.trim();
  if (trimmedStdout.length === 0) {
    return {
      items: [],
      next_cursor: source.cursor_value,
      metadata: { adapter: source.adapter, command, stderr: stderr.trim() || null },
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(trimmedStdout);
  } catch {
    throw new Error(`world_input_source_opencli_output_not_json:${source.key}`);
  }

  const itemsPath = asString(config.items_path);
  const items = extractArrayItemsFromPayload(payload, itemsPath);
  const payloadObject = ensureObjectPayload(payload);
  const nextCursor = asString(payloadObject.next_cursor) ?? source.cursor_value;
  return {
    items,
    next_cursor: nextCursor,
    metadata: {
      adapter: source.adapter,
      command,
      args,
      stderr: stderr.trim() || null,
      items_path: itemsPath,
    },
  };
}

async function fetchHttpCsvPriceItems(source: SourceWithConfig): Promise<SourcePollResult> {
  if (!source.source_url) {
    throw new Error(`world_input_source_url_missing:${source.key}`);
  }

  const response = await fetch(source.source_url, {
    headers: {
      accept: "text/csv,text/plain,*/*",
    },
  });
  if (!response.ok) {
    throw new Error(`world_input_source_fetch_failed:${source.key}:${response.status}`);
  }

  const text = await response.text();
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {
      items: [],
      next_cursor: source.cursor_value,
      metadata: { adapter: source.adapter, format: "csv", row_count: 0 },
    };
  }

  const config = source.config_json;
  const lineIndex = Math.max(0, Number(asNumber(config.line_index) ?? 0));
  const dataLine = lines[Math.min(lineIndex, lines.length - 1)];
  const cells = dataLine.split(",").map((cell) => cell.trim());

  const symbolIndex = Math.max(0, Number(asNumber(config.symbol_index) ?? 0));
  const dateIndex = Math.max(0, Number(asNumber(config.date_index) ?? 1));
  const timeIndex = Math.max(0, Number(asNumber(config.time_index) ?? 2));
  const openIndex = Math.max(0, Number(asNumber(config.open_index) ?? 3));
  const highIndex = Math.max(0, Number(asNumber(config.high_index) ?? 4));
  const lowIndex = Math.max(0, Number(asNumber(config.low_index) ?? 5));
  const closeIndex = Math.max(0, Number(asNumber(config.close_index) ?? 6));
  const volumeIndex = Math.max(0, Number(asNumber(config.volume_index) ?? 7));

  const symbol = asString(cells[symbolIndex]) ?? asString(config.symbol_hint) ?? source.key;
  const dateRaw = asString(cells[dateIndex]);
  const timeRaw = asString(cells[timeIndex]);
  const close = asNumber(cells[closeIndex]);
  if (close === null || close <= 0) {
    throw new Error(`world_input_source_csv_close_invalid:${source.key}`);
  }
  const observedAt = parseCompactUtcTimestamp(dateRaw, timeRaw) ?? new Date().toISOString();
  const sourceId = buildDedupeKey({
    source_key: source.key,
    symbol,
    observed_at: observedAt,
    close,
  });

  return {
    items: [
      {
        source_id: sourceId,
        source_url: source.source_url,
        title: `${symbol} spot price observed`,
        summary: `${symbol} observed at ${close}.`,
        effective_at: observedAt,
        payload: {
          symbol,
          date: dateRaw,
          time: timeRaw,
          open: asNumber(cells[openIndex]),
          high: asNumber(cells[highIndex]),
          low: asNumber(cells[lowIndex]),
          close,
          volume: asNumber(cells[volumeIndex]),
        },
      },
    ],
    next_cursor: source.cursor_value,
    metadata: { adapter: source.adapter, format: "csv", row_count: 1 },
  };
}

async function fetchXRecentSearchItems(source: SourceWithConfig): Promise<SourcePollResult> {
  const config = source.config_json;
  const query = asString(config.query);
  if (!query && !source.source_url) {
    throw new Error(`world_input_source_x_query_required:${source.key}`);
  }

  const endpoint = source.source_url ?? "https://api.twitter.com/2/tweets/search/recent";
  const url = new URL(endpoint);
  if (query) {
    url.searchParams.set("query", query);
  }
  const maxResults = Math.max(10, Math.min(100, Number(asNumber(config.max_results) ?? 20)));
  url.searchParams.set("max_results", String(maxResults));
  if (!url.searchParams.has("tweet.fields")) {
    url.searchParams.set("tweet.fields", "created_at,author_id,lang,public_metrics");
  }
  if (source.cursor_value) {
    url.searchParams.set("since_id", source.cursor_value);
  }

  const token = resolveBearerToken(source);
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`world_input_source_x_fetch_failed:${source.key}:${response.status}`);
  }

  const payload = ensureObjectPayload(await response.json());
  const tweets = Array.isArray(payload.data) ? payload.data.map((entry) => ensureObjectPayload(entry)) : [];
  const meta = ensureObjectPayload(payload.meta);
  const nextCursor = asString(meta.newest_id) ?? source.cursor_value;

  const items = tweets.map((tweet) => {
    const tweetId = asString(tweet.id) ?? buildDedupeKey(tweet);
    const text = asString(tweet.text) ?? "";
    return {
      source_id: tweetId,
      source_url: `https://x.com/i/web/status/${tweetId}`,
      title: `X: ${text.slice(0, 120) || tweetId}`,
      summary: text,
      effective_at: asString(tweet.created_at),
      payload: {
        ...tweet,
        query,
      },
    };
  });

  return {
    items,
    next_cursor: nextCursor,
    metadata: {
      adapter: source.adapter,
      query,
      result_count: tweets.length,
    },
  };
}

async function fetchRedditSubredditItems(source: SourceWithConfig): Promise<SourcePollResult> {
  const config = source.config_json;
  const subreddit = asString(config.subreddit);
  const endpoint = source.source_url ?? (subreddit ? `https://www.reddit.com/r/${subreddit}/new.json` : null);
  if (!endpoint) {
    throw new Error(`world_input_source_reddit_subreddit_required:${source.key}`);
  }

  const url = new URL(endpoint);
  if (!url.searchParams.has("limit")) {
    const limit = Math.max(1, Math.min(100, Number(asNumber(config.limit) ?? 30)));
    url.searchParams.set("limit", String(limit));
  }

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "automakit-world-input/1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`world_input_source_reddit_fetch_failed:${source.key}:${response.status}`);
  }

  const payload = ensureObjectPayload(await response.json());
  const data = ensureObjectPayload(payload.data);
  const children = Array.isArray(data.children) ? data.children.map((entry) => ensureObjectPayload(entry)) : [];
  const posts = children
    .map((entry) => ensureObjectPayload(entry.data))
    .filter((entry) => Object.keys(entry).length > 0);

  const cursor = cursorAsNumber(source.cursor_value);
  const filtered = posts.filter((post) => {
    const createdUtc = asNumber(post.created_utc);
    if (createdUtc === null || cursor === null) {
      return true;
    }
    return createdUtc > cursor;
  });

  const newestCreatedUtc = filtered.reduce<number | null>((latest, post) => {
    const createdUtc = asNumber(post.created_utc);
    if (createdUtc === null) {
      return latest;
    }
    return latest === null || createdUtc > latest ? createdUtc : latest;
  }, cursor);
  const nextCursor = newestCreatedUtc === null ? source.cursor_value : String(newestCreatedUtc);

  const items = filtered.map((post) => {
    const postId = asString(post.id) ?? buildDedupeKey(post);
    const permalink = asString(post.permalink);
    const fullUrl = permalink ? `https://www.reddit.com${permalink}` : `https://www.reddit.com/comments/${postId}`;
    const title = asString(post.title) ?? `Reddit: ${postId}`;
    const selfText = asString(post.selftext);
    const createdUtc = asNumber(post.created_utc);
    return {
      source_id: postId,
      source_url: fullUrl,
      title,
      summary: selfText ?? title,
      effective_at: createdUtc ? new Date(createdUtc * 1000).toISOString() : null,
      payload: {
        ...post,
        subreddit: asString(post.subreddit) ?? subreddit,
      },
    };
  });

  return {
    items,
    next_cursor: nextCursor,
    metadata: {
      adapter: source.adapter,
      subreddit,
      result_count: items.length,
    },
  };
}

async function fetchNewsRssItems(source: SourceWithConfig): Promise<SourcePollResult> {
  if (!source.source_url) {
    throw new Error(`world_input_source_url_missing:${source.key}`);
  }

  const response = await fetch(source.source_url, {
    headers: { accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8" },
  });
  if (!response.ok) {
    throw new Error(`world_input_source_rss_fetch_failed:${source.key}:${response.status}`);
  }

  const xml = await response.text();
  const entries = parseRssEntries(xml);
  const cursor = cursorAsNumber(source.cursor_value);
  const filtered = entries.filter((entry) => {
    const timestamp = asString(entry.effective_at);
    if (!timestamp || cursor === null) {
      return true;
    }
    const millis = new Date(timestamp).getTime();
    if (!Number.isFinite(millis)) {
      return true;
    }
    return millis > cursor;
  });
  const newestMillis = filtered.reduce<number | null>((latest, entry) => {
    const timestamp = asString(entry.effective_at);
    if (!timestamp) {
      return latest;
    }
    const millis = new Date(timestamp).getTime();
    if (!Number.isFinite(millis)) {
      return latest;
    }
    return latest === null || millis > latest ? millis : latest;
  }, cursor);
  const nextCursor = newestMillis === null ? source.cursor_value : String(newestMillis);

  return {
    items: filtered,
    next_cursor: nextCursor,
    metadata: {
      adapter: source.adapter,
      entry_count: filtered.length,
    },
  };
}

async function fetchSourceItems(source: SourceWithConfig): Promise<SourcePollResult> {
  switch (source.adapter) {
    case "market_internal":
      return {
        items: [],
        next_cursor: source.cursor_value,
        metadata: { adapter: source.adapter },
      };
    case "x_api_recent_search":
      return fetchXRecentSearchItems(source);
    case "reddit_api_subreddit_new":
      return fetchRedditSubredditItems(source);
    case "news_rss":
      return fetchNewsRssItems(source);
    case "opencli_command":
      return fetchOpenCliCommandItems(source);
    case "http_json_calendar":
    case "http_json_price":
    case "http_csv_price":
    case "http_json_filing":
    case "http_json_official_announcement":
      return source.adapter === "http_csv_price"
        ? fetchHttpCsvPriceItems(source)
        : fetchHttpJsonSourceItems(source);
    default:
      throw new Error(`world_input_source_adapter_unsupported:${source.adapter}`);
  }
}

function expandHttpJsonPriceItems(source: SourceWithConfig, items: Record<string, unknown>[]) {
  if (items.length === 0) {
    return items;
  }

  const config = source.config_json;
  const pricePath = asString(config.price_path) ?? "price";
  const item = ensureObjectPayload(items[0]);
  const itemPayload = ensureObjectPayload(item.payload);
  const rawPrice = readPath(item, pricePath) ?? readPath(itemPayload, pricePath);
  const currentPrice = asNumber(rawPrice);
  if (currentPrice === null || currentPrice <= 0) {
    throw new Error(`world_input_source_price_path_invalid:${source.key}:${pricePath}`);
  }

  const assetSymbol = (asString(config.asset_symbol) ?? asString(config.symbol) ?? "ASSET").toUpperCase();
  const quoteSymbol = (asString(config.quote_symbol) ?? "USD").toUpperCase();
  const category = asString(config.category) ?? "asset";
  const roundDecimals = Math.max(0, Math.min(8, Number(asNumber(config.price_round_decimals) ?? 2)));
  const roundedPrice = Number(currentPrice.toFixed(roundDecimals));
  const canonicalSourceUrl = asString(config.canonical_source_url) ?? source.source_url;
  if (!canonicalSourceUrl) {
    throw new Error(`world_input_source_canonical_url_missing:${source.key}`);
  }

  const observedAtPath = asString(config.observed_at_path);
  const observedAt =
    (observedAtPath ? normalizeTimestamp(readPath(item, observedAtPath) ?? readPath(itemPayload, observedAtPath)) : null) ??
    normalizeTimestamp(item.observed_at) ??
    normalizeTimestamp(item.timestamp) ??
    normalizeTimestamp(itemPayload.observed_at) ??
    normalizeTimestamp(itemPayload.timestamp) ??
    new Date().toISOString();
  const minuteBucket = Math.floor(new Date(observedAt).getTime() / 60_000);
  const scaledPrice = Math.round(roundedPrice * Math.pow(10, Math.min(6, roundDecimals)));
  const sourceId = `${assetSymbol.toLowerCase()}-${quoteSymbol.toLowerCase()}-${scaledPrice}-${minuteBucket}`;
  const title = `${assetSymbol}/${quoteSymbol} spot price observed`;
  const formattedPrice = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: roundDecimals,
  }).format(roundedPrice);

  return [
    {
      source_id: sourceId,
      source_url: source.source_url ?? canonicalSourceUrl,
      title,
      summary: `${assetSymbol}/${quoteSymbol} observed at ${formattedPrice} from ${source.key}.`,
      effective_at: observedAt,
      payload: {
        kind: "asset_price_observation",
        category,
        asset_symbol: assetSymbol,
        quote_symbol: quoteSymbol,
        price: roundedPrice,
        observed_at: observedAt,
        canonical_source_url: canonicalSourceUrl,
        observation_price_path: pricePath,
      },
    },
  ];
}

function expandSourceItems(source: SourceWithConfig, items: Record<string, unknown>[]) {
  if (source.adapter === "http_json_price" || source.adapter === "http_csv_price") {
    return expandHttpJsonPriceItems(source, items);
  }
  return items;
}

async function startRunRecord(sourceId: string) {
  const runId = randomUUID();
  await pool.query(
    `
      INSERT INTO world_input_runs (
        id,
        source_id,
        started_at,
        status,
        fetched_count,
        accepted_count,
        error,
        metadata,
        created_at
      )
      VALUES ($1, $2, NOW(), 'running', 0, 0, NULL, '{}'::jsonb, NOW())
    `,
    [runId, sourceId],
  );
  return runId;
}

async function finishRunRecord(
  runId: string,
  status: "succeeded" | "failed",
  fetchedCount: number,
  acceptedCount: number,
  error: string | null,
  metadata: Record<string, unknown>,
) {
  await pool.query(
    `
      UPDATE world_input_runs
      SET
        ended_at = NOW(),
        status = $2,
        fetched_count = $3,
        accepted_count = $4,
        error = $5,
        metadata = $6::jsonb
      WHERE id = $1
    `,
    [runId, status, fetchedCount, acceptedCount, error, JSON.stringify(metadata)],
  );
}

async function updateSourceOnSuccess(source: SourceWithConfig, nextCursor: string | null) {
  await pool.query(
    `
      UPDATE world_input_sources
      SET
        cursor_value = $2,
        last_polled_at = NOW(),
        next_poll_at = NOW() + ($3 * INTERVAL '1 second'),
        backoff_until = NULL,
        failure_count = 0,
        last_error = NULL,
        updated_at = NOW()
      WHERE id = $1
    `,
    [source.id, nextCursor, source.poll_interval_seconds],
  );
}

async function updateSourceOnFailure(source: SourceWithConfig, errorMessage: string) {
  const nextFailureCount = source.failure_count + 1;
  const backoffMs = Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.max(0, nextFailureCount - 1));
  await pool.query(
    `
      UPDATE world_input_sources
      SET
        last_polled_at = NOW(),
        next_poll_at = NOW() + ($2 * INTERVAL '1 millisecond'),
        backoff_until = NOW() + ($2 * INTERVAL '1 millisecond'),
        failure_count = $3,
        last_error = $4,
        updated_at = NOW()
      WHERE id = $1
    `,
    [source.id, backoffMs, nextFailureCount, errorMessage.slice(0, 2000)],
  );
}

async function claimDueSources(limit: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<WorldInputSourceRow>(
      `
        WITH due AS (
          SELECT id
          FROM world_input_sources
          WHERE
            enabled = TRUE
            AND status = 'active'
            AND next_poll_at <= NOW()
            AND (backoff_until IS NULL OR backoff_until <= NOW())
          ORDER BY next_poll_at ASC, id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE world_input_sources sources
        SET
          next_poll_at = NOW() + ($2 * INTERVAL '1 millisecond'),
          updated_at = NOW()
        FROM due
        WHERE sources.id = due.id
        RETURNING sources.*
      `,
      [limit, claimLeaseMs],
    );
    await client.query("COMMIT");
    return result.rows.map(mapSourceRow);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function pollSource(source: SourceWithConfig) {
  const runId = await startRunRecord(source.id);
  let fetchedCount = 0;
  let acceptedCount = 0;
  let metadata: Record<string, unknown> = {};
  try {
    const result = await fetchSourceItems(source);
    const expandedItems = expandSourceItems(source, result.items);
    fetchedCount = expandedItems.length;
    metadata = result.metadata;
    for (const rawItem of expandedItems) {
      const signal = normalizeSignalFromItem(source, rawItem);
      const inserted = await upsertSignal(signal);
      if (inserted) {
        acceptedCount += 1;
      }
    }
    await updateSourceOnSuccess(source, result.next_cursor);
    await finishRunRecord(runId, "succeeded", fetchedCount, acceptedCount, null, metadata);
  } catch (error) {
    const message = String(error);
    await updateSourceOnFailure(source, message);
    await finishRunRecord(runId, "failed", fetchedCount, acceptedCount, message, metadata);
    throw error;
  }
}

async function maybeBootstrapSourcesFromEnv() {
  const candidates = parseBootstrapSourceConfigs();
  let inserted = 0;
  let updated = 0;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const entry = { ...(candidate as Record<string, unknown>) };
    const validation = validateWorldInputSourceConfig(entry);
    if (!validation.ok) {
      app.log.warn({ key: entry.key }, `invalid_bootstrap_world_input_source:${validation.errors.join(",")}`);
      continue;
    }

    const source = validation.config;
    const configJson = configWithoutKnownKeys(entry);
    const authSecretRef = asString(entry.auth_secret_ref);
    const upsertResult = await pool.query<{ inserted: boolean }>(
      `
        INSERT INTO world_input_sources (
          id,
          key,
          adapter,
          kind,
          status,
          enabled,
          poll_interval_seconds,
          source_url,
          trust_tier,
          config_json,
          auth_secret_ref,
          cursor_value,
          last_polled_at,
          next_poll_at,
          backoff_until,
          failure_count,
          last_error,
          created_at,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, 'active', TRUE, $5, $6, $7, $8::jsonb, $9, NULL, NULL, NOW(), NULL, 0, NULL, NOW(), NOW()
        )
        ON CONFLICT (key) DO UPDATE SET
          adapter = EXCLUDED.adapter,
          kind = EXCLUDED.kind,
          status = EXCLUDED.status,
          enabled = EXCLUDED.enabled,
          poll_interval_seconds = EXCLUDED.poll_interval_seconds,
          source_url = EXCLUDED.source_url,
          trust_tier = EXCLUDED.trust_tier,
          config_json = EXCLUDED.config_json,
          auth_secret_ref = EXCLUDED.auth_secret_ref,
          next_poll_at = NOW(),
          backoff_until = NULL,
          failure_count = 0,
          last_error = NULL,
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `,
      [
        randomUUID(),
        source.key,
        source.adapter,
        sourceKindFromAdapter(source.adapter),
        source.poll_interval_seconds,
        source.url ?? null,
        source.trust_tier,
        JSON.stringify(configJson),
        authSecretRef,
      ],
    );

    if ((upsertResult.rowCount ?? 0) > 0) {
      if (upsertResult.rows[0]?.inserted) {
        inserted += 1;
      } else {
        updated += 1;
      }
    }
  }

  if (inserted > 0 || updated > 0) {
    app.log.info({ inserted, updated }, "reconciled_world_input_sources_from_bootstrap");
  }
  return inserted + updated;
}

async function fetchSourceById(sourceId: string) {
  const result = await pool.query<WorldInputSourceRow>(
    `
      SELECT *
      FROM world_input_sources
      WHERE id = $1
      LIMIT 1
    `,
    [sourceId],
  );
  return result.rowCount ? mapSourceRow(result.rows[0]) : null;
}

async function tick() {
  if (tickInFlight) {
    return;
  }

  tickInFlight = true;
  let processed = 0;
  const errors: string[] = [];
  try {
    while (processed < maxSourcesPerTick) {
      const claimLimit = Math.min(claimBatchSize, maxSourcesPerTick - processed);
      const claimed = await claimDueSources(claimLimit);
      if (claimed.length === 0) {
        break;
      }
      await runWithConcurrency(claimed, Math.min(sourceConcurrency, claimLimit), async (source) => {
        try {
          await pollSource(source);
        } catch (error) {
          errors.push(`${source.key}:${String(error)}`);
          app.log.error({ source_key: source.key, error: String(error) }, "world_input_source_poll_failed");
        }
      });
      processed += claimed.length;
    }
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

app.get("/health", async () => {
  const stats = await pool.query<{ total: string; active: string; due: string }>(
    `
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE enabled = TRUE AND status = 'active')::text AS active,
        COUNT(*) FILTER (WHERE enabled = TRUE AND status = 'active' AND next_poll_at <= NOW())::text AS due
      FROM world_input_sources
    `,
  );
  const row = stats.rows[0] ?? { total: "0", active: "0", due: "0" };
  return {
    service: "world-input",
    status: "ok",
    source_count: Number(row.total),
    active_source_count: Number(row.active),
    due_source_count: Number(row.due),
    last_tick_at: lastTickAt,
    last_tick_error: lastTickError,
  };
});

app.post("/v1/internal/world-input/run-once", async () => {
  await tick();
  return { status: "ok", last_tick_at: lastTickAt, last_tick_error: lastTickError };
});

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

app.get("/v1/internal/world-input/sources", async (request) => {
  const limit = Math.max(1, Math.min(200, Number((request.query as { limit?: string }).limit ?? "100") || 100));
  const result = await pool.query<WorldInputSourceRow>(
    `
      SELECT *
      FROM world_input_sources
      ORDER BY created_at DESC, id DESC
      LIMIT $1
    `,
    [limit],
  );
  return {
    items: result.rows.map(mapSourceRow),
  };
});

app.post("/v1/internal/world-input/sources", async (request, reply) => {
  const body = ensureObjectPayload(request.body);
  const sourceConfigValidation = validateWorldInputSourceConfig(body);
  if (!sourceConfigValidation.ok) {
    return reply.code(400).send({ error: "invalid_source_config", details: sourceConfigValidation.errors });
  }

  const config = sourceConfigValidation.config;
  const source = {
    id: randomUUID(),
    key: config.key,
    adapter: config.adapter,
    kind: asString(body.kind) ?? sourceKindFromAdapter(config.adapter),
    status: asString(body.status) ?? "active",
    enabled: typeof body.enabled === "boolean" ? body.enabled : true,
    poll_interval_seconds: config.poll_interval_seconds,
    source_url: config.url ?? null,
    trust_tier: config.trust_tier,
    config_json: configWithoutKnownKeys(body),
    auth_secret_ref: asString(body.auth_secret_ref),
  };

  const insert = await pool.query<WorldInputSourceRow>(
    `
      INSERT INTO world_input_sources (
        id,
        key,
        adapter,
        kind,
        status,
        enabled,
        poll_interval_seconds,
        source_url,
        trust_tier,
        config_json,
        auth_secret_ref,
        cursor_value,
        last_polled_at,
        next_poll_at,
        backoff_until,
        failure_count,
        last_error,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, NULL, NULL, NOW(), NULL, 0, NULL, NOW(), NOW()
      )
      RETURNING *
    `,
    [
      source.id,
      source.key,
      source.adapter,
      source.kind,
      source.status,
      source.enabled,
      source.poll_interval_seconds,
      source.source_url,
      source.trust_tier,
      JSON.stringify(source.config_json),
      source.auth_secret_ref,
    ],
  );

  return reply.code(201).send({ item: mapSourceRow(insert.rows[0]) });
});

app.patch("/v1/internal/world-input/sources/:id", async (request, reply) => {
  const sourceId = (request.params as { id: string }).id;
  const existing = await fetchSourceById(sourceId);
  if (!existing) {
    return reply.code(404).send({ error: "world_input_source_not_found" });
  }

  const body = ensureObjectPayload(request.body);
  const mergedConfigPayload = {
    ...existing.config_json,
    ...(body.config_json && typeof body.config_json === "object" && !Array.isArray(body.config_json)
      ? (body.config_json as Record<string, unknown>)
      : {}),
  };

  const candidateForValidation: Record<string, unknown> = {
    key: asString(body.key) ?? existing.key,
    adapter: asString(body.adapter) ?? existing.adapter,
    url: asString(body.url) ?? existing.source_url,
    poll_interval_seconds: asNumber(body.poll_interval_seconds) ?? existing.poll_interval_seconds,
    trust_tier: asString(body.trust_tier) ?? existing.trust_tier,
    ...mergedConfigPayload,
  };
  const validation = validateWorldInputSourceConfig(candidateForValidation);
  if (!validation.ok) {
    return reply.code(400).send({ error: "invalid_source_config", details: validation.errors });
  }
  const validConfig = validation.config;

  const nextConfigJson = {
    ...configWithoutKnownKeys(existing.config_json),
    ...configWithoutKnownKeys(candidateForValidation),
  };

  const update = await pool.query<WorldInputSourceRow>(
    `
      UPDATE world_input_sources
      SET
        key = $2,
        adapter = $3,
        kind = $4,
        status = $5,
        enabled = $6,
        poll_interval_seconds = $7,
        source_url = $8,
        trust_tier = $9,
        config_json = $10::jsonb,
        auth_secret_ref = $11,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [
      sourceId,
      validConfig.key,
      validConfig.adapter,
      asString(body.kind) ?? existing.kind,
      asString(body.status) ?? existing.status,
      typeof body.enabled === "boolean" ? body.enabled : existing.enabled,
      validConfig.poll_interval_seconds,
      validConfig.url ?? null,
      validConfig.trust_tier,
      JSON.stringify(nextConfigJson),
      asString(body.auth_secret_ref) ?? existing.auth_secret_ref,
    ],
  );

  return { item: mapSourceRow(update.rows[0]) };
});

app.post("/v1/internal/world-input/sources/:id/test", async (request, reply) => {
  const sourceId = (request.params as { id: string }).id;
  const source = await fetchSourceById(sourceId);
  if (!source) {
    return reply.code(404).send({ error: "world_input_source_not_found" });
  }

  const maxSample = Math.max(1, Math.min(10, Number((request.query as { sample?: string }).sample ?? "3")));
  try {
    const result = await fetchSourceItems(source);
    const expandedItems = expandSourceItems(source, result.items);
    const sampleSignals = expandedItems.slice(0, maxSample).map((item) => normalizeSignalFromItem(source, item));
    const response: SourceTestResponse = {
      source,
      fetched_count: expandedItems.length,
      next_cursor: result.next_cursor,
      sample_signals: sampleSignals,
    };
    return response;
  } catch (error) {
    return reply.code(400).send({
      error: "world_input_source_test_failed",
      message: String(error),
    });
  }
});

async function start() {
  await ensureCoreSchema(pool);
  await maybeBootstrapSourcesFromEnv();
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
