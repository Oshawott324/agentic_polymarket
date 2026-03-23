import Fastify from "fastify";
import {
  createDatabasePool,
  ensureCoreSchema,
  parseJsonField,
  toIsoTimestamp,
  toNumberOrNull,
} from "@automakit/persistence";
import { WebSocketServer } from "ws";

type AgentContext = {
  id: string;
  public_key: string;
  status: "pending_verification" | "active" | "suspended" | "disabled";
};

type IntrospectionResponse = {
  active: boolean;
  agent?: AgentContext;
  expires_at?: string;
};

type Outcome = "YES" | "NO";
type OrderStatus = "open" | "partially_filled" | "filled" | "canceled";

type Channel =
  | "market.snapshot"
  | "orderbook.delta"
  | "trade.fill"
  | "order.update"
  | "portfolio.update"
  | "resolution.update";

type SubscriptionMessage = {
  type: "subscribe";
  channels: Channel[];
  market_id?: string;
  from_sequence?: number;
  snapshot?: boolean;
};

type StreamEventRow = {
  sequence_id: string | number;
  channel: Channel;
  market_id: string | null;
  agent_id: string | null;
  payload: unknown;
  created_at: unknown;
};

type MarketRow = {
  id: string;
  proposal_id: string;
  event_id: string;
  title: string;
  subtitle: string | null;
  status: "open" | "closed" | "resolved" | "canceled" | "suspended";
  category: string;
  close_time: unknown;
  resolution_spec: unknown;
  resolution_source: string;
  resolution_kind: string;
  resolution_metadata: unknown;
  last_traded_price_yes: unknown;
  volume_24h: unknown;
  liquidity_score: unknown;
  outcomes: unknown;
  rules: string;
};

type OrderbookRow = {
  market_id: string;
  outcome: Outcome;
  side: "buy" | "sell";
  price: unknown;
  remaining_size: unknown;
};

type OrderRow = {
  id: string;
  agent_id: string;
  market_id: string;
  client_order_id: string;
  side: "buy" | "sell";
  outcome: Outcome;
  price: unknown;
  size: unknown;
  filled_size: unknown;
  status: OrderStatus;
  signed_at: unknown;
  request_signature: string;
  created_at: unknown;
  updated_at: unknown;
  canceled_at: unknown;
};

type FillRow = {
  id: string;
  market_id: string;
  outcome: Outcome;
  price: unknown;
  size: unknown;
  buy_order_id: string;
  sell_order_id: string;
  buy_agent_id: string;
  sell_agent_id: string;
  executed_at: unknown;
};

type ResolutionCaseRow = {
  market_id: string;
  status: string;
  draft_outcome: string | null;
  final_outcome: string | null;
  canonical_source_url: string | null;
  quorum_threshold: number;
  last_updated_at: unknown;
};

