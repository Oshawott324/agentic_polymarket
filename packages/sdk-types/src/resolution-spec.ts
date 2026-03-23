export type ResolutionKind = "price_threshold" | "rate_decision";
export type ResolutionOutcome = "YES" | "NO" | "CANCELED";
export type ResolutionAgreement = "all" | "majority" | "2_of_3";
export type ObservationFieldType = "number" | "string" | "boolean";
export type ResolutionSourceAdapter = "http_json";

export type ObservationValue = string | number | boolean | null;
export type ObservationPayload = Record<string, ObservationValue>;

export type ResolutionSourceSpec = {
  adapter: ResolutionSourceAdapter;
  canonical_url: string;
  allowed_domains: string[];
  method?: "GET";
  headers?: Record<string, string>;
};

export type ObservationSchemaField = {
  type: ObservationFieldType;
  path: string;
  required?: boolean;
};

export type ObservationSchema = {
  type: "object";
  fields: Record<string, ObservationSchemaField>;
};

export type PriceThresholdDecisionRule = {
  kind: "price_threshold";
  observation_field: string;
  operator: "gt" | "gte" | "lt" | "lte";
  threshold: number;
};

export type RateDecisionRule = {
  kind: "rate_decision";
  previous_field: string;
  current_field: string;
  direction: "cut" | "hold" | "hike";
};

export type DecisionRule = PriceThresholdDecisionRule | RateDecisionRule;

export type QuorumRule = {
  min_observations: number;
  min_distinct_collectors: number;
  agreement: ResolutionAgreement;
};

export type QuarantineRule = {
  on_source_fetch_failure: boolean;
  on_schema_validation_failure: boolean;
  on_observation_conflict: boolean;
  max_observation_age_seconds: number;
};

export type ResolutionSpec =
  | {
      kind: "price_threshold";
      source: ResolutionSourceSpec;
      observation_schema: ObservationSchema;
      decision_rule: PriceThresholdDecisionRule;
      quorum_rule: QuorumRule;
      quarantine_rule: QuarantineRule;
    }
  | {
      kind: "rate_decision";
      source: ResolutionSourceSpec;
      observation_schema: ObservationSchema;
      decision_rule: RateDecisionRule;
      quorum_rule: QuorumRule;
      quarantine_rule: QuarantineRule;
    };

export type ResolutionRegistryEntry = {
  kind: ResolutionKind;
  allowed_domains: string[];
  required_fields: Record<string, ObservationFieldType>;
};

export type ResolutionSpecValidationResult =
  | { ok: true; spec: ResolutionSpec }
  | { ok: false; errors: string[] };

const resolutionRegistry: Record<ResolutionKind, ResolutionRegistryEntry> = {
  price_threshold: {
    kind: "price_threshold",
    allowed_domains: ["cmegroup.com", "coinbase.com", "kraken.com", "localhost", "127.0.0.1"],
    required_fields: {
      price: "number",
    },
  },
  rate_decision: {
    kind: "rate_decision",
    allowed_domains: ["federalreserve.gov", "localhost", "127.0.0.1"],
    required_fields: {
      previous_upper_bound_bps: "number",
      current_upper_bound_bps: "number",
    },
  },
};

function normalizeHost(value: string) {
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

function hostMatchesAllowed(host: string, allowedHost: string) {
  const normalizedAllowed = allowedHost.toLowerCase();
  return host === normalizedAllowed || host.endsWith(`.${normalizedAllowed}`);
}

export function getResolutionRegistryEntry(kind: ResolutionKind) {
  return resolutionRegistry[kind];
}

export function getRequiredObservationFields(kind: ResolutionKind) {
  return resolutionRegistry[kind].required_fields;
}

export function validateObservationPayload(spec: ResolutionSpec, payload: ObservationPayload) {
  const errors: string[] = [];

  for (const [fieldName, fieldSpec] of Object.entries(spec.observation_schema.fields)) {
    const value = payload[fieldName];
    if ((value === undefined || value === null) && fieldSpec.required !== false) {
      errors.push(`missing_observation_field:${fieldName}`);
      continue;
    }
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== fieldSpec.type) {
      errors.push(`invalid_observation_field_type:${fieldName}:${fieldSpec.type}`);
    }
  }

  return errors;
}

export function deriveOutcomeFromResolutionSpec(
  spec: ResolutionSpec,
  payload: ObservationPayload,
): ResolutionOutcome | null {
  const observationErrors = validateObservationPayload(spec, payload);
  if (observationErrors.length > 0) {
    return null;
  }

  if (spec.kind === "price_threshold") {
    const observedPrice = payload[spec.decision_rule.observation_field];
    if (typeof observedPrice !== "number" || !Number.isFinite(observedPrice)) {
      return null;
    }

    switch (spec.decision_rule.operator) {
      case "gt":
        return observedPrice > spec.decision_rule.threshold ? "YES" : "NO";
      case "gte":
        return observedPrice >= spec.decision_rule.threshold ? "YES" : "NO";
      case "lt":
        return observedPrice < spec.decision_rule.threshold ? "YES" : "NO";
      case "lte":
        return observedPrice <= spec.decision_rule.threshold ? "YES" : "NO";
      default:
        return null;
    }
  }

  const previous = payload[spec.decision_rule.previous_field];
  const current = payload[spec.decision_rule.current_field];
  if (typeof previous !== "number" || typeof current !== "number") {
    return null;
  }

  switch (spec.decision_rule.direction) {
    case "cut":
      return current < previous ? "YES" : "NO";
    case "hold":
      return current === previous ? "YES" : "NO";
    case "hike":
      return current > previous ? "YES" : "NO";
    default:
      return null;
  }
}

