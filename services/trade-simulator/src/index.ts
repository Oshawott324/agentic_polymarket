import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as signDetached,
  type KeyObject,
} from "node:crypto";
import Fastify from "fastify";

type AgentAuth = {
  id: string;
  token: string;
  privateKey: KeyObject;
};

type MarketSummary = {
  id: string;
  proposal_id: string;
  status: "open" | "closed" | "resolved" | "canceled" | "suspended";
  close_time: string;
  last_traded_price_yes: number | null;
};

type ProposalRecord = {
  id: string;
  status: "queued" | "published" | "suppressed";
  signal_source_id?: string;
  linked_market_id?: string;
};

type SynthesizedBeliefRecord = {
  id: string;
  status: "new" | "ambiguous" | "proposed" | "suppressed";
  confidence_score: number;
  hypothesis: {
    confidence_score: number;
    machine_resolvable: boolean;
  };
};

type TradePlan = {
  market_id: string;
  belief_id: string;
  outcome: "YES" | "NO";
  price: number;
  size: number;
};

const port = Number(process.env.TRADE_SIMULATOR_PORT ?? 4017);
const intervalMs = Number(process.env.TRADE_SIMULATOR_INTERVAL_MS ?? 3000);
const maxMarketsPerTick = Math.max(1, Math.min(10, Number(process.env.TRADE_SIMULATOR_MAX_MARKETS_PER_TICK ?? 3)));
const tradeSize = Math.max(1, Number(process.env.TRADE_SIMULATOR_TRADE_SIZE ?? 8));
const mintSize = Math.max(tradeSize * 4, Number(process.env.TRADE_SIMULATOR_MINT_SIZE ?? 120));

const authRegistryUrl = process.env.AUTH_REGISTRY_URL ?? "http://127.0.0.1:4002";
const marketServiceUrl = process.env.MARKET_SERVICE_URL ?? "http://127.0.0.1:4003";
const portfolioServiceUrl = process.env.PORTFOLIO_SERVICE_URL ?? "http://127.0.0.1:4004";
const agentGatewayUrl = process.env.AGENT_GATEWAY_URL ?? "http://127.0.0.1:4001";
const proposalPipelineUrl = process.env.PROPOSAL_PIPELINE_URL ?? "http://127.0.0.1:4005";
const synthesisAgentUrl = process.env.SYNTHESIS_AGENT_URL ?? "http://127.0.0.1:4015";

const app = Fastify({ logger: true });

let tickInFlight = false;
let buyer: AgentAuth | null = null;
let seller: AgentAuth | null = null;
let lastTickAt: string | null = null;
let lastTickError: string | null = null;
let lastTrade: TradePlan | null = null;
const mintedMarkets = new Set<string>();

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
}

function buildSignedPayload(method: string, pathName: string, agentId: string, timestamp: string, body: unknown) {
  return [method.toUpperCase(), pathName, agentId, timestamp, sha256(stableStringify(body ?? {}))].join("\n");
}

function clamp(value: number, min = 0.05, max = 0.95) {
  return Math.max(min, Math.min(max, value));
}

function roundPrice(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function toNumber(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

async function waitForService(serviceName: string, serviceUrl: string) {
  for (;;) {
    try {
      const response = await fetch(`${serviceUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {}
    app.log.info({ service: serviceName, service_url: serviceUrl }, "waiting_for_service_health");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function createAndAuthenticateAgent(name: string): Promise<AgentAuth> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();

  const registrationResponse = await fetch(`${authRegistryUrl}/v1/agents/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      developer_id: "trade-simulator",
      name,
      runtime_type: "custom",
      public_key: publicKeyPem,
    }),
  });
  if (!registrationResponse.ok) {
    const body = await registrationResponse.text();
    throw new Error(`agent_registration_failed:${registrationResponse.status}:${body}`);
  }
  const registration = (await registrationResponse.json()) as { id: string };

  const challengeResponse = await fetch(`${authRegistryUrl}/v1/agents/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: registration.id,
    }),
  });
  if (!challengeResponse.ok) {
    const body = await challengeResponse.text();
    throw new Error(`agent_challenge_failed:${challengeResponse.status}:${body}`);
  }
  const challenge = (await challengeResponse.json()) as { challenge_id: string; payload: string };

  const challengeSignature = signDetached(
    null,
    Buffer.from(challenge.payload, "utf8"),
    privateKey,
  ).toString("base64");
  const verifyResponse = await fetch(`${authRegistryUrl}/v1/agents/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: registration.id,
      challenge_id: challenge.challenge_id,
      signature: challengeSignature,
    }),
  });
  if (!verifyResponse.ok) {
    const body = await verifyResponse.text();
    throw new Error(`agent_verify_failed:${verifyResponse.status}:${body}`);
  }
  const verified = (await verifyResponse.json()) as { access_token: string };

  return {
    id: registration.id,
    token: verified.access_token,
    privateKey,
  };
}

