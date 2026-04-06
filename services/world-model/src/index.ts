import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { loadLlmClientFromEnv } from "@automakit/agent-llm";
import { createDatabasePool, ensureCoreSchema, parseJsonField, toIsoTimestamp } from "@automakit/persistence";
import type { PriceThresholdDecisionRule, ResolutionExtractionMode, ResolutionSpec } from "@automakit/sdk-types";
import {
  buildDedupeKey,
  normalizeAllowedDomainsFromUrl,
  normalizeWorldSignalRole,
  readSignalRole,
  type ActiveWorldEvent,
  type BeliefHypothesisProposal,
  type SimulationRunStatus,
  type WorldEntityRef,
  type WorldEntityState,
  type WorldSignalRole,
  type WorldFactorState,
  type WorldSignal,
  type WorldStateProposal,
  validateBeliefHypothesisProposal,
  validateWorldStateProposal,
} from "@automakit/world-sim";

type CaseAwareBeliefHypothesisProposal = BeliefHypothesisProposal & {
  event_case_id?: string | null;
  case_family_key?: string | null;
  belief_role?: "primary" | "secondary";
  publishability_score?: number;
};

type SimulationRunRow = {
  id: string;
  trigger_signal_ids: unknown;
  trigger_event_case_ids: unknown;
  status: SimulationRunStatus;
  started_at: unknown;
};

type EventCaseContextRow = {
  id: string;
  kind: string;
  title: string;
  summary: string;
  primary_entity: string;
  source_types: unknown;
  signal_count: number;
  last_signal_at: unknown;
};

type EventCaseSignalLinkRow = {
  event_case_id: string;
  signal_id: string;
  role: string;
};

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

type WorldStateProposalRow = {
  id: string;
  run_id: string;
  agent_id: string;
  source_signal_ids: unknown;
  as_of: unknown;
  entities: unknown;
  active_events: unknown;
  factors: unknown;
  regime_labels: unknown;
  reasoning_summary: string;
  created_at: unknown;
};

type BeliefHypothesisProposalRow = {
  id: string;
  run_id: string;
  agent_id: string;
  parent_ids: unknown;
  hypothesis_kind: BeliefHypothesisProposal["hypothesis_kind"];
  category: string;
  subject: string;
  predicate: string;
  target_time: unknown;
  confidence_score: unknown;
  reasoning_summary: string;
  source_signal_ids: unknown;
  machine_resolvable: boolean;
  suggested_resolution_spec: unknown;
  event_case_id: string | null;
  case_family_key: string | null;
  belief_role: "primary" | "secondary" | null;
  publishability_score: unknown;
  dedupe_key: string;
  created_at: unknown;
};

type EventCaseContext = {
  id: string;
  kind: string;
  title: string;
  summary: string;
  primary_entity: string;
  source_types: string[];
  signal_count: number;
  last_signal_at: string;
  source_signal_ids: string[];
  signal_role_counts: Partial<Record<WorldSignalRole, number>>;
};

type CaseAnnotatedHypothesis = CaseAwareBeliefHypothesisProposal & {
  source_signal: WorldSignal;
  event_case_id: string | null;
  case_family_key: string;
  belief_role: "primary" | "secondary";
  publishability_score: number;
};

type WorldModelLlmResponse = {
  world_state: {
    as_of?: string;
    entities?: WorldEntityState[];
    active_events?: ActiveWorldEvent[];
    factors?: WorldFactorState[];
    regime_labels?: string[];
    reasoning_summary?: string;
  };
  hypotheses: Array<{
    source_signal_id: string;
    hypothesis_kind: BeliefHypothesisProposal["hypothesis_kind"];
    category: string;
    subject: string;
    predicate: string;
    target_time: string;
    confidence_score: number;
    reasoning_summary: string;
    machine_resolvable?: boolean;
    price_threshold?: {
      operator: "gt" | "gte" | "lt" | "lte";
      threshold: number;
    };
  }>;
};

const port = Number(process.env.WORLD_MODEL_PORT ?? 4011);
const intervalMs = Number(process.env.WORLD_MODEL_INTERVAL_MS ?? 1000);
const batchSize = Number(process.env.WORLD_MODEL_BATCH_SIZE ?? 10);
const runConcurrency = Math.max(1, Number(process.env.WORLD_MODEL_RUN_CONCURRENCY ?? 4));
const maxHypothesesPerRun = Math.max(1, Number(process.env.WORLD_MODEL_MAX_HYPOTHESES_PER_RUN ?? 8));
const maxPriceFamiliesPerRun = Math.max(1, Number(process.env.WORLD_MODEL_MAX_PRICE_FAMILIES_PER_RUN ?? 2));
const agentId = process.env.WORLD_MODEL_AGENT_ID ?? "world-model-alpha";
const agentProfile = process.env.WORLD_MODEL_AGENT_PROFILE ?? "macro";
const mode = process.env.WORLD_MODEL_MODE ?? "llm";
const llmClient = (() => {
  if (mode !== "llm") {
    return null;
  }
  return loadLlmClientFromEnv();
})();
const app = Fastify({ logger: true });
const pool = createDatabasePool();

let tickInFlight = false;
let lastTickAt: string | null = null;
let lastTickError: string | null = null;

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

function mapWorldStateProposalRow(row: WorldStateProposalRow): WorldStateProposal {
  return {
    id: row.id,
    run_id: row.run_id,
    agent_id: row.agent_id,
    source_signal_ids: parseJsonField<string[]>(row.source_signal_ids),
    as_of: toIsoTimestamp(row.as_of),
    entities: parseJsonField<WorldEntityState[]>(row.entities),
    active_events: parseJsonField<ActiveWorldEvent[]>(row.active_events),
    factors: parseJsonField<WorldFactorState[]>(row.factors),
    regime_labels: parseJsonField<string[]>(row.regime_labels),
    reasoning_summary: row.reasoning_summary,
    created_at: toIsoTimestamp(row.created_at),
  };
}