type WsLike = {
  send: (value: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
};

const port = Number(process.env.STREAM_SERVICE_PORT ?? 4007);
const authRegistryUrl = process.env.AUTH_REGISTRY_URL ?? "http://localhost:4002";
const app = Fastify({ logger: true });
const pool = createDatabasePool();

function mapMarketRow(row: MarketRow) {
  return {
    id: row.id,
    proposal_id: row.proposal_id,
    event_id: row.event_id,
    title: row.title,
    subtitle: row.subtitle,
    status: row.status,
    category: row.category,
    close_time: toIsoTimestamp(row.close_time),
    resolution_spec: parseJsonField(row.resolution_spec),
    resolution_source: row.resolution_source,
    resolution_kind: row.resolution_kind,
    resolution_metadata: parseJsonField(row.resolution_metadata),
    last_traded_price_yes: toNumberOrNull(row.last_traded_price_yes),
    volume_24h: Number(row.volume_24h),
    liquidity_score: Number(row.liquidity_score),
    outcomes: parseJsonField(row.outcomes),
    rules: row.rules,
  };
}

function mapOrderRow(row: OrderRow) {
  return {
    id: row.id,
    agent_id: row.agent_id,
    market_id: row.market_id,
    client_order_id: row.client_order_id,
    side: row.side,
    outcome: row.outcome,
    price: Number(row.price),
    size: Number(row.size),
    filled_size: Number(row.filled_size),
    status: row.status,
    signed_at: toIsoTimestamp(row.signed_at),
    request_signature: row.request_signature,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
    canceled_at: row.canceled_at ? toIsoTimestamp(row.canceled_at) : null,
  };
}

function mapFillRow(row: FillRow) {
  return {
    id: row.id,
    market_id: row.market_id,
    outcome: row.outcome,
    price: Number(row.price),
    size: Number(row.size),
    buy_order_id: row.buy_order_id,
    sell_order_id: row.sell_order_id,
    buy_agent_id: row.buy_agent_id,
    sell_agent_id: row.sell_agent_id,
    executed_at: toIsoTimestamp(row.executed_at),
  };
}

async function introspectToken(token: string): Promise<IntrospectionResponse> {
  const response = await fetch(`${authRegistryUrl}/v1/internal/tokens/introspect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });

  if (!response.ok) {
    return { active: false };
  }

  return (await response.json()) as IntrospectionResponse;
}

async function getCurrentSequence() {
  const result = await pool.query<{ max_sequence: string | null }>(
    `
      SELECT COALESCE(MAX(sequence_id), 0)::text AS max_sequence
      FROM stream_events
    `,
  );
  return Number(result.rows[0]?.max_sequence ?? 0);
}

async function getMarketSnapshots(marketId?: string) {
  const result = await pool.query<MarketRow>(
    `
      SELECT *
      FROM markets
      WHERE ($1::text IS NULL OR id = $1)
      ORDER BY close_time ASC, id ASC
    `,
    [marketId ?? null],
  );
  return result.rows.map(mapMarketRow);
}

async function getOrderbookSnapshots(marketId?: string) {
  const result = await pool.query<OrderbookRow>(
    `
      SELECT
        market_id,
        outcome,
        side,
        price,
        SUM(GREATEST(size - filled_size, 0)) AS remaining_size
      FROM orders
      WHERE status IN ('open', 'partially_filled')
        AND ($1::text IS NULL OR market_id = $1)
      GROUP BY market_id, outcome, side, price
      ORDER BY market_id ASC
    `,
    [marketId ?? null],
  );

  const snapshots = new Map<
    string,
    {
      market_id: string;
      yes_bids: Array<{ price: number; size: number }>;
      yes_asks: Array<{ price: number; size: number }>;
      no_bids: Array<{ price: number; size: number }>;
      no_asks: Array<{ price: number; size: number }>;
    }
  >();

  for (const row of result.rows) {
    const snapshot =
      snapshots.get(row.market_id) ??
      {
        market_id: row.market_id,
        yes_bids: [],
        yes_asks: [],
        no_bids: [],
        no_asks: [],
      };

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

    snapshots.set(row.market_id, snapshot);
  }

  return [...snapshots.values()].map((snapshot) => {
    snapshot.yes_bids.sort((left, right) => right.price - left.price || right.size - left.size);
    snapshot.yes_asks.sort((left, right) => left.price - right.price || right.size - left.size);
    snapshot.no_bids.sort((left, right) => right.price - left.price || right.size - left.size);
    snapshot.no_asks.sort((left, right) => left.price - right.price || right.size - left.size);
    return snapshot;
  });
}

async function getOrderSnapshots(agentId: string, marketId?: string) {
  const result = await pool.query<OrderRow>(
    `
      SELECT *
      FROM orders
      WHERE agent_id = $1
        AND ($2::text IS NULL OR market_id = $2)
      ORDER BY updated_at DESC, id DESC
      LIMIT 100
    `,
    [agentId, marketId ?? null],
  );
  return result.rows.map(mapOrderRow);
}

async function getFillSnapshots(marketId?: string) {
  const result = await pool.query<FillRow>(
    `
      SELECT *
      FROM fills
      WHERE ($1::text IS NULL OR market_id = $1)
      ORDER BY executed_at DESC, id DESC
      LIMIT 100
    `,
    [marketId ?? null],
  );
  return result.rows.map(mapFillRow);
}

async function getPortfolioSnapshot(agentId: string) {
  const [accountResult, positionsResult] = await Promise.all([
    pool.query<{
      cash_balance: unknown;
      reserved_cash: unknown;
      realized_pnl: unknown;
      fees: unknown;
      payouts: unknown;
    }>(
      `
        SELECT cash_balance, reserved_cash, realized_pnl, fees, payouts
        FROM portfolio_accounts
        WHERE agent_id = $1
      `,
      [agentId],
    ),
    pool.query<{
      market_id: string;
      outcome: Outcome;
      quantity: unknown;
      reserved_quantity: unknown;
      cost_basis_notional: unknown;
      mark_price_yes: unknown;
      final_outcome: unknown;
    }>(
      `
        SELECT
          p.market_id,
          p.outcome,
          p.quantity,
          p.reserved_quantity,
          p.cost_basis_notional,
          m.last_traded_price_yes AS mark_price_yes,
          rc.final_outcome
        FROM portfolio_positions p
        JOIN markets m ON m.id = p.market_id
        LEFT JOIN resolution_cases rc ON rc.market_id = p.market_id
        WHERE p.agent_id = $1
          AND p.quantity > 0
      `,
      [agentId],
    ),
  ]);

  const account = accountResult.rows[0];
  let unrealizedPnl = 0;
  const positions = positionsResult.rows.map((row) => {
    const quantity = Number(row.quantity);
    const averagePrice = quantity > 0 ? Number(row.cost_basis_notional) / quantity : 0;
    let markPriceYes = Number(row.mark_price_yes ?? 0);
    if (row.final_outcome === "YES") {
      markPriceYes = 1;
    } else if (row.final_outcome === "NO") {
      markPriceYes = 0;
    }
    const markPrice = row.outcome === "YES" ? markPriceYes : 1 - markPriceYes;
    const unrealized = quantity * (markPrice - averagePrice);
    unrealizedPnl += unrealized;
    return {
      market_id: row.market_id,
      outcome: row.outcome,
      quantity,
      reserved_quantity: Number(row.reserved_quantity),
      average_price: averagePrice,
      mark_price: markPrice,
      unrealized_pnl: unrealized,
    };
  });

  return {
    agent_id: agentId,
    cash_balance: Number(account?.cash_balance ?? 0),
    reserved_balance: Number(account?.reserved_cash ?? 0),
    realized_pnl: Number(account?.realized_pnl ?? 0),
    unrealized_pnl: unrealizedPnl,
    fees: Number(account?.fees ?? 0),
    payouts: Number(account?.payouts ?? 0),
    positions,
  };
}

async function getResolutionSnapshots(marketId?: string) {
  const result = await pool.query<ResolutionCaseRow>(
    `
      SELECT *
      FROM resolution_cases
      WHERE ($1::text IS NULL OR market_id = $1)
      ORDER BY last_updated_at DESC, market_id ASC
    `,
    [marketId ?? null],
  );

  return result.rows.map((row) => ({
    market_id: row.market_id,
    status: row.status,
    draft_outcome: row.draft_outcome,
    final_outcome: row.final_outcome,
    canonical_source_url: row.canonical_source_url,
    quorum_threshold: Number(row.quorum_threshold),
    last_updated_at: toIsoTimestamp(row.last_updated_at),
  }));
}

function sendJson(socket: { send: (value: string) => void }, payload: unknown) {
  socket.send(JSON.stringify(payload));
}

function shouldDeliverEvent(
  event: StreamEventRow,
  agentId: string,
  subscription: { channels: Set<Channel>; market_id?: string },
) {
  if (!subscription.channels.has(event.channel)) {
    return false;
  }
  if (subscription.market_id && event.market_id && event.market_id !== subscription.market_id) {
    return false;
  }
  if (event.agent_id && event.agent_id !== agentId) {
    return false;
  }
  return true;
}

app.get("/health", async () => ({ service: "stream-service", status: "ok" }));

async function handleStreamSocket(socket: WsLike, request: { headers: Record<string, string | string[] | undefined> }) {
  const rawAuthorization = request.headers.authorization;
  const authorization =
    typeof rawAuthorization === "string"
      ? rawAuthorization
      : Array.isArray(rawAuthorization)
        ? rawAuthorization[0]
        : undefined;
  if (!authorization?.startsWith("Bearer ")) {
    socket.close(4401, "missing_or_invalid_authorization");
    return;
  }

  const token = authorization.slice("Bearer ".length).trim();
  const introspection = await introspectToken(token);
  if (!introspection.active || !introspection.agent) {
    socket.close(4401, "inactive_or_unknown_token");
    return;
  }
  const agent = introspection.agent;

  let pollHandle: NodeJS.Timeout | null = null;
  let lastSequence = 0;
  let subscription: { channels: Set<Channel>; market_id?: string } | null = null;

  socket.on("message", async (raw) => {
    const payload = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    const message = JSON.parse(payload) as SubscriptionMessage;
    if (message.type !== "subscribe" || !Array.isArray(message.channels) || message.channels.length === 0) {
      sendJson(socket, { type: "error", error: "invalid_subscribe_request" });
      return;
    }

    const channels = new Set(message.channels);
    const baselineSequence = await getCurrentSequence();
    const useSnapshot = message.snapshot !== false;
    lastSequence = useSnapshot ? baselineSequence : Math.max(message.from_sequence ?? 0, 0);
    subscription = {
      channels,
      market_id: message.market_id,
    };

    if (useSnapshot && channels.has("market.snapshot")) {
      sendJson(socket, {
        type: "snapshot",
        channel: "market.snapshot",
        sequence_id: baselineSequence,
        payload: await getMarketSnapshots(message.market_id),
      });
    }

    if (useSnapshot && channels.has("orderbook.delta")) {
      sendJson(socket, {
        type: "snapshot",
        channel: "orderbook.delta",
        sequence_id: baselineSequence,
        payload: await getOrderbookSnapshots(message.market_id),
      });
    }

    if (useSnapshot && channels.has("trade.fill")) {
      sendJson(socket, {
        type: "snapshot",
        channel: "trade.fill",
        sequence_id: baselineSequence,
        payload: await getFillSnapshots(message.market_id),
      });
    }

    if (useSnapshot && channels.has("order.update")) {
      sendJson(socket, {
        type: "snapshot",
        channel: "order.update",
        sequence_id: baselineSequence,
        payload: await getOrderSnapshots(agent.id, message.market_id),
      });
    }

    if (useSnapshot && channels.has("portfolio.update")) {
      sendJson(socket, {
        type: "snapshot",
        channel: "portfolio.update",
        sequence_id: baselineSequence,
        payload: await getPortfolioSnapshot(agent.id),
      });
    }

    if (useSnapshot && channels.has("resolution.update")) {
      sendJson(socket, {
        type: "snapshot",
        channel: "resolution.update",
        sequence_id: baselineSequence,
        payload: await getResolutionSnapshots(message.market_id),
      });
    }

    if (pollHandle) {
      clearInterval(pollHandle);
    }

    pollHandle = setInterval(async () => {
      if (!subscription) {
        return;
      }

      const result = await pool.query<StreamEventRow>(
        `
          SELECT sequence_id, channel, market_id, agent_id, payload, created_at
          FROM stream_events
          WHERE sequence_id > $1
          ORDER BY sequence_id ASC
          LIMIT 256
        `,
        [lastSequence],
      );

      for (const row of result.rows) {
        const sequenceId = Number(row.sequence_id);
        if (!Number.isFinite(sequenceId)) {
          continue;
        }
        lastSequence = Math.max(lastSequence, sequenceId);
        if (!shouldDeliverEvent(row, agent.id, subscription)) {
          continue;
        }

        sendJson(socket, {
          type: "event",
          sequence_id: sequenceId,
          channel: row.channel,
          market_id: row.market_id,
          agent_id: row.agent_id,
          created_at: toIsoTimestamp(row.created_at),
          payload: parseJsonField(row.payload),
        });
      }
    }, 250);
  });

  socket.on("close", () => {
    if (pollHandle) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  });
}

app.get("/v1/stream/ws", async (_request, reply) => {
  reply.code(426);
  return { error: "websocket_upgrade_required" };
});

async function start() {
  await ensureCoreSchema(pool);
  const wsServer = new WebSocketServer({ noServer: true });
  app.server.on("upgrade", (request, socket, head) => {
    const url = request.url ? new URL(request.url, `http://${request.headers.host ?? "localhost"}`) : null;
    if (!url || url.pathname !== "/v1/stream/ws") {
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (websocket) => {
      void handleStreamSocket(websocket as unknown as WsLike, {
        headers: request.headers as Record<string, string | string[] | undefined>,
      });
    });
  });

  await app.listen({ port, host: "0.0.0.0" });
}

void start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
