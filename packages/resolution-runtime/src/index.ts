import { createHash } from "node:crypto";
import {
  type ObservationPayload,
  type ResolutionOutcome,
  type ResolutionSourceAdapter,
  type ResolutionSpec,
  deriveOutcomeFromResolutionSpec,
  extractObservationPayloadFromJson,
  validateObservationPayload,
} from "@automakit/sdk-types";

export type RuntimeCollectedObservation = {
  source_url: string;
  source_hash: string;
  source_adapter: ResolutionSourceAdapter;
  parser_version: string;
  observed_at: string;
  observation_payload: ObservationPayload;
  derived_outcome: ResolutionOutcome;
  summary: string;
};

export type RuntimeFetchedSourceDocument = {
  source_url: string;
  source_hash: string;
  source_adapter: ResolutionSourceAdapter;
  fetched_at: string;
  content_type: string | null;
  raw_body: string;
};

export class ResolutionRuntimeError extends Error {
  code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "ResolutionRuntimeError";
  }
}

export function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeHostname(url: string) {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

export function isAllowedSource(candidateUrl: string, allowedDomains: string[]) {
  const candidateHost = normalizeHostname(candidateUrl);
  return allowedDomains.some((domain) => {
    const normalized = domain.toLowerCase();
    return candidateHost === normalized || candidateHost.endsWith(`.${normalized}`);
  });
}

export function summarizeObservation(
  spec: ResolutionSpec,
  payload: ObservationPayload,
  outcome: ResolutionOutcome,
) {
  if (spec.kind === "price_threshold") {
    return `Collected price observation for ${String(payload[spec.decision_rule.observation_field])}; derived ${outcome}.`;
  }

  if (spec.kind === "event_occurrence") {
    return `Collected event occurrence observation (${String(payload[spec.decision_rule.observation_field])}); derived ${outcome}.`;
  }

  return `Collected rate decision observation (${String(payload[spec.decision_rule.previous_field])} -> ${String(payload[spec.decision_rule.current_field])}); derived ${outcome}.`;
}

export function getObservedAtFromPayload(payload: ObservationPayload) {
  const observedAt = payload.observed_at;
  if (typeof observedAt === "string" && !Number.isNaN(Date.parse(observedAt))) {
    return new Date(observedAt).toISOString();
  }

  return new Date().toISOString();
}

export function extractAndValidateObservationPayload(spec: ResolutionSpec, payload: unknown) {
  const observationPayload = extractObservationPayloadFromJson(spec, payload);
  if (!observationPayload) {
    throw new ResolutionRuntimeError("source_payload_not_extractable");
  }

  const schemaErrors = validateObservationPayload(spec, observationPayload);
  if (schemaErrors.length > 0) {
    throw new ResolutionRuntimeError(
      "observation_schema_validation_failed",
      `observation_schema_validation_failed:${schemaErrors.join(",")}`,
    );
  }

  return observationPayload;
}

export function deriveDeterministicOutcome(spec: ResolutionSpec, observationPayload: ObservationPayload) {
  const derivedOutcome = deriveOutcomeFromResolutionSpec(spec, observationPayload);
  if (!derivedOutcome) {
    throw new ResolutionRuntimeError("decision_rule_not_applicable");
  }

  return derivedOutcome;
}

export async function fetchSourceDocument(spec: ResolutionSpec): Promise<RuntimeFetchedSourceDocument> {
  if (spec.source.adapter !== "http_json") {
    throw new ResolutionRuntimeError("unsupported_source_adapter");
  }

  if (!isAllowedSource(spec.source.canonical_url, spec.source.allowed_domains)) {
    throw new ResolutionRuntimeError("canonical_source_not_allowed_by_spec");
  }

  const response = await fetch(spec.source.canonical_url, {
    method: spec.source.method ?? "GET",
    headers: {
      accept: spec.source.extraction_mode === "agent_extract" ? "*/*" : "application/json",
      ...(spec.source.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new ResolutionRuntimeError("source_fetch_failed", `source_fetch_failed:${response.status}`);
  }

  const rawBody = await response.text();
  return {
    source_url: spec.source.canonical_url,
    source_hash: sha256Hex(rawBody),
    source_adapter: spec.source.adapter,
    fetched_at: new Date().toISOString(),
    content_type: response.headers.get("content-type"),
    raw_body: rawBody,
  };
}

export async function collectObservationFromSource(spec: ResolutionSpec): Promise<RuntimeCollectedObservation> {
  if (spec.source.extraction_mode === "agent_extract") {
    throw new ResolutionRuntimeError("agent_extraction_required");
  }

  const document = await fetchSourceDocument(spec);

  let parsed: unknown;
  try {
    parsed = JSON.parse(document.raw_body);
  } catch {
    throw new ResolutionRuntimeError("source_payload_not_json");
  }

  const observationPayload = extractAndValidateObservationPayload(spec, parsed);
  const observedAt = getObservedAtFromPayload(observationPayload);
  const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(observedAt)) / 1000));
  if (ageSeconds > spec.quarantine_rule.max_observation_age_seconds) {
    throw new ResolutionRuntimeError("observation_too_old");
  }

  const derivedOutcome = deriveDeterministicOutcome(spec, observationPayload);

  return {
    source_url: document.source_url,
    source_hash: document.source_hash,
    source_adapter: document.source_adapter,
    parser_version: "resolution-runtime@1",
    observed_at: observedAt,
    observation_payload: observationPayload,
    derived_outcome: derivedOutcome,
    summary: summarizeObservation(spec, observationPayload, derivedOutcome),
  };
}