function mapHypothesisProposalRow(row: BeliefHypothesisProposalRow): CaseAwareBeliefHypothesisProposal {
  return {
    id: row.id,
    run_id: row.run_id,
    agent_id: row.agent_id,
    parent_ids: parseJsonField<string[]>(row.parent_ids),
    hypothesis_kind: row.hypothesis_kind,
    category: row.category,
    subject: row.subject,
    predicate: row.predicate,
    target_time: toIsoTimestamp(row.target_time),
    confidence_score: Number(row.confidence_score),
    reasoning_summary: row.reasoning_summary,
    source_signal_ids: parseJsonField<string[]>(row.source_signal_ids),
    machine_resolvable: Boolean(row.machine_resolvable),
    suggested_resolution_spec: row.suggested_resolution_spec
      ? parseJsonField<ResolutionSpec>(row.suggested_resolution_spec)
      : undefined,
    event_case_id: row.event_case_id,
    case_family_key: row.case_family_key,
    belief_role: row.belief_role ?? undefined,
    publishability_score:
      row.publishability_score === null || row.publishability_score === undefined
        ? undefined
        : Number(row.publishability_score),
    dedupe_key: row.dedupe_key,
    created_at: toIsoTimestamp(row.created_at),
  };
}

async function fetchRunsNeedingAgentOutput(limit: number) {
  const result = await pool.query<SimulationRunRow>(
    `
      SELECT id, trigger_signal_ids, trigger_event_case_ids, status, started_at
      FROM simulation_runs
      WHERE status = 'world_model_pending'
        AND NOT EXISTS (
          SELECT 1
          FROM world_state_proposals
          WHERE world_state_proposals.run_id = simulation_runs.id
            AND world_state_proposals.agent_id = $1
        )
      ORDER BY started_at ASC, id ASC
      LIMIT $2
    `,
    [agentId, limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    trigger_signal_ids: parseJsonField<string[]>(row.trigger_signal_ids),
    trigger_event_case_ids: parseJsonField<string[]>(row.trigger_event_case_ids),
    status: row.status,
    started_at: toIsoTimestamp(row.started_at),
  }));
}

async function fetchEventCaseContexts(eventCaseIds: string[]) {
  if (eventCaseIds.length === 0) {
    return { eventCases: [] as EventCaseContext[], eventCaseIdsBySignal: new Map<string, string[]>() };
  }

  const [eventCaseResult, linksResult] = await Promise.all([
    pool.query<EventCaseContextRow>(
      `
        SELECT id, kind, title, summary, primary_entity, source_types, signal_count, last_signal_at
        FROM event_cases
        WHERE id = ANY($1::text[])
        ORDER BY last_signal_at ASC, id ASC
      `,
      [eventCaseIds],
    ),
    pool.query<EventCaseSignalLinkRow>(
      `
        SELECT event_case_id, signal_id, role
        FROM event_case_signals
        WHERE event_case_id = ANY($1::text[])
        ORDER BY event_case_id ASC, signal_id ASC
      `,
      [eventCaseIds],
    ),
  ]);

  const signalIdsByCase = new Map<string, string[]>();
  const eventCaseIdsBySignal = new Map<string, string[]>();
  const signalRoleCountsByCase = new Map<string, Partial<Record<WorldSignalRole, number>>>();
  for (const row of linksResult.rows) {
    signalIdsByCase.set(row.event_case_id, [...(signalIdsByCase.get(row.event_case_id) ?? []), row.signal_id]);
    eventCaseIdsBySignal.set(row.signal_id, [...(eventCaseIdsBySignal.get(row.signal_id) ?? []), row.event_case_id]);
    const signalRole = normalizeWorldSignalRole(row.role);
    if (signalRole) {
      const existing = signalRoleCountsByCase.get(row.event_case_id) ?? {};
      existing[signalRole] = (existing[signalRole] ?? 0) + 1;
      signalRoleCountsByCase.set(row.event_case_id, existing);
    }
  }

  return {
    eventCases: eventCaseResult.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      primary_entity: row.primary_entity,
      source_types: parseJsonField<string[]>(row.source_types),
      signal_count: Number(row.signal_count),
      last_signal_at: toIsoTimestamp(row.last_signal_at),
      source_signal_ids: signalIdsByCase.get(row.id) ?? [],
      signal_role_counts: signalRoleCountsByCase.get(row.id) ?? {},
    })),
    eventCaseIdsBySignal,
  };
}

async function fetchSignals(signalIds: string[]) {
  if (signalIds.length === 0) {
    return [];
  }

  const result = await pool.query<WorldSignalRow>(
    `
      SELECT *
      FROM world_signals
      WHERE id = ANY($1::text[])
      ORDER BY created_at ASC, id ASC
    `,
    [signalIds],
  );

  return result.rows.map(mapSignalRow);
}

function clamp(value: number, min = 0.05, max = 0.95) {
  return Math.max(min, Math.min(max, value));
}

function readResolutionExtractionMode(signal: WorldSignal): ResolutionExtractionMode | undefined {
  return signal.payload.resolution_extraction_mode === "agent_extract" ? "agent_extract" : undefined;
}

function publishabilityClassForSignal(signal: WorldSignal) {
  return typeof signal.payload.publishability_class === "string" ? signal.payload.publishability_class.trim().toLowerCase() : null;
}

