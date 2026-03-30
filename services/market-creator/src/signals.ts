import type { MarketSignal, ResolutionSpec } from "@automakit/sdk-types";

const enableSyntheticSignals =
  (process.env.MARKET_CREATOR_ENABLE_SYNTHETIC_SIGNALS ?? "false").toLowerCase() !== "false";
const syntheticSignalCount = Math.max(
  1,
  Math.min(6, Number(process.env.MARKET_CREATOR_SYNTHETIC_SIGNAL_COUNT ?? "2")),
);

function buildSyntheticResolutionSpec(threshold: number): ResolutionSpec {
  return {
    kind: "price_threshold",
    source: {
      adapter: "http_json",
      canonical_url: "http://127.0.0.1:4010/v1/internal/world-input/synthetic/btc",
      allowed_domains: ["127.0.0.1", "localhost"],
      method: "GET",
    },
    observation_schema: {
      type: "object",
      fields: {
        price: {
          type: "number",
          path: "price",
          required: true,
        },
      },
    },
    decision_rule: {
      kind: "price_threshold",
      observation_field: "price",
      operator: "gte",
      threshold,
    },
    quorum_rule: {
      min_observations: 2,
      min_distinct_collectors: 2,
      agreement: "majority",
    },
    quarantine_rule: {
      on_source_fetch_failure: true,
      on_schema_validation_failure: true,
      on_observation_conflict: true,
      max_observation_age_seconds: 3600,
    },
  };
}

function buildSyntheticSignals(): MarketSignal[] {
  const now = Date.now();
  const bucket = Math.floor(now / (10 * 60 * 1000));
  const openHoursBase = 6;
  const signals: MarketSignal[] = [];

  for (let index = 0; index < syntheticSignalCount; index += 1) {
    const threshold = 90_000 + ((bucket + index) % 8) * 2_000;
    const closeAt = new Date(now + (openHoursBase + index * 2) * 60 * 60 * 1000).toISOString();
    const closeLabel = new Date(closeAt).toISOString().slice(0, 10);

    signals.push({
      sourceId: `synthetic-btc-${bucket}-${index}`,
      sourceType: "agent",
      category: "crypto",
      headline: `Will BTC be >= $${threshold.toLocaleString("en-US")} by ${closeLabel} UTC?`,
      closeTime: closeAt,
      resolutionCriteria: `Resolve YES if observed BTC/USD price is >= ${threshold} at market close.`,
      resolutionSpec: buildSyntheticResolutionSpec(threshold),
    });
  }

  return signals;
}

export async function loadSignals(): Promise<MarketSignal[]> {
  const feedUrls = (process.env.MARKET_CREATOR_SIGNAL_FEED_URLS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (feedUrls.length === 0) {
    return enableSyntheticSignals ? buildSyntheticSignals() : [];
  }

  const signals = await Promise.all(
    feedUrls.map(async (feedUrl) => {
      const response = await fetch(feedUrl, {
        headers: {
          accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`signal feed request failed for ${feedUrl} with ${response.status}`);
      }

      const payload = (await response.json()) as { items?: MarketSignal[] };
      return payload.items ?? [];
    }),
  );

  return signals.flat();
}
