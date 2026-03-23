import Fastify from "fastify";
import {
  createDatabasePool,
  ensureCoreSchema,
  parseJsonField,
  toIsoTimestamp,
  toNumberOrNull,
} from "@automakit/persistence";
import { type ResolutionKind, type ResolutionSpec, validateResolutionSpec } from "@automakit/sdk-types";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

type MarketRecord = {
  id: string;
  proposal_id: string;
  event_id: string;
  title: string;
  subtitle: string | null;
  status: "open" | "closed" | "resolved" | "canceled" | "suspended";
  category: string;
  close_time: string;
  resolution_spec: ResolutionSpec;
  resolution_source: string;
  resolution_kind: ResolutionKind;
  resolution_metadata: ResolutionSpec["decision_rule"];
  last_traded_price_yes: number | null;
  volume_24h: number;
  liquidity_score: number;
  outcomes: ["YES", "NO"];
  rules: string;
};

type MarketRow = {
  id: string;
  proposal_id: string;
  event_id: string;
  title: string;
  subtitle: string | null;
  status: MarketRecord["status"];
  category: string;
  close_time: unknown;
  resolution_spec: unknown;
  resolution_source: string;
  resolution_kind: ResolutionKind;
  resolution_metadata: unknown;
  last_traded_price_yes: unknown;
  volume_24h: unknown;
  liquidity_score: unknown;
  outcomes: unknown;
  rules: string;
};

type ResolutionCandidateRow = {
  id: string;
  title: string;
  status: MarketRecord["status"];
  category: string;
  close_time: unknown;
  resolution_spec: unknown;
  resolution_case_status: string | null;
  evidence_count: unknown;
  distinct_collector_count: unknown;
};

const port = Number(process.env.MARKET_SERVICE_PORT ?? 4003);
const app = Fastify({ logger: true });
const pool = createDatabasePool();
type Queryable = Pick<PoolClient, "query">;

type OrderbookLevel = {
  price: number;
  size: number;
};

type OrderbookSnapshot = {
  market_id: string;
  yes_bids: OrderbookLevel[];
  yes_asks: OrderbookLevel[];
  no_bids: OrderbookLevel[];
  no_asks: OrderbookLevel[];
};

type OrderbookRow = {
  outcome: "YES" | "NO";
  side: "buy" | "sell";
  price: unknown;
  remaining_size: unknown;
};

function mapMarketRow(row: MarketRow): MarketRecord {
  return {
    id: row.id,
    proposal_id: row.proposal_id,
    event_id: row.event_id,
    title: row.title,
    subtitle: row.subtitle,
    status: row.status,
    category: row.category,
    close_time: toIsoTimestamp(row.close_time),
    resolution_spec: parseJsonField<ResolutionSpec>(row.resolution_spec),
    resolution_source: row.resolution_source,
    resolution_kind: row.resolution_kind,
    resolution_metadata: parseJsonField<ResolutionSpec["decision_rule"]>(row.resolution_metadata),
    last_traded_price_yes: toNumberOrNull(row.last_traded_price_yes),
    volume_24h: Number(row.volume_24h),
    liquidity_score: Number(row.liquidity_score),
    outcomes: parseJsonField<["YES", "NO"]>(row.outcomes),
    rules: row.rules,
  };
}

async function getOrderbookSnapshot(client: Queryable, marketId: string): Promise<OrderbookSnapshot> {
  const result = await client.query<OrderbookRow>(
    `
      SELECT
        outcome,
        side,
        price,
        SUM(GREATEST(size - filled_size, 0)) AS remaining_size
      FROM orders
      WHERE market_id = $1
        AND status IN ('open', 'partially_filled')
      GROUP BY outcome, side, price
    `,
    [marketId],
  );

  const snapshot: OrderbookSnapshot = {
    market_id: marketId,
    yes_bids: [],
    yes_asks: [],
    no_bids: [],
    no_asks: [],
  };

  for (const row of result.rows) {
    const level = {
      price: Number(row.price),
      size: Number(row.remaining_size),
    };

    if (row.outcome === "YES" && row.side === "buy") {
      snapshot.yes_bids.push(level);
    } else if (row.outcome === "YES" && row.side === "sell") {
      snapshot.yes_asks.push(level);
    } else if (row.outcome === "NO" && row.side === "buy") {
      snapshot.no_bids.push(level);
    } else if (row.outcome === "NO" && row.side === "sell") {
      snapshot.no_asks.push(level);
    }
  }

  snapshot.yes_bids.sort((left, right) => right.price - left.price || right.size - left.size);
  snapshot.yes_asks.sort((left, right) => left.price - right.price || right.size - left.size);
  snapshot.no_bids.sort((left, right) => right.price - left.price || right.size - left.size);
  snapshot.no_asks.sort((left, right) => left.price - right.price || right.size - left.size);

  return snapshot;
}