function targetTimeForSignal(signal: WorldSignal) {
  const base = signal.effective_at ? new Date(signal.effective_at) : new Date();
  const millis = Number.isFinite(base.getTime()) ? base.getTime() : Date.now();
  const publishabilityClass = publishabilityClassForSignal(signal);
  const category = categoryForSignal(signal);
  const signalRole = readSignalRole(signal);
  const daysAhead =
    signalRole === "catalyst"
      ? 1
      : publishabilityClass === "sports_event" || publishabilityClass === "weather_event"
      ? 2
      : publishabilityClass === "official_news" || category === "sports" || category === "weather"
        ? 2
        : 3;
  return new Date(millis + daysAhead * 24 * 60 * 60 * 1000).toISOString();
}

function countRole(eventCase: EventCaseContext | null | undefined, role: WorldSignalRole) {
  return eventCase?.signal_role_counts?.[role] ?? 0;
}

function caseHasRole(eventCase: EventCaseContext | null | undefined, role: WorldSignalRole) {
  return countRole(eventCase, role) > 0;
}

function caseHasForecastInputs(eventCase: EventCaseContext | null | undefined) {
  return caseHasRole(eventCase, "precursor") || caseHasRole(eventCase, "catalyst");
}

function caseIsFactOnly(eventCase: EventCaseContext | null | undefined) {
  return Boolean(eventCase) && !caseHasForecastInputs(eventCase) && countRole(eventCase, "fact") > 0;
}

function categoryForSignal(signal: WorldSignal) {
  if (signal.source_type === "economic_calendar") {
    return "economy";
  }
  if (signal.source_type === "price_feed") {
    const subject = String(signal.payload.asset_symbol ?? signal.title).toUpperCase();
    return subject.includes("BTC") || subject.includes("ETH") ? "crypto" : "markets";
  }
  if (typeof signal.payload.category === "string" && signal.payload.category.trim().length > 0) {
    const normalized = signal.payload.category.trim().toLowerCase();
    if (normalized === "met" || normalized === "meteorological" || normalized === "geo") {
      return "weather";
    }
    return normalized;
  }
  if (signal.source_type === "filing") {
    return "business";
  }
  if (signal.source_type === "official_announcement") {
    return "world";
  }
  return "news";
}

function subjectForSignal(signal: WorldSignal) {
  return String(
    signal.payload.asset_symbol ??
      signal.payload.institution ??
      signal.payload.event_name ??
      signal.payload.event ??
      signal.title,
  );
}

function predicateForSignal(signal: WorldSignal, kind: ResolutionSpec["kind"], threshold?: number, direction?: string) {
  if (kind === "price_threshold") {
    return `${subjectForSignal(signal)} spot price >= ${threshold ?? 0} by target date`;
  }
  if (kind === "rate_decision") {
    const institution = String(signal.payload.institution ?? subjectForSignal(signal) ?? "Central bank");
    return `${institution} will ${direction ?? "hold"} rates by target date`;
  }
  const subject = String(signal.payload.event_name ?? signal.payload.event ?? signal.title);
  const publishabilityClass = publishabilityClassForSignal(signal);
  if (publishabilityClass === "official_news") {
    return `${subject} will be officially announced by target date`;
  }
  if (publishabilityClass === "weather_event") {
    return `${subject} weather event will occur by target date`;
  }
  if (publishabilityClass === "sports_event") {
    return `${subject} sports event will occur by target date`;
  }
  return `${signal.title} will occur by target date`;
}

function reasoningForSignal(signal: WorldSignal, kind: ResolutionSpec["kind"]) {
  return `${agentId} formed a ${kind} hypothesis from signal ${signal.id}.`;
}

function fieldsForSignal(
  signal: WorldSignal,
  kind: ResolutionSpec["kind"],
  threshold?: number,
  direction?: "cut" | "hold" | "hike",
) {
  return {
    subject: subjectForSignal(signal),
    category: categoryForSignal(signal),
    predicate: predicateForSignal(signal, kind, threshold, direction),
  };
}

function normalizePriceOperator(value: unknown): "gt" | "gte" | "lt" | "lte" | null {
  if (typeof value !== "string") {
    return null;
  }

  switch (value.trim().toLowerCase()) {
    case ">":
    case "gt":
      return "gt";
    case ">=":
    case "gte":
      return "gte";
    case "<":
    case "lt":
      return "lt";
    case "<=":
    case "lte":
      return "lte";
    default:
      return null;
  }
}

function derivePriceThresholdFromSignal(signal: WorldSignal) {
  const rawPrice =
    typeof signal.payload.price === "number"
      ? signal.payload.price
      : typeof signal.payload.close === "number"
        ? signal.payload.close
        : typeof signal.payload.current_price === "number"
          ? signal.payload.current_price
          : null;
  if (!rawPrice || !Number.isFinite(rawPrice) || rawPrice <= 0) {
    return null;
  }

  const category = categoryForSignal(signal);
  const uplift =
    category === "fx"
      ? 0.01
      : category === "crypto"
        ? 0.03
        : 0.02;
  const decimals = category === "fx" ? 4 : 2;
  const threshold = Number((rawPrice * (1 + uplift)).toFixed(decimals));

  return {
    operator: "gte" as const,
    threshold,
  };
}

function canonicalSourceUrlForSpec(spec?: ResolutionSpec) {
  if (!spec || !spec.source || typeof spec.source.canonical_url !== "string") {
    return null;
  }
  return spec.source.canonical_url;
}

function caseFamilyKeyForSignal(signal: WorldSignal, eventCaseId: string | null) {
  if (eventCaseId) {
    return eventCaseId;
  }

  return buildDedupeKey({
    scope: "signal-fallback-case",
    source_type: signal.source_type,
    source_adapter: signal.source_adapter,
    source_url: signal.source_url,
    subject: subjectForSignal(signal),
    category: categoryForSignal(signal),
  });
}

