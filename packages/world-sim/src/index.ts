import { createHash } from "node:crypto";
import type { ResolutionKind, ResolutionSpec } from "@automakit/sdk-types";

export type SourceAdapterKind =
  | "http_json_calendar"
  | "http_json_price"
  | "http_json_filing"
  | "http_json_official_announcement"
  | "market_internal";

export type WorldSignalSourceType =
  | "economic_calendar"
  | "price_feed"
  | "filing"
  | "official_announcement"
  | "news"
  | "market_internal";

export type TrustTier = "official" | "exchange" | "curated" | "derived";

export type WorldEntityRef = {
  kind: "asset" | "institution" | "person" | "issuer" | "event";
  value: string;
};

export type WorldSignal = {
  id: string;
  source_type: WorldSignalSourceType;
  source_adapter: SourceAdapterKind;
  source_id: string;
  source_url: string;
  trust_tier: TrustTier;
  fetched_at: string;
  effective_at?: string | null;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  entity_refs: WorldEntityRef[];
  dedupe_key: string;
  created_at: string;
};

export type WorldInputCursor = {
  source_key: string;
  cursor_value: string | null;
  last_polled_at: string | null;
  next_poll_at: string;
  backoff_until: string | null;
  failure_count: number;
  last_error: string | null;
  updated_at: string;
};

export type PriceThresholdHypothesisMetadata = {
  kind: "price_threshold";
  asset_symbol: string;
  threshold: number;
  operator: "gt" | "gte" | "lt" | "lte";
  canonical_source_url: string;
  category: string;
};

export type RateDecisionHypothesisMetadata = {
  kind: "rate_decision";
  institution: string;
  direction: "cut" | "hold" | "hike";
  canonical_source_url: string;
  category: string;
};

export type SuggestedResolutionMetadata =
  | PriceThresholdHypothesisMetadata
  | RateDecisionHypothesisMetadata;

export type WorldHypothesisStatus = "new" | "proposed" | "suppressed";

export type WorldHypothesis = {
  id: string;
  source_signal_ids: string[];
  category: string;
  subject: string;
  predicate: string;
  target_time: string;
  confidence_score: number;
  reasoning_summary: string;
  machine_resolvable: boolean;
  suggested_resolution_kind?: ResolutionKind;
  suggested_resolution_source_url?: string;
  suggested_resolution_metadata?: SuggestedResolutionMetadata;
  status: WorldHypothesisStatus;
  suppression_reason?: string | null;
  linked_proposal_id?: string | null;
  dedupe_key: string;
  created_at: string;
  updated_at: string;
};

export type ProposalCandidate = {
  title: string;
  category: string;
  close_time: string;
  resolution_criteria: string;
  resolution_spec: ResolutionSpec;
  dedupe_key: string;
  source_hypothesis_id: string;
};

export type WorldInputSourceConfig = {
  key: string;
  adapter: SourceAdapterKind;
  url?: string;
  poll_interval_seconds: number;
  backfill_hours?: number;
  trust_tier: TrustTier;
};

export function buildDedupeKey(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(",")}}`;
}

export function sourceAdapterToSignalType(adapter: SourceAdapterKind): WorldSignalSourceType {
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
    default:
      return "news";
  }
}

export function inferEntityRefs(payload: Record<string, unknown>) {
  const refs: WorldEntityRef[] = [];

  if (typeof payload.asset_symbol === "string") {
    refs.push({ kind: "asset", value: payload.asset_symbol });
  }
  if (typeof payload.institution === "string") {
    refs.push({ kind: "institution", value: payload.institution });
  }
  if (typeof payload.issuer === "string") {
    refs.push({ kind: "issuer", value: payload.issuer });
  }
  if (typeof payload.person === "string") {
    refs.push({ kind: "person", value: payload.person });
  }
  if (typeof payload.event_name === "string") {
    refs.push({ kind: "event", value: payload.event_name });
  }

  return refs;
}

export function normalizeAllowedDomainsFromUrl(url: string) {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname.startsWith("www.") ? [hostname.slice(4), hostname] : [hostname];
}

export function validateWorldInputSourceConfig(config: unknown) {
  const errors: string[] = [];
  if (!config || typeof config !== "object") {
    return { ok: false as const, errors: ["world_input_source_must_be_object"] };
  }

  const candidate = config as Partial<WorldInputSourceConfig>;
  if (!candidate.key) {
    errors.push("world_input_source_key_required");
  }
  if (!candidate.adapter) {
    errors.push("world_input_source_adapter_required");
  }
  if (
    candidate.adapter &&
    !["http_json_calendar", "http_json_price", "http_json_filing", "http_json_official_announcement", "market_internal"].includes(
      candidate.adapter,
    )
  ) {
    errors.push("world_input_source_adapter_unsupported");
  }
  if (candidate.adapter !== "market_internal" && !candidate.url) {
    errors.push("world_input_source_url_required");
  }
  if (
    typeof candidate.poll_interval_seconds !== "number" ||
    !Number.isFinite(candidate.poll_interval_seconds) ||
    candidate.poll_interval_seconds <= 0
  ) {
    errors.push("world_input_source_poll_interval_invalid");
  }
  if (!candidate.trust_tier) {
    errors.push("world_input_source_trust_tier_required");
  }

  return errors.length > 0
    ? { ok: false as const, errors }
    : { ok: true as const, config: candidate as WorldInputSourceConfig };
}

export function validateWorldSignal(signal: unknown) {
  const errors: string[] = [];
  if (!signal || typeof signal !== "object") {
    return { ok: false as const, errors: ["world_signal_must_be_object"] };
  }

  const candidate = signal as Partial<WorldSignal>;
  if (!candidate.id) {
    errors.push("world_signal_id_required");
  }
  if (!candidate.source_type) {
    errors.push("world_signal_source_type_required");
  }
  if (!candidate.source_url) {
    errors.push("world_signal_source_url_required");
  }
  if (!candidate.title) {
    errors.push("world_signal_title_required");
  }
  if (!candidate.payload || typeof candidate.payload !== "object") {
    errors.push("world_signal_payload_required");
  }
  if (!candidate.dedupe_key) {
    errors.push("world_signal_dedupe_key_required");
  }

  return errors.length > 0
    ? { ok: false as const, errors }
    : { ok: true as const, signal: candidate as WorldSignal };
}

export function validateWorldHypothesis(hypothesis: unknown) {
  const errors: string[] = [];
  if (!hypothesis || typeof hypothesis !== "object") {
    return { ok: false as const, errors: ["world_hypothesis_must_be_object"] };
  }

  const candidate = hypothesis as Partial<WorldHypothesis>;
  if (!candidate.id) {
    errors.push("world_hypothesis_id_required");
  }
  if (!candidate.source_signal_ids?.length) {
    errors.push("world_hypothesis_source_signal_ids_required");
  }
  if (!candidate.subject) {
    errors.push("world_hypothesis_subject_required");
  }
  if (!candidate.predicate) {
    errors.push("world_hypothesis_predicate_required");
  }
  if (!candidate.target_time) {
    errors.push("world_hypothesis_target_time_required");
  }
  if (typeof candidate.machine_resolvable !== "boolean") {
    errors.push("world_hypothesis_machine_resolvable_required");
  }
  if (!candidate.dedupe_key) {
    errors.push("world_hypothesis_dedupe_key_required");
  }

  return errors.length > 0
    ? { ok: false as const, errors }
    : { ok: true as const, hypothesis: candidate as WorldHypothesis };
}