export function validateResolutionSpec(spec: unknown): ResolutionSpecValidationResult {
  const errors: string[] = [];

  if (!spec || typeof spec !== "object") {
    return { ok: false, errors: ["resolution_spec_must_be_object"] };
  }

  const candidate = spec as Partial<ResolutionSpec>;
  if (!candidate.kind || !(candidate.kind in resolutionRegistry)) {
    errors.push("unsupported_resolution_kind");
  }

  if (!candidate.source || typeof candidate.source !== "object") {
    errors.push("missing_resolution_source");
  } else {
    if (candidate.source.adapter !== "http_json") {
      errors.push("unsupported_resolution_source_adapter");
    }
    if (!candidate.source.canonical_url) {
      errors.push("missing_canonical_url");
    } else {
      try {
        const canonicalHost = normalizeHost(candidate.source.canonical_url);
        const registryEntry = candidate.kind ? resolutionRegistry[candidate.kind] : null;
        if (registryEntry) {
          const registryAllowed = registryEntry.allowed_domains.some((domain) =>
            hostMatchesAllowed(canonicalHost, domain),
          );
          if (!registryAllowed) {
            errors.push("canonical_url_not_allowed_for_resolution_kind");
          }
        }

        if (!candidate.source.allowed_domains || candidate.source.allowed_domains.length === 0) {
          errors.push("missing_allowed_domains");
        } else if (
          !candidate.source.allowed_domains.some((domain) => hostMatchesAllowed(canonicalHost, domain))
        ) {
          errors.push("canonical_url_not_allowed_by_spec");
        }
      } catch {
        errors.push("invalid_canonical_url");
      }
    }
  }

  if (!candidate.observation_schema || candidate.observation_schema.type !== "object") {
    errors.push("invalid_observation_schema");
  } else if (!candidate.observation_schema.fields || typeof candidate.observation_schema.fields !== "object") {
    errors.push("observation_schema_fields_required");
  }

  if (!candidate.decision_rule || typeof candidate.decision_rule !== "object") {
    errors.push("missing_decision_rule");
  }

  if (
    !candidate.quorum_rule ||
    typeof candidate.quorum_rule.min_observations !== "number" ||
    typeof candidate.quorum_rule.min_distinct_collectors !== "number"
  ) {
    errors.push("invalid_quorum_rule");
  }

  if (
    !candidate.quarantine_rule ||
    typeof candidate.quarantine_rule.max_observation_age_seconds !== "number"
  ) {
    errors.push("invalid_quarantine_rule");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const typedSpec = candidate as ResolutionSpec;
  const registryEntry = resolutionRegistry[typedSpec.kind];
  for (const [requiredField, requiredType] of Object.entries(registryEntry.required_fields)) {
    const field = typedSpec.observation_schema.fields[requiredField];
    if (!field) {
      errors.push(`missing_required_observation_field:${requiredField}`);
      continue;
    }
    if (field.type !== requiredType) {
      errors.push(`invalid_required_observation_field_type:${requiredField}:${requiredType}`);
    }
    if (!field.path || typeof field.path !== "string") {
      errors.push(`missing_observation_path:${requiredField}`);
    }
  }

  if (typedSpec.kind !== typedSpec.decision_rule.kind) {
    errors.push("decision_rule_kind_mismatch");
  }

  if (typedSpec.kind === "price_threshold") {
    const field = typedSpec.observation_schema.fields[typedSpec.decision_rule.observation_field];
    if (!field) {
      errors.push("price_threshold_observation_field_missing");
    } else if (field.type !== "number") {
      errors.push("price_threshold_observation_field_must_be_number");
    }
  }

  if (typedSpec.kind === "rate_decision") {
    const previous = typedSpec.observation_schema.fields[typedSpec.decision_rule.previous_field];
    const current = typedSpec.observation_schema.fields[typedSpec.decision_rule.current_field];
    if (!previous || !current) {
      errors.push("rate_decision_fields_missing");
    } else {
      if (previous.type !== "number") {
        errors.push("rate_decision_previous_field_must_be_number");
      }
      if (current.type !== "number") {
        errors.push("rate_decision_current_field_must_be_number");
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, spec: typedSpec };
}

export function extractObservationPayloadFromJson(
  spec: ResolutionSpec,
  payload: unknown,
): ObservationPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const root = payload as Record<string, unknown>;
  const observation: ObservationPayload = {};
  for (const [fieldName, fieldSpec] of Object.entries(spec.observation_schema.fields)) {
    const segments = fieldSpec.path.split(".").filter(Boolean);
    let current: unknown = root;
    for (const segment of segments) {
      if (!current || typeof current !== "object") {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[segment];
    }

    if (current === undefined) {
      observation[fieldName] = null;
      continue;
    }

    observation[fieldName] =
      typeof current === "string" || typeof current === "number" || typeof current === "boolean"
        ? current
        : null;
  }

  return observation;
}