function directionBucketForPrice(operator: PriceThresholdDecisionRule["operator"]) {
  return operator === "gt" || operator === "gte" ? "up" : "down";
}

function targetDayBucket(targetTime: string) {
  return targetTime.slice(0, 10);
}

function buildPriceFamilyKey(hypothesis: CaseAwareBeliefHypothesisProposal) {
  if (hypothesis.hypothesis_kind !== "price_threshold" || !hypothesis.suggested_resolution_spec) {
    return null;
  }

  const spec = hypothesis.suggested_resolution_spec;
  if (spec.kind !== "price_threshold") {
    return null;
  }

  const canonicalUrl = canonicalSourceUrlForSpec(spec);
  if (!canonicalUrl) {
    return null;
  }

  return buildDedupeKey({
    scope: "price-family",
    canonical_url: canonicalUrl,
    direction: directionBucketForPrice(spec.decision_rule.operator),
    target_day: targetDayBucket(hypothesis.target_time),
  });
}

function compareAnnotatedHypotheses(
  left: Pick<
    CaseAnnotatedHypothesis,
    "publishability_score" | "machine_resolvable" | "confidence_score" | "source_signal" | "hypothesis_kind" | "created_at"
  >,
  right: Pick<
    CaseAnnotatedHypothesis,
    "publishability_score" | "machine_resolvable" | "confidence_score" | "source_signal" | "hypothesis_kind" | "created_at"
  >,
) {
  return (
    right.publishability_score - left.publishability_score ||
    Number(right.machine_resolvable) - Number(left.machine_resolvable) ||
    right.confidence_score - left.confidence_score ||
    Number(right.hypothesis_kind !== "price_threshold") - Number(left.hypothesis_kind !== "price_threshold") ||
    Number(right.source_signal.trust_tier === "official") - Number(left.source_signal.trust_tier === "official") ||
    right.created_at.localeCompare(left.created_at)
  );
}

function scoreHypothesis(
  hypothesis: CaseAwareBeliefHypothesisProposal,
  signal: WorldSignal,
  eventCaseId: string | null,
  eventCase: EventCaseContext | null,
) {
  const category = hypothesis.category;
  const signalRole = readSignalRole(signal);
  let score = clamp(hypothesis.confidence_score, 0, 1);

  if (hypothesis.machine_resolvable) {
    score += 0.25;
  }
  if (hypothesis.hypothesis_kind !== "price_threshold") {
    score += 0.08;
  }
  if (signal.trust_tier === "official") {
    score += 0.05;
  } else if (signal.trust_tier === "curated") {
    score += 0.02;
  }
  if (category === "world" || category === "sports" || category === "weather" || category === "business") {
    score += 0.04;
  }
  if (publishabilityClassForSignal(signal) === "official_news") {
    score += 0.08;
  } else if (publishabilityClassForSignal(signal) === "weather_event") {
    score += 0.06;
  } else if (publishabilityClassForSignal(signal) === "sports_event") {
    score += 0.05;
  }
  if (signalRole === "precursor") {
    score += 0.14;
  } else if (signalRole === "catalyst") {
    score += 0.12;
  } else if (signalRole === "fact") {
    score -= 0.08;
  } else if (signalRole === "resolution") {
    score -= 0.18;
  }
  if (caseHasForecastInputs(eventCase)) {
    score += 0.08;
  } else if (caseIsFactOnly(eventCase) && hypothesis.hypothesis_kind === "event_occurrence") {
    score -= 0.18;
  }
  if (eventCaseId) {
    score += 0.04;
  }

  return clamp(score, 0, 1.5);
}