async function ensureAgents() {
  if (buyer && seller) {
    return;
  }

  buyer = await createAndAuthenticateAgent("belief-trader-consensus");
  seller = await createAndAuthenticateAgent("belief-trader-contrarian");
  app.log.info({ buyer_id: buyer.id, seller_id: seller.id }, "belief_trading_agents_ready");
}

async function fetchOpenMarkets() {
  const response = await fetch(`${marketServiceUrl}/v1/markets`);
  if (!response.ok) {
    throw new Error(`market_list_failed:${response.status}`);
  }

  const payload = (await response.json()) as { items?: MarketSummary[] };
  const items = payload.items ?? [];
  return items.filter((market) => market.status === "open");
}

async function fetchPublishedProposals() {
  const response = await fetch(`${proposalPipelineUrl}/v1/proposals`);
  if (!response.ok) {
    throw new Error(`proposal_list_failed:${response.status}`);
  }

  const payload = (await response.json()) as { items?: ProposalRecord[] };
  return (payload.items ?? []).filter((proposal) => proposal.status === "published");
}

async function fetchSynthesizedBeliefs() {
  const response = await fetch(`${synthesisAgentUrl}/v1/internal/synthesized-beliefs`);
  if (!response.ok) {
    throw new Error(`synthesized_belief_list_failed:${response.status}`);
  }

  const payload = (await response.json()) as { items?: SynthesizedBeliefRecord[] };
  return (payload.items ?? []).filter((belief) => belief.status !== "suppressed");
}

async function mintCompleteSet(agentId: string, marketId: string) {
  const response = await fetch(`${portfolioServiceUrl}/v1/internal/markets/mint-complete-set`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: agentId,
      market_id: marketId,
      size: mintSize,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`mint_complete_set_failed:${response.status}:${body}`);
  }
}

async function ensureMintedForMarket(agentId: string, marketId: string) {
  const mintKey = `${agentId}:${marketId}`;
  if (mintedMarkets.has(mintKey)) {
    return;
  }

  await mintCompleteSet(agentId, marketId);
  mintedMarkets.add(mintKey);
}

function isInsufficientInventoryError(status: number, payload: Record<string, unknown>) {
  return status === 422 && String(payload.error ?? "").includes("insufficient_inventory");
}