async function appendStreamEvent(
  client: Queryable,
  event: {
    channel: string;
    market_id?: string | null;
    agent_id?: string | null;
    payload: unknown;
    created_at?: string;
  },
) {
  await client.query(
    `
      INSERT INTO stream_events (
        event_id,
        channel,
        market_id,
        agent_id,
        payload,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
    `,
    [
      randomUUID(),
      event.channel,
      event.market_id ?? null,
      event.agent_id ?? null,
      JSON.stringify(event.payload),
      event.created_at ?? new Date().toISOString(),
    ],
  );
}

app.get("/health", async () => ({ service: "market-service", status: "ok" }));

app.get("/v1/markets", async () => {
  const result = await pool.query<MarketRow>(
    `
      SELECT
        id,
        proposal_id,
        event_id,
        title,
        subtitle,
        status,
        category,
        close_time,
        resolution_spec,
        resolution_source,
        resolution_kind,
        resolution_metadata,
        last_traded_price_yes,
        volume_24h,
        liquidity_score,
        outcomes,
        rules
      FROM markets
      ORDER BY close_time ASC, id ASC
    `,
  );

  return {
    items: result.rows.map(({ rules, ...market }) => mapMarketRow({ ...market, rules })),
    next_cursor: null,
  };
});

app.get("/v1/internal/markets/resolution-candidates", async (request) => {
  const limit = Math.max(
    1,
    Math.min(100, Number((request.query as { limit?: string }).limit ?? "20") || 20),
  );

  const result = await pool.query<ResolutionCandidateRow>(
    `
      SELECT
        markets.id,
        markets.title,
        markets.status,
        markets.category,
        markets.close_time,
        markets.resolution_spec,
        resolution_cases.status AS resolution_case_status,
        COUNT(resolution_evidence.id) AS evidence_count,
        COUNT(DISTINCT resolution_evidence.submitter_agent_id) AS distinct_collector_count
      FROM markets
      LEFT JOIN resolution_cases ON resolution_cases.market_id = markets.id
      LEFT JOIN resolution_evidence ON resolution_evidence.market_id = markets.id
      WHERE markets.close_time <= NOW()
        AND markets.status IN ('open', 'closed')
      GROUP BY
        markets.id,
        markets.title,
        markets.status,
        markets.category,
        markets.close_time,
        markets.resolution_spec,
        resolution_cases.status
      ORDER BY markets.close_time ASC, markets.id ASC
      LIMIT $1
    `,
    [limit * 4],
  );

  const items = result.rows.flatMap((row) => {
    const validation = validateResolutionSpec(parseJsonField<ResolutionSpec>(row.resolution_spec));
    const evidenceCount = Number(row.evidence_count);
    const distinctCollectorCount = Number(row.distinct_collector_count);

    if (!validation.ok) {
      return [];
    }

    if (row.resolution_case_status === "finalized" || row.resolution_case_status === "quarantined") {
      return [];
    }

    return [
      {
        market_id: row.id,
        title: row.title,
        status: row.status,
        category: row.category,
        close_time: toIsoTimestamp(row.close_time),
        resolution_spec: validation.spec,
        evidence_count: evidenceCount,
        distinct_collector_count: distinctCollectorCount,
      },
    ];
  }).filter((candidate) => {
    const needsObservation =
      candidate.evidence_count < candidate.resolution_spec.quorum_rule.min_observations ||
      candidate.distinct_collector_count < candidate.resolution_spec.quorum_rule.min_distinct_collectors;

    return needsObservation;
  }).slice(0, limit);

  return { items };
});