function selectHypothesesForPersistence(
  hypotheses: CaseAwareBeliefHypothesisProposal[],
  signalMap: Map<string, WorldSignal>,
  eventCaseIdsBySignal: Map<string, string[]>,
  eventCases: EventCaseContext[],
) {
  const eligibleBase = hypotheses.filter((hypothesis) => signalMap.has(hypothesis.source_signal_ids[0] ?? ""));
  const pool = eligibleBase.some((hypothesis) => hypothesis.machine_resolvable)
    ? eligibleBase.filter((hypothesis) => hypothesis.machine_resolvable)
    : eligibleBase;
  const eventCaseMap = new Map(eventCases.map((eventCase) => [eventCase.id, eventCase]));

  const annotated = pool.map((hypothesis) => {
    const sourceSignal = signalMap.get(hypothesis.source_signal_ids[0] ?? "") as WorldSignal;
    const eventCaseId = eventCaseIdsBySignal.get(sourceSignal.id)?.[0] ?? null;
    const eventCase = eventCaseId ? eventCaseMap.get(eventCaseId) ?? null : null;
    const caseFamilyKey = caseFamilyKeyForSignal(sourceSignal, eventCaseId);
    return {
      ...hypothesis,
      source_signal: sourceSignal,
      event_case_id: eventCaseId,
      case_family_key: caseFamilyKey,
      belief_role: "primary" as const,
      publishability_score: scoreHypothesis(hypothesis, sourceSignal, eventCaseId, eventCase),
    } satisfies CaseAnnotatedHypothesis;
  });

  const forecastBackedCandidates = annotated.filter((candidate) => {
    const eventCase = candidate.event_case_id ? eventCaseMap.get(candidate.event_case_id) ?? null : null;
    return readSignalRole(candidate.source_signal) !== "fact" || caseHasForecastInputs(eventCase);
  });
  const rankedPool = forecastBackedCandidates.length > 0 ? forecastBackedCandidates : annotated;

  const bestByCase = new Map<string, CaseAnnotatedHypothesis>();
  for (const candidate of rankedPool) {
    const existing = bestByCase.get(candidate.case_family_key);
    if (!existing || compareAnnotatedHypotheses(candidate, existing) < 0) {
      bestByCase.set(candidate.case_family_key, candidate);
    }
  }

  const cappedByPriceFamily = new Map<string, CaseAnnotatedHypothesis>();
  const nonPriceCandidates: CaseAnnotatedHypothesis[] = [];
  for (const candidate of bestByCase.values()) {
    const priceFamilyKey = buildPriceFamilyKey(candidate);
    if (!priceFamilyKey) {
      nonPriceCandidates.push(candidate);
      continue;
    }
    const existing = cappedByPriceFamily.get(priceFamilyKey);
    if (!existing || compareAnnotatedHypotheses(candidate, existing) < 0) {
      cappedByPriceFamily.set(priceFamilyKey, candidate);
    }
  }

  const candidates = [...nonPriceCandidates, ...cappedByPriceFamily.values()].sort(compareAnnotatedHypotheses);
  const selected = new Map<string, CaseAnnotatedHypothesis>();
  const representedCategories = new Set<string>();
  const hasNonPriceCandidates = candidates.some((candidate) => candidate.hypothesis_kind !== "price_threshold");
  const maxPriceSelections = hasNonPriceCandidates ? maxPriceFamiliesPerRun : Math.min(maxHypothesesPerRun, 4);
  const hasForecastBackedCandidates = candidates.some((candidate) => {
    const eventCase = candidate.event_case_id ? eventCaseMap.get(candidate.event_case_id) ?? null : null;
    return readSignalRole(candidate.source_signal) !== "fact" || caseHasForecastInputs(eventCase);
  });
  const maxFactSelections = hasForecastBackedCandidates ? 1 : 2;
  let priceSelections = 0;
  let factSelections = 0;

  const categoriesByPriority = [...new Set(candidates.map((candidate) => candidate.category))];
  for (const category of categoriesByPriority) {
    if (selected.size >= maxHypothesesPerRun) {
      break;
    }
    const winner = candidates.find((candidate) => candidate.category === category && !selected.has(candidate.id));
    if (!winner) {
      continue;
    }
    if (winner.hypothesis_kind === "price_threshold" && priceSelections >= maxPriceSelections) {
      continue;
    }
    if (readSignalRole(winner.source_signal) === "fact" && factSelections >= maxFactSelections) {
      continue;
    }
    selected.set(winner.id, winner);
    representedCategories.add(category);
    if (winner.hypothesis_kind === "price_threshold") {
      priceSelections += 1;
    }
    if (readSignalRole(winner.source_signal) === "fact") {
      factSelections += 1;
    }
  }

  for (const candidate of candidates) {
    if (selected.size >= maxHypothesesPerRun) {
      break;
    }
    if (selected.has(candidate.id)) {
      continue;
    }
    if (candidate.hypothesis_kind === "price_threshold" && priceSelections >= maxPriceSelections) {
      continue;
    }
    if (readSignalRole(candidate.source_signal) === "fact" && factSelections >= maxFactSelections) {
      continue;
    }
    if (!representedCategories.has(candidate.category) && selected.size > 0) {
      representedCategories.add(candidate.category);
    }
    selected.set(candidate.id, candidate);
    if (candidate.hypothesis_kind === "price_threshold") {
      priceSelections += 1;
    }
    if (readSignalRole(candidate.source_signal) === "fact") {
      factSelections += 1;
    }
  }

  const finalized = [...selected.values()].sort(compareAnnotatedHypotheses).map((candidate) => {
    const { source_signal: _sourceSignal, ...hypothesis } = candidate;
    return hypothesis;
  });

  return finalized.length > 0 ? finalized : hypotheses.sort((left, right) => right.confidence_score - left.confidence_score).slice(0, 1);
}

