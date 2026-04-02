import { createHash } from "node:crypto";
import type { ResolutionKind, ResolutionSpec } from "@automakit/sdk-types";

export type SourceAdapterKind =
  | "http_json_calendar"
  | "http_json_price"
  | "http_csv_price"
  | "http_json_filing"
  | "http_json_official_announcement"
  | "x_api_recent_search"
  | "reddit_api_subreddit_new"
  | "news_rss"
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

export type EventCaseStatus = "open" | "stale" | "closed";

export type EventCase = {
  id: string;
  fingerprint: string;
  kind: string;
  title: string;
  summary: string;
  primary_entity: string;
  source_types: WorldSignalSourceType[];
  source_adapters: SourceAdapterKind[];
  signal_count: number;
  first_signal_at: string;
  last_signal_at: string;
  status: EventCaseStatus;
  created_at: string;
  updated_at: string;
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

export type WorldInputSourceConfig = {
  key: string;
  adapter: SourceAdapterKind;
  url?: string;
  poll_interval_seconds: number;
  backfill_hours?: number;
  trust_tier: TrustTier;
};

export type SimulationRunType = "belief_refresh";
export type SimulationRunStatus =
  | "world_model_pending"
  | "scenario_pending"
  | "synthesis_pending"
  | "ready_for_proposal"
  | "completed"
  | "failed";

export type WorldEntityState = {
  id: string;
  kind: WorldEntityRef["kind"];
  name: string;
  attributes: Record<string, unknown>;
};

export type ActiveWorldEvent = {
  id: string;
  title: string;
  event_type: string;
  effective_at?: string | null;
  source_signal_ids: string[];
};

export type WorldFactorState = {
  factor: string;
  value: number;
  direction: "up" | "down" | "flat";
  rationale: string;
};

export type WorldStateProposal = {
  id: string;
  run_id: string;
  agent_id: string;
  source_signal_ids: string[];
  as_of: string;
  entities: WorldEntityState[];
  active_events: ActiveWorldEvent[];
  factors: WorldFactorState[];
  regime_labels: string[];
  reasoning_summary: string;
  created_at: string;
};

export type ScenarioEvent = {
  id: string;
  title: string;
  event_type: string;
  description: string;
  effective_at?: string | null;
};

export type ScenarioPathHypothesis = {
  key: string;
  hypothesis_kind: ResolutionKind;
  category: string;
  subject: string;
  predicate: string;
  target_time: string;
  confidence_score: number;
  reasoning_summary: string;
  source_signal_ids: string[];
  machine_resolvable: boolean;
  suggested_resolution_spec?: ResolutionSpec;
};

export type ScenarioPathProposal = {
  id: string;
  run_id: string;
  agent_id: string;
  label: "base" | "bull" | "bear" | "stress" | string;
  probability: number;
  narrative: string;
  factor_deltas: Record<string, unknown>;
  path_events: ScenarioEvent[];
  path_hypotheses: ScenarioPathHypothesis[];
  created_at: string;
};

export type BeliefHypothesisProposal = {
  id: string;
  run_id: string;
  agent_id: string;
  parent_ids: string[];
  hypothesis_kind: ResolutionKind;
  category: string;
  subject: string;
  predicate: string;
  target_time: string;
  confidence_score: number;
  reasoning_summary: string;
  source_signal_ids: string[];
  machine_resolvable: boolean;
  suggested_resolution_spec?: ResolutionSpec;
  dedupe_key: string;
  created_at: string;
};

export type SynthesizedBeliefStatus = "new" | "ambiguous" | "proposed" | "suppressed";

export type SynthesizedBelief = {
  id: string;
  run_id: string;
  agent_id: string;
  parent_hypothesis_ids: string[];
  agreement_score: number;
  disagreement_score: number;
  confidence_score: number;
  conflict_notes?: string | null;
  hypothesis: BeliefHypothesisProposal;
  status: SynthesizedBeliefStatus;
  suppression_reason?: string | null;
  linked_proposal_id?: string | null;
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
  source_belief_id: string;
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
    case "http_csv_price":
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
    ![
      "http_json_calendar",
      "http_json_price",
      "http_csv_price",
      "http_json_filing",
      "http_json_official_announcement",
      "x_api_recent_search",
      "reddit_api_subreddit_new",
      "news_rss",
      "market_internal",
    ].includes(
      candidate.adapter,
    )
  ) {
    errors.push("world_input_source_adapter_unsupported");
  }
  if (
    candidate.adapter !== "market_internal" &&
    candidate.adapter !== "x_api_recent_search" &&
    candidate.adapter !== "reddit_api_subreddit_new" &&
    !candidate.url
  ) {
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

export function validateEventCase(eventCase: unknown) {
  const errors: string[] = [];
  if (!eventCase || typeof eventCase !== "object") {
    return { ok: false as const, errors: ["event_case_must_be_object"] };
  }

  const candidate = eventCase as Partial<EventCase>;
  if (!candidate.id) {
    errors.push("event_case_id_required");
  }
  if (!candidate.fingerprint) {
    errors.push("event_case_fingerprint_required");
  }
  if (!candidate.kind) {
    errors.push("event_case_kind_required");
  }
  if (!candidate.title) {
    errors.push("event_case_title_required");
  }
  if (!candidate.primary_entity) {
    errors.push("event_case_primary_entity_required");
  }
  if (!Array.isArray(candidate.source_types) || candidate.source_types.length === 0) {
    errors.push("event_case_source_types_required");
  }
  if (!Array.isArray(candidate.source_adapters) || candidate.source_adapters.length === 0) {
    errors.push("event_case_source_adapters_required");
  }
  if (typeof candidate.signal_count !== "number" || !Number.isFinite(candidate.signal_count) || candidate.signal_count < 1) {
    errors.push("event_case_signal_count_invalid");
  }
  if (!candidate.first_signal_at) {
    errors.push("event_case_first_signal_at_required");
  }
  if (!candidate.last_signal_at) {
    errors.push("event_case_last_signal_at_required");
  }
  if (!candidate.status || !["open", "stale", "closed"].includes(candidate.status)) {
    errors.push("event_case_status_invalid");
  }

  return errors.length > 0
    ? { ok: false as const, errors }
    : { ok: true as const, eventCase: candidate as EventCase };
}

function isResolutionKind(value: unknown): value is ResolutionKind {
  return (
    value === "price_threshold" ||
    value === "rate_decision" ||
    value === "event_occurrence"
  );
}

export function validateWorldStateProposal(proposal: unknown) {
  const errors: string[] = [];
  if (!proposal || typeof proposal !== "object") {
    return { ok: false as const, errors: ["world_state_proposal_must_be_object"] };
  }

  const candidate = proposal as Partial<WorldStateProposal>;
  if (!candidate.id) {
    errors.push("world_state_proposal_id_required");
  }
  if (!candidate.run_id) {
    errors.push("world_state_proposal_run_id_required");
  }
  if (!candidate.agent_id) {
    errors.push("world_state_proposal_agent_id_required");
  }
  if (!candidate.source_signal_ids?.length) {
    errors.push("world_state_proposal_source_signal_ids_required");
  }
  if (!candidate.as_of) {
    errors.push("world_state_proposal_as_of_required");
  }
  if (!Array.isArray(candidate.entities)) {
    errors.push("world_state_proposal_entities_required");
  }

  return errors.length > 0
    ? { ok: false as const, errors }
    : { ok: true as const, proposal: candidate as WorldStateProposal };
}

export function validateScenarioPathProposal(proposal: unknown) {
  const errors: string[] = [];
  if (!proposal || typeof proposal !== "object") {
    return { ok: false as const, errors: ["scenario_path_proposal_must_be_object"] };
  }

  const candidate = proposal as Partial<ScenarioPathProposal>;
  if (!candidate.id) {
    errors.push("scenario_path_proposal_id_required");
  }
  if (!candidate.run_id) {
    errors.push("scenario_path_proposal_run_id_required");
  }
  if (!candidate.agent_id) {
    errors.push("scenario_path_proposal_agent_id_required");
  }
  if (!candidate.label) {
    errors.push("scenario_path_proposal_label_required");
  }
  if (typeof candidate.probability !== "number" || !Number.isFinite(candidate.probability)) {
    errors.push("scenario_path_proposal_probability_required");
  }
  if (!Array.isArray(candidate.path_hypotheses)) {
    errors.push("scenario_path_proposal_path_hypotheses_required");
  }

  return errors.length > 0
    ? { ok: false as const, errors }
    : { ok: true as const, proposal: candidate as ScenarioPathProposal };
}

export function validateBeliefHypothesisProposal(proposal: unknown) {
  const errors: string[] = [];
  if (!proposal || typeof proposal !== "object") {
    return { ok: false as const, errors: ["belief_hypothesis_proposal_must_be_object"] };
  }

  const candidate = proposal as Partial<BeliefHypothesisProposal>;
  if (!candidate.id) {
    errors.push("belief_hypothesis_proposal_id_required");
  }
  if (!candidate.run_id) {
    errors.push("belief_hypothesis_proposal_run_id_required");
  }
  if (!candidate.agent_id) {
    errors.push("belief_hypothesis_proposal_agent_id_required");
  }
  if (!isResolutionKind(candidate.hypothesis_kind)) {
    errors.push("belief_hypothesis_proposal_kind_invalid");
  }
  if (!candidate.subject) {
    errors.push("belief_hypothesis_proposal_subject_required");
  }
  if (!candidate.target_time) {
    errors.push("belief_hypothesis_proposal_target_time_required");
  }
  if (typeof candidate.confidence_score !== "number" || !Number.isFinite(candidate.confidence_score)) {
    errors.push("belief_hypothesis_proposal_confidence_required");
  }
  if (!candidate.dedupe_key) {
    errors.push("belief_hypothesis_proposal_dedupe_key_required");
  }

  return errors.length > 0
    ? { ok: false as const, errors }
    : { ok: true as const, proposal: candidate as BeliefHypothesisProposal };
}

export function validateSynthesizedBelief(belief: unknown) {
  const errors: string[] = [];
  if (!belief || typeof belief !== "object") {
    return { ok: false as const, errors: ["synthesized_belief_must_be_object"] };
  }

  const candidate = belief as Partial<SynthesizedBelief>;
  if (!candidate.id) {
    errors.push("synthesized_belief_id_required");
  }
  if (!candidate.run_id) {
    errors.push("synthesized_belief_run_id_required");
  }
  if (!candidate.agent_id) {
    errors.push("synthesized_belief_agent_id_required");
  }
  if (!candidate.hypothesis) {
    errors.push("synthesized_belief_hypothesis_required");
  } else {
    const nestedValidation = validateBeliefHypothesisProposal(candidate.hypothesis);
    if (!nestedValidation.ok) {
      errors.push(...nestedValidation.errors.map((entry) => `synthesized_${entry}`));
    }
  }

  return errors.length > 0
    ? { ok: false as const, errors }
    : { ok: true as const, belief: candidate as SynthesizedBelief };
}