app.post("/v1/internal/markets", async (request, reply) => {
  const body = request.body as {
    proposal_id?: string;
    title?: string;
    category?: string;
    close_time?: string;
    resolution_criteria?: string;
    resolution_spec?: ResolutionSpec;
  };

  if (
    !body.proposal_id ||
    !body.title ||
    !body.close_time ||
    !body.resolution_criteria ||
    !body.resolution_spec
  ) {
    reply.code(400);
    return { error: "invalid_market_creation_request" };
  }

  const existing = await pool.query<MarketRow>(
    `
      SELECT
        id,
        proposal_id,
        event_id,
        title,
        subtitle,
        status,
        category,
        close_time,
        resolution_spec,
        resolution_source,
        resolution_kind,
        resolution_metadata,
        last_traded_price_yes,
        volume_24h,
        liquidity_score,
        outcomes,
        rules
      FROM markets
      WHERE proposal_id = $1
    `,
    [body.proposal_id],
  );

  if (existing.rowCount) {
    return mapMarketRow(existing.rows[0]);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const inserted = await client.query<MarketRow>(
      `
        INSERT INTO markets (
          id,
          proposal_id,
          event_id,
          title,
          subtitle,
          status,
          category,
          close_time,
          resolution_spec,
          resolution_source,
          resolution_kind,
          resolution_metadata,
          last_traded_price_yes,
          volume_24h,
          liquidity_score,
          outcomes,
          rules
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb, $10, $11, $12::jsonb, $13, $14, $15, $16::jsonb, $17
        )
        RETURNING
          id,
          proposal_id,
          event_id,
          title,
          subtitle,
          status,
          category,
          close_time,
          resolution_spec,
          resolution_source,
          resolution_kind,
          resolution_metadata,
          last_traded_price_yes,
          volume_24h,
          liquidity_score,
          outcomes,
          rules
      `,
      [
        body.proposal_id,
        body.proposal_id,
        `evt-${body.proposal_id}`,
        body.title,
        null,
        "open",
        body.category ?? "uncategorized",
        body.close_time,
        JSON.stringify(body.resolution_spec),
        body.resolution_spec.source.canonical_url,
        body.resolution_spec.kind,
        JSON.stringify(body.resolution_spec.decision_rule),
        null,
        0,
        0,
        JSON.stringify(["YES", "NO"]),
        body.resolution_criteria,
      ],
    );

    const market = mapMarketRow(inserted.rows[0]);
    await appendStreamEvent(client, {
      channel: "market.snapshot",
      market_id: market.id,
      payload: market,
    });
    await appendStreamEvent(client, {
      channel: "orderbook.delta",
      market_id: market.id,
      payload: await getOrderbookSnapshot(client, market.id),
    });

    await client.query("COMMIT");
    reply.code(201);
    return market;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.get("/v1/markets/:marketId", async (request, reply) => {
  const marketId = (request.params as { marketId: string }).marketId;
  const result = await pool.query<MarketRow>(
    `
      SELECT
        id,
        proposal_id,
        event_id,
        title,
        subtitle,
        status,
        category,
        close_time,
        resolution_spec,
        resolution_source,
        resolution_kind,
        resolution_metadata,
        last_traded_price_yes,
        volume_24h,
        liquidity_score,
        outcomes,
        rules
      FROM markets
      WHERE id = $1
    `,
    [marketId],
  );

  if (!result.rowCount) {
    reply.code(404);
    return { error: "market_not_found" };
  }

  const market = mapMarketRow(result.rows[0]);

  return {
    ...market,
    source_of_truth_label: "Official source",
    event: {
      id: market.event_id,
      title: market.title,
      category: market.category,
      slug: market.id,
    },
    orderbook: await getOrderbookSnapshot(pool, market.id),
  };
});

app.post("/v1/internal/markets/:marketId/status", async (request, reply) => {
  const marketId = (request.params as { marketId: string }).marketId;
  const body = request.body as {
    status?: MarketRecord["status"];
  };

  if (!body.status) {
    reply.code(400);
    return { error: "missing_market_status" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<MarketRow>(
      `
        UPDATE markets
        SET status = $2
        WHERE id = $1
        RETURNING
          id,
          proposal_id,
          event_id,
          title,
          subtitle,
          status,
          category,
          close_time,
          resolution_spec,
          resolution_source,
          resolution_kind,
          resolution_metadata,
          last_traded_price_yes,
          volume_24h,
          liquidity_score,
          outcomes,
          rules
      `,
      [marketId, body.status],
    );

    if (!result.rowCount) {
      await client.query("ROLLBACK");
      reply.code(404);
      return { error: "market_not_found" };
    }

    const market = mapMarketRow(result.rows[0]);
    await appendStreamEvent(client, {
      channel: "market.snapshot",
      market_id: market.id,
      payload: market,
    });
    await client.query("COMMIT");
    return market;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

async function start() {
  await ensureCoreSchema(pool);
  await app.listen({ port, host: "0.0.0.0" });
}

void start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