function buildPriceThresholdSpec(
  signal: WorldSignal,
  options: {
    operator: "gt" | "gte" | "lt" | "lte";
    threshold: number;
  },
): ResolutionSpec | null {
  const assetSymbol =
    typeof signal.payload.asset_symbol === "string" ? signal.payload.asset_symbol : undefined;
  const operator = options.operator;
  const threshold = options.threshold;
  const canonicalSourceUrl =
    typeof signal.payload.canonical_source_url === "string" ? signal.payload.canonical_source_url : undefined;
  const observationPricePath =
    typeof signal.payload.observation_price_path === "string" && signal.payload.observation_price_path.trim().length > 0
      ? signal.payload.observation_price_path.trim()
      : "price";

  if (!assetSymbol || !Number.isFinite(threshold) || !canonicalSourceUrl || threshold <= 0) {
    return null;
  }

  return {
    kind: "price_threshold",
    source: {
      adapter: "http_json",
      canonical_url: canonicalSourceUrl,
      allowed_domains: normalizeAllowedDomainsFromUrl(canonicalSourceUrl),
      extraction_mode: readResolutionExtractionMode(signal),
    },
    observation_schema: {
      type: "object",
      fields: {
        price: { type: "number", path: observationPricePath },
        observed_at: { type: "string", path: "observed_at", required: false },
      },
    },
    decision_rule: {
      kind: "price_threshold",
      observation_field: "price",
      operator,
      threshold,
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
  };
}

function buildRateDecisionSpec(signal: WorldSignal): ResolutionSpec | null {
  const direction =
    signal.payload.direction === "hold" || signal.payload.direction === "hike"
      ? signal.payload.direction
      : "cut";
  const canonicalSourceUrl =
    typeof signal.payload.canonical_source_url === "string" ? signal.payload.canonical_source_url : undefined;

  if (!canonicalSourceUrl) {
    return null;
  }

  return {
    kind: "rate_decision",
    source: {
      adapter: "http_json",
      canonical_url: canonicalSourceUrl,
      allowed_domains: normalizeAllowedDomainsFromUrl(canonicalSourceUrl),
      extraction_mode: readResolutionExtractionMode(signal),
    },
    observation_schema: {
      type: "object",
      fields: {
        previous_upper_bound_bps: { type: "number", path: "previous_upper_bound_bps" },
        current_upper_bound_bps: { type: "number", path: "current_upper_bound_bps" },
        observed_at: { type: "string", path: "observed_at", required: false },
      },
    },
    decision_rule: {
      kind: "rate_decision",
      previous_field: "previous_upper_bound_bps",
      current_field: "current_upper_bound_bps",
      direction,
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
  };
}

function buildEventOccurrenceSpec(signal: WorldSignal): ResolutionSpec | null {
  const canonicalSourceUrl =
    typeof signal.payload.canonical_source_url === "string" ? signal.payload.canonical_source_url : signal.source_url;
  const observationPath =
    typeof signal.payload.observation_occurrence_path === "string" &&
    signal.payload.observation_occurrence_path.trim().length > 0
      ? signal.payload.observation_occurrence_path.trim()
      : null;

  if (!canonicalSourceUrl || !observationPath) {
    return null;
  }

  return {
    kind: "event_occurrence",
    source: {
      adapter: "http_json",
      canonical_url: canonicalSourceUrl,
      allowed_domains: normalizeAllowedDomainsFromUrl(canonicalSourceUrl),
      extraction_mode: readResolutionExtractionMode(signal),
    },
    observation_schema: {
      type: "object",
      fields: {
        occurred: { type: "boolean", path: observationPath },
        observed_at: { type: "string", path: "observed_at", required: false },
      },
    },
    decision_rule: {
      kind: "event_occurrence",
      observation_field: "occurred",
      expected_value: true,
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
  };
}

function buildWorldModelLlmSystemPrompt() {
  return [
    "You are a world-model agent in an autonomous prediction-market platform.",
    "Return strict JSON only.",
    "Generate one world_state object and a hypotheses array.",
    "Each hypothesis must map to one input signal via source_signal_id.",
    "Treat event cases as the primary unit of thought, not isolated raw signals.",
    "Use only these hypothesis kinds: price_threshold, rate_decision, event_occurrence.",
    "Set confidence_score in [0,1].",
    "Every hypothesis must include source_signal_id, hypothesis_kind, subject, predicate, target_time, reasoning_summary, and confidence_score.",
    "For price_threshold hypotheses, always include price_threshold.operator using gt/gte/lt/lte and price_threshold.threshold.",
    "Prefer one distinct publishable belief per event case when possible.",
    "Prefer precursor and catalyst evidence over fact-confirmation headlines when forming forecast beliefs.",
    "Use fact signals mainly to ground the world state, not to restate events that are already complete.",
    "When an event case has only fact signals and no precursor or catalyst, avoid post-hoc event_occurrence hypotheses unless no better forecastable cases exist.",
    "Prefer coverage across distinct source signals and source types when valid machine-resolvable signals are present.",
    "Do not emit multiple near-identical BTC hypotheses if other eligible signals are available in the same batch.",
    "Never hallucinate source ids.",
  ].join(" ");
}

function buildWorldModelLlmUserPayload(
  signals: WorldSignal[],
  eventCases: EventCaseContext[],
  eventCaseIdsBySignal: Map<string, string[]>,
) {
  return {
    agent_profile: agentProfile,
    event_cases: eventCases.map((eventCase) => ({
      id: eventCase.id,
      kind: eventCase.kind,
      title: eventCase.title,
      summary: eventCase.summary,
      primary_entity: eventCase.primary_entity,
      source_types: eventCase.source_types,
      signal_role_counts: eventCase.signal_role_counts,
      signal_count: eventCase.signal_count,
      last_signal_at: eventCase.last_signal_at,
      source_signal_ids: eventCase.source_signal_ids,
    })),
    signals: signals.map((signal) => ({
      id: signal.id,
      event_case_ids: eventCaseIdsBySignal.get(signal.id) ?? [],
      signal_role: readSignalRole(signal),
      source_type: signal.source_type,
      title: signal.title,
      summary: signal.summary,
      effective_at: signal.effective_at,
      entity_refs: signal.entity_refs,
      payload: signal.payload,
    })),
  };
}

async function generateWithLlm(
  runId: string,
  triggerSignalIds: string[],
  signals: WorldSignal[],
  eventCases: EventCaseContext[],
  eventCaseIdsBySignal: Map<string, string[]>,
) {
  if (!llmClient) {
    throw new Error("world_model_llm_client_unavailable");
  }

  const response = await llmClient.chatJson<WorldModelLlmResponse>([
    { role: "system", content: buildWorldModelLlmSystemPrompt() },
    {
      role: "user",
      content: JSON.stringify(buildWorldModelLlmUserPayload(signals, eventCases, eventCaseIdsBySignal)),
    },
  ]);

  if (!response || typeof response !== "object" || !Array.isArray(response.hypotheses)) {
    throw new Error("invalid_world_model_llm_response");
  }

  const signalMap = new Map<string, WorldSignal>(signals.map((signal) => [signal.id, signal]));
  const eventCaseMap = new Map(eventCases.map((eventCase) => [eventCase.id, eventCase]));
  const worldStateProposal: WorldStateProposal = {
    id: randomUUID(),
    run_id: runId,
    agent_id: agentId,
    source_signal_ids: triggerSignalIds,
    as_of:
      typeof response.world_state?.as_of === "string" ? response.world_state.as_of : new Date().toISOString(),
    entities: Array.isArray(response.world_state?.entities) ? response.world_state.entities : [],
    active_events: Array.isArray(response.world_state?.active_events) ? response.world_state.active_events : [],
    factors: Array.isArray(response.world_state?.factors) ? response.world_state.factors : [],
    regime_labels: Array.isArray(response.world_state?.regime_labels)
      ? response.world_state.regime_labels
      : ["belief-layer", "market:mixed"],
    reasoning_summary:
      typeof response.world_state?.reasoning_summary === "string"
        ? response.world_state.reasoning_summary
        : `${agentId} generated an LLM world-state interpretation.`,
    created_at: new Date().toISOString(),
  };

  const stateValidation = validateWorldStateProposal(worldStateProposal);
  if (!stateValidation.ok) {
    throw new Error(`invalid_world_state_proposal:${stateValidation.errors.join(",")}`);
  }

  const hypotheses: CaseAwareBeliefHypothesisProposal[] = [];
  for (const item of response.hypotheses) {
    const signal = signalMap.get(item.source_signal_id);
    if (!signal) {
      continue;
    }

    const normalizedKind =
      signal.source_type === "price_feed"
        ? "price_threshold"
        : signal.source_type === "economic_calendar"
          ? "rate_decision"
          : "event_occurrence";
    if (!normalizedKind) {
      continue;
    }

    let suggestedResolutionSpec: ResolutionSpec | undefined;
    let resolvedThreshold: number | undefined;
    let resolvedDirection: "cut" | "hold" | "hike" | undefined;
    if (normalizedKind === "price_threshold") {
      const derivedThreshold = derivePriceThresholdFromSignal(signal);
      const operator = normalizePriceOperator(item.price_threshold?.operator) ?? derivedThreshold?.operator ?? null;
      const threshold = Number(item.price_threshold?.threshold ?? derivedThreshold?.threshold);
      if (!operator || !Number.isFinite(threshold) || threshold <= 0) {
        continue;
      }
      resolvedThreshold = threshold;
      suggestedResolutionSpec = buildPriceThresholdSpec(signal, {
        operator,
        threshold,
      }) ?? undefined;
    } else if (normalizedKind === "rate_decision") {
      const directionValue = String(signal.payload.direction ?? signal.payload.expected_direction ?? "hold").toLowerCase();
      resolvedDirection =
        directionValue === "cut" || directionValue === "hold" || directionValue === "hike" ? directionValue : "hold";
      suggestedResolutionSpec = buildRateDecisionSpec(signal) ?? undefined;
    } else if (normalizedKind === "event_occurrence") {
      suggestedResolutionSpec = buildEventOccurrenceSpec(signal) ?? undefined;
    }

    const signalFields = fieldsForSignal(signal, normalizedKind, resolvedThreshold, resolvedDirection);
    const machineResolvable = Boolean(item.machine_resolvable ?? true) && Boolean(suggestedResolutionSpec);
    const subject = signalFields.subject;
    const eventCaseId = eventCaseIdsBySignal.get(signal.id)?.[0] ?? null;
    const eventCase = eventCaseId ? eventCaseMap.get(eventCaseId) ?? null : null;
    const caseFamilyKey = caseFamilyKeyForSignal(signal, eventCaseId);
    const targetTime =
      typeof item.target_time === "string" && item.target_time.trim().length > 0
        ? item.target_time
        : targetTimeForSignal(signal);
    const category = signalFields.category;
    const predicate = signalFields.predicate;
    const confidenceScore = clamp(Number(item.confidence_score));
    const reasoningSummary =
      typeof item.reasoning_summary === "string" && item.reasoning_summary.trim().length > 0
        ? item.reasoning_summary.trim()
        : reasoningForSignal(signal, normalizedKind);
    const hypothesisBase: Omit<CaseAwareBeliefHypothesisProposal, "id" | "dedupe_key" | "created_at"> = {
      run_id: runId,
      agent_id: agentId,
      parent_ids: [signal.id],
      hypothesis_kind: normalizedKind,
      category,
      subject,
      predicate,
      target_time: targetTime,
      confidence_score: confidenceScore,
      reasoning_summary: reasoningSummary,
      source_signal_ids: [signal.id],
      machine_resolvable: machineResolvable,
      suggested_resolution_spec: suggestedResolutionSpec,
      event_case_id: eventCaseId,
      case_family_key: caseFamilyKey,
      belief_role: "secondary",
      publishability_score: undefined,
    };
    const hypothesis: CaseAwareBeliefHypothesisProposal = {
      id: randomUUID(),
      ...hypothesisBase,
      publishability_score: scoreHypothesis(
        {
          ...hypothesisBase,
          id: "score-only",
          dedupe_key: "score-only",
          created_at: new Date().toISOString(),
        },
        signal,
        eventCaseId,
        eventCase,
      ),
      dedupe_key: buildDedupeKey({
        kind: normalizedKind,
        subject,
        predicate,
        target_time: targetTime,
        resolution_spec: suggestedResolutionSpec ?? null,
      }),
      created_at: new Date().toISOString(),
    };
    const validation = validateBeliefHypothesisProposal(hypothesis);
    if (validation.ok) {
      hypotheses.push(hypothesis);
    }
  }

  if (hypotheses.length === 0) {
    throw new Error("world_model_llm_produced_no_valid_hypotheses");
  }

  const selectedHypotheses = selectHypothesesForPersistence(hypotheses, signalMap, eventCaseIdsBySignal, eventCases);
  if (selectedHypotheses.length === 0) {
    throw new Error("world_model_selection_produced_no_hypotheses");
  }

  return {
    worldStateProposal: stateValidation.proposal,
    hypotheses: selectedHypotheses,
  };
}

async function upsertWorldStateProposal(proposal: WorldStateProposal) {
  await pool.query(
    `
      INSERT INTO world_state_proposals (
        id,
        run_id,
        agent_id,
        source_signal_ids,
        as_of,
        entities,
        active_events,
        factors,
        regime_labels,
        reasoning_summary,
        created_at
      )
      VALUES (
        $1, $2, $3, $4::jsonb, $5::timestamptz, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::timestamptz
      )
      ON CONFLICT (run_id, agent_id) DO UPDATE SET
        source_signal_ids = EXCLUDED.source_signal_ids,
        as_of = EXCLUDED.as_of,
        entities = EXCLUDED.entities,
        active_events = EXCLUDED.active_events,
        factors = EXCLUDED.factors,
        regime_labels = EXCLUDED.regime_labels,
        reasoning_summary = EXCLUDED.reasoning_summary
    `,
    [
      proposal.id,
      proposal.run_id,
      proposal.agent_id,
      JSON.stringify(proposal.source_signal_ids),
      proposal.as_of,
      JSON.stringify(proposal.entities),
      JSON.stringify(proposal.active_events),
      JSON.stringify(proposal.factors),
      JSON.stringify(proposal.regime_labels),
      proposal.reasoning_summary,
      proposal.created_at,
    ],
  );
}

async function upsertBeliefHypothesisProposal(proposal: CaseAwareBeliefHypothesisProposal) {
  await pool.query(
    `
      INSERT INTO belief_hypothesis_proposals (
        id,
        run_id,
        agent_id,
        parent_ids,
        hypothesis_kind,
        category,
        subject,
        predicate,
        target_time,
        confidence_score,
        reasoning_summary,
        source_signal_ids,
        machine_resolvable,
        suggested_resolution_spec,
        event_case_id,
        case_family_key,
        belief_role,
        publishability_score,
        dedupe_key,
        created_at
      )
      VALUES (
        $1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::timestamptz, $10, $11, $12::jsonb, $13, $14::jsonb, $15, $16, $17, $18, $19, $20::timestamptz
      )
      ON CONFLICT (run_id, agent_id, dedupe_key) DO UPDATE SET
        confidence_score = EXCLUDED.confidence_score,
        reasoning_summary = EXCLUDED.reasoning_summary,
        source_signal_ids = EXCLUDED.source_signal_ids,
        machine_resolvable = EXCLUDED.machine_resolvable,
        suggested_resolution_spec = EXCLUDED.suggested_resolution_spec,
        event_case_id = EXCLUDED.event_case_id,
        case_family_key = EXCLUDED.case_family_key,
        belief_role = EXCLUDED.belief_role,
        publishability_score = EXCLUDED.publishability_score
    `,
    [
      proposal.id,
      proposal.run_id,
      proposal.agent_id,
      JSON.stringify(proposal.parent_ids),
      proposal.hypothesis_kind,
      proposal.category,
      proposal.subject,
      proposal.predicate,
      proposal.target_time,
      proposal.confidence_score,
      proposal.reasoning_summary,
      JSON.stringify(proposal.source_signal_ids),
      proposal.machine_resolvable,
      JSON.stringify(proposal.suggested_resolution_spec ?? null),
      proposal.event_case_id ?? null,
      proposal.case_family_key ?? null,
      proposal.belief_role ?? null,
      proposal.publishability_score ?? null,
      proposal.dedupe_key,
      proposal.created_at,
    ],
  );
}

async function processRun(runId: string, triggerSignalIds: string[], triggerEventCaseIds: string[]) {
  const signals = await fetchSignals(triggerSignalIds);
  if (signals.length === 0) {
    return;
  }

  let output:
    | {
        worldStateProposal: WorldStateProposal;
        hypotheses: CaseAwareBeliefHypothesisProposal[];
      }
    | undefined;

  if (mode !== "llm" || !llmClient) {
    throw new Error("world_model_requires_llm_mode_and_client");
  }
  const { eventCases, eventCaseIdsBySignal } = await fetchEventCaseContexts(triggerEventCaseIds);
  output = await generateWithLlm(runId, triggerSignalIds, signals, eventCases, eventCaseIdsBySignal);

  await upsertWorldStateProposal(output.worldStateProposal);
  for (const hypothesis of output.hypotheses) {
    await upsertBeliefHypothesisProposal(hypothesis);
  }
}

async function tick() {
  if (tickInFlight) {
    return;
  }

  tickInFlight = true;
  try {
    const runs = await fetchRunsNeedingAgentOutput(batchSize);
    const errors: string[] = [];
    await runWithConcurrency(runs, runConcurrency, async (run) => {
      try {
        await processRun(run.id, run.trigger_signal_ids, run.trigger_event_case_ids);
      } catch (error) {
        errors.push(`${run.id}:${String(error)}`);
        app.log.error({ run_id: run.id, error: String(error) }, "world_model_failed_to_process_run");
      }
    });
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

app.get("/health", async () => ({
  service: "world-model",
  status: "ok",
  agent_id: agentId,
  agent_profile: agentProfile,
  mode,
  last_tick_at: lastTickAt,
  last_tick_error: lastTickError,
}));

app.get("/v1/internal/world-state-proposals", async () => {
  const result = await pool.query<WorldStateProposalRow>(
    `
      SELECT *
      FROM world_state_proposals
      ORDER BY created_at DESC, id DESC
    `,
  );

  return {
    items: result.rows.map(mapWorldStateProposalRow),
  };
});

app.get("/v1/internal/world-model-hypotheses", async () => {
  const result = await pool.query<BeliefHypothesisProposalRow>(
    `
      SELECT *
      FROM belief_hypothesis_proposals
      ORDER BY created_at DESC, id DESC
    `,
  );

  return {
    items: result.rows.map(mapHypothesisProposalRow),
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