async function submitSignedOrder(
  agent: AgentAuth,
  body: {
    market_id: string;
    side: "buy" | "sell";
    outcome: "YES" | "NO";
    price: number;
    size: number;
    client_order_id: string;
  },
) {
  const pathName = "/v1/orders";
  const timestamp = new Date().toISOString();
  const payload = buildSignedPayload("POST", pathName, agent.id, timestamp, body);
  const signature = signDetached(null, Buffer.from(payload, "utf8"), agent.privateKey).toString("base64");

  const response = await fetch(`${agentGatewayUrl}${pathName}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${agent.token}`,
      "content-type": "application/json",
      "x-agent-id": agent.id,
      "x-agent-timestamp": timestamp,
      "x-agent-signature": signature,
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify(body),
  });

  return {
    ok: response.ok,
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

function buildTradePlan(
  market: MarketSummary,
  proposal: ProposalRecord | undefined,
  belief: SynthesizedBeliefRecord | undefined,
): TradePlan | null {
  if (!proposal || !belief || !belief.hypothesis.machine_resolvable) {
    return null;
  }

  const confidenceYes = clamp(toNumber(belief.hypothesis.confidence_score, belief.confidence_score));
  const outcome: "YES" | "NO" = confidenceYes >= 0.5 ? "YES" : "NO";
  const conviction = Math.abs(confidenceYes - 0.5) * 2;
  const marketYes = clamp(market.last_traded_price_yes ?? confidenceYes);
  const fairOutcome = outcome === "YES" ? confidenceYes : 1 - confidenceYes;
  const marketOutcome = outcome === "YES" ? marketYes : 1 - marketYes;
  const price = roundPrice(clamp(fairOutcome * 0.7 + marketOutcome * 0.3));
  const size = Math.max(1, Math.round(tradeSize * (0.6 + conviction * 1.4)));

  return {
    market_id: market.id,
    belief_id: belief.id,
    outcome,
    price,
    size,
  };
}

async function tradeOnePlan(plan: TradePlan) {
  if (!buyer || !seller) {
    return;
  }

  await ensureMintedForMarket(seller.id, plan.market_id);

  const sellOrder = {
    market_id: plan.market_id,
    side: "sell" as const,
    outcome: plan.outcome,
    price: plan.price,
    size: plan.size,
    client_order_id: `belief-sell-${plan.market_id}-${randomUUID().slice(0, 8)}`,
  };
  const buyOrder = {
    market_id: plan.market_id,
    side: "buy" as const,
    outcome: plan.outcome,
    price: plan.price,
    size: plan.size,
    client_order_id: `belief-buy-${plan.market_id}-${randomUUID().slice(0, 8)}`,
  };

  let sellResult = await submitSignedOrder(seller, sellOrder);
  if (isInsufficientInventoryError(sellResult.status, sellResult.body)) {
    await mintCompleteSet(seller.id, plan.market_id);
    sellResult = await submitSignedOrder(seller, sellOrder);
  }
  if (!sellResult.ok && sellResult.status !== 409) {
    throw new Error(`sell_order_failed:${sellResult.status}:${JSON.stringify(sellResult.body)}`);
  }

  const buyResult = await submitSignedOrder(buyer, buyOrder);
  if (!buyResult.ok && buyResult.status !== 409) {
    throw new Error(`buy_order_failed:${buyResult.status}:${JSON.stringify(buyResult.body)}`);
  }

  lastTrade = plan;
}

async function tick() {
  if (tickInFlight) {
    return;
  }

  tickInFlight = true;
  try {
    await ensureAgents();
    const [markets, proposals, beliefs] = await Promise.all([
      fetchOpenMarkets(),
      fetchPublishedProposals(),
      fetchSynthesizedBeliefs(),
    ]);
    const proposalsById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
    const beliefsById = new Map(beliefs.map((belief) => [belief.id, belief]));
    const plans = markets
      .map((market) => {
        const proposal = proposalsById.get(market.proposal_id);
        const beliefId = proposal?.signal_source_id;
        const belief = beliefId ? beliefsById.get(beliefId) : undefined;
        return buildTradePlan(market, proposal, belief);
      })
      .filter((plan): plan is TradePlan => Boolean(plan))
      .slice(0, maxMarketsPerTick);

    for (const plan of plans) {
      await tradeOnePlan(plan);
    }

    lastTickAt = new Date().toISOString();
    lastTickError = null;
  } catch (error) {
    lastTickAt = new Date().toISOString();
    lastTickError = String(error);
    app.log.error({ err: error }, "belief_trader_tick_failed");
  } finally {
    tickInFlight = false;
  }
}

app.get("/health", async () => ({
  service: "trade-simulator",
  status: "ok",
  buyer_agent_id: buyer?.id ?? null,
  seller_agent_id: seller?.id ?? null,
  last_tick_at: lastTickAt,
  last_tick_error: lastTickError,
  last_trade: lastTrade,
}));

async function start() {
  await app.listen({ port, host: "0.0.0.0" });
  await waitForService("auth-registry", authRegistryUrl);
  await waitForService("market-service", marketServiceUrl);
  await waitForService("portfolio-service", portfolioServiceUrl);
  await waitForService("agent-gateway", agentGatewayUrl);
  await waitForService("proposal-pipeline", proposalPipelineUrl);
  await waitForService("synthesis-agent", synthesisAgentUrl);

  void tick();
  setInterval(() => {
    void tick();
  }, intervalMs).unref();
}

void start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
