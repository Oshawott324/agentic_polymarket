import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { createDatabasePool, ensureCoreSchema, parseJsonField, toIsoTimestamp } from "@automakit/persistence";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import {
  buildDedupeKey,
  inferEntityRefs,
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
const app = Fastify({ logger: true });
const pool = createDatabasePool();

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

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function formatUtcDay(value: string) {
  return value.slice(0, 10);
}

function operatorPhrase(operator: "gt" | "gte" | "lt" | "lte") {
  switch (operator) {
    case "gte":
      return "at or above";
    case "gt":
      return "above";
    case "lte":
      return "at or below";
    case "lt":
    default:
      return "below";
  }
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
    case "x_api_recent_search":
    case "reddit_api_subreddit_new":
      return "social";
    case "news_rss":
      return "news";
    case "http_json_calendar":
      return "calendar";
    case "http_json_price":
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

function worldSignalTypeFromAdapter(adapter: WorldInputAdapterKind): WorldSignal["source_type"] {
  switch (adapter) {
    case "http_json_calendar":
      return "economic_calendar";
    case "http_json_price":
      return "price_feed";
    case "http_json_filing":
      return "filing";
    case "http_json_official_announcement":
      return "official_announcement";
    case "market_internal":
      return "market_internal";
    case "x_api_recent_search":
    case "reddit_api_subreddit_new":
    case "news_rss":
      return "news";
    default:
      return "news";
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
    asString(input.source_id) ??
    asString(input.id) ??
    buildDedupeKey({
      source_key: source.key,
      title: input.title ?? input.headline ?? input.name ?? "signal",
      effective_at: effectiveAt,
      payload: mergedPayload,
    });
  const sourceUrl = asString(input.source_url) ?? asString(input.url) ?? source.source_url ?? "internal://world-input";
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
    asString(input.title) ??
    asString(input.headline) ??
    asString(input.name) ??
    `${source.key}:${sourceId.slice(0, 20)}`;
  const summary = sanitizeSummary(
    asString(input.summary) ?? asString(input.description) ?? asString(input.text),
    title,
  );
  const signal: WorldSignal = {
    id: randomUUID(),
    source_type: worldSignalTypeFromAdapter(source.adapter),
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
  let items: Record<string, unknown>[];
  if (Array.isArray(payload)) {
    items = payload
      .map((entry) => ensureObjectPayload(entry))
      .filter((entry) => Object.keys(entry).length > 0);
  } else if (payload && typeof payload === "object" && Array.isArray((payload as { items?: unknown[] }).items)) {
    items = (payload as { items: unknown[] }).items
      .map((entry) => ensureObjectPayload(entry))
      .filter((entry) => Object.keys(entry).length > 0);
  } else {
    const entry = ensureObjectPayload(payload);
    items = Object.keys(entry).length > 0 ? [entry] : [];
  }

  return {
    items,
    next_cursor: source.cursor_value,
    metadata: { adapter: source.adapter },
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
    case "http_json_calendar":
    case "http_json_price":
    case "http_json_filing":
    case "http_json_official_announcement":
      return fetchHttpJsonSourceItems(source);
    default:
      throw new Error(`world_input_source_adapter_unsupported:${source.adapter}`);
  }
}

function expandHttpJsonPriceItems(source: SourceWithConfig, items: Record<string, unknown>[]) {
  if (items.length === 0) {
    return items;
  }

  const config = source.config_json;
  const generationMode =
    asString(config.market_generation_mode) ??
    asString(config.market_mode) ??
    "price_threshold_auto";

  if (generationMode !== "price_threshold_auto") {
    return items;
  }

  const pricePath = asString(config.price_path) ?? "price";
  const rawPrice = readPath(items[0], pricePath);
  const currentPrice = asNumber(rawPrice);
  if (currentPrice === null || currentPrice <= 0) {
    throw new Error(`world_input_source_price_path_invalid:${source.key}:${pricePath}`);
  }

  const assetSymbol = (asString(config.asset_symbol) ?? asString(config.symbol) ?? "ASSET").toUpperCase();
  const quoteSymbol = (asString(config.quote_symbol) ?? "USD").toUpperCase();
  const category = asString(config.category) ?? "crypto";
  const operatorRaw = asString(config.operator);
  const operator: "gt" | "gte" | "lt" | "lte" =
    operatorRaw === "gt" || operatorRaw === "lte" || operatorRaw === "lt"
      ? operatorRaw
      : "gte";
  const thresholdPercent = clampNumber(asNumber(config.threshold_percent) ?? 3, 0.25, 25);
  const thresholdRoundTo = Math.max(0.01, asNumber(config.threshold_round_to) ?? 100);
  const horizonHours = clampNumber(asNumber(config.market_horizon_hours) ?? 24, 1, 24 * 14);
  const windowMinutes = clampNumber(asNumber(config.market_window_minutes) ?? 60, 5, 24 * 60);
  const canonicalSourceUrl = asString(config.canonical_source_url) ?? source.source_url;
  if (!canonicalSourceUrl) {
    throw new Error(`world_input_source_canonical_url_missing:${source.key}`);
  }

  const direction = operator === "lt" || operator === "lte" ? -1 : 1;
  const thresholdBase = currentPrice * (1 + direction * thresholdPercent / 100);
  const threshold = Math.max(
    thresholdRoundTo,
    Math.round(thresholdBase / thresholdRoundTo) * thresholdRoundTo,
  );

  const now = Date.now();
  const targetMs = now + horizonHours * 60 * 60 * 1000;
  const windowMs = windowMinutes * 60 * 1000;
  const targetBucketMs = Math.floor(targetMs / windowMs) * windowMs;
  const targetTime = new Date(targetBucketMs).toISOString();
  const dateLabel = formatUtcDay(targetTime);
  const thresholdLabel = Math.round(threshold).toLocaleString("en-US");
  const sourceId = `${assetSymbol.toLowerCase()}-${operator}-${Math.round(threshold)}-${targetBucketMs}`;
  const title = `Will ${assetSymbol} be ${operatorPhrase(operator)} $${thresholdLabel} by ${dateLabel} UTC?`;

  return [
    {
      source_id: sourceId,
      source_url: source.source_url ?? canonicalSourceUrl,
      title,
      summary: `${assetSymbol} ${quoteSymbol} signal from ${source.key}. Current ${Math.round(currentPrice).toLocaleString("en-US")}; threshold ${operatorPhrase(operator)} ${thresholdLabel} by ${dateLabel} UTC.`,
      effective_at: targetTime,
      payload: {
        kind: "price_threshold",
        category,
        asset_symbol: assetSymbol,
        quote_symbol: quoteSymbol,
        operator,
        threshold,
        target_time: targetTime,
        canonical_source_url: canonicalSourceUrl,
        observation_price_path: pricePath,
      },
    },
  ];
}

function expandSourceItems(source: SourceWithConfig, items: Record<string, unknown>[]) {
  if (source.adapter === "http_json_price") {
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
  const countResult = await pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM world_input_sources");
  const count = Number(countResult.rows[0]?.count ?? 0);
  if (count > 0) {
    return 0;
  }

  const candidates = parseBootstrapSourceConfigs();
  let inserted = 0;
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
    await pool.query(
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
        ON CONFLICT (key) DO NOTHING
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
    inserted += 1;
  }

  if (inserted > 0) {
    app.log.info({ inserted }, "bootstrapped_world_input_sources");
  }
  return inserted;
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
      for (const source of claimed) {
        try {
          await pollSource(source);
        } catch (error) {
          errors.push(`${source.key}:${String(error)}`);
          app.log.error({ source_key: source.key, error: String(error) }, "world_input_source_poll_failed");
        }
      }
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
