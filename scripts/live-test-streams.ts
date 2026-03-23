import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign as signDetached, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import WebSocket from "ws";

type ManagedProcess = {
  name: string;
  child: ReturnType<typeof spawn>;
};

type AuthenticatedAgent = {
  id: string;
  token: string;
  privateKey: KeyObject;
};

type StreamMessage = {
  type: "snapshot" | "event" | "error";
  channel?: string;
  sequence_id?: number;
  payload?: unknown;
  error?: string;
};

function startProcess(
  name: string,
  command: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  cwd = process.cwd(),
): ManagedProcess {
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));

  return { name, child };
}

async function stopProcess(process: ManagedProcess) {
  await new Promise<void>((resolve) => {
    if (process.child.exitCode !== null) {
      resolve();
      return;
    }
    process.child.once("exit", () => resolve());
    process.child.kill("SIGTERM");
    setTimeout(() => {
      if (process.child.exitCode === null) {
        process.child.kill("SIGKILL");
      }
    }, 1000);
  });
}

async function reservePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to reserve an ephemeral port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on("error", reject);
  });
}

async function waitForJson(url: string, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response.json();
      }
    } catch {}
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForDatabase(databaseUrl: string, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query("SELECT 1");
      await pool.end();
      return;
    } catch {
      await pool.end().catch(() => undefined);
      await delay(1000);
    }
  }
  throw new Error(`Timed out waiting for Postgres at ${databaseUrl}`);
}

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

function buildSignedHeaders(
  agent: AuthenticatedAgent,
  method: string,
  pathName: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) {
  const timestamp = new Date().toISOString();
  const payload = buildSignedPayload(method, pathName, agent.id, timestamp, body);
  const signature = signDetached(null, Buffer.from(payload, "utf8"), agent.privateKey).toString("base64");

  return {
    authorization: `Bearer ${agent.token}`,
    "content-type": "application/json",
    "x-agent-id": agent.id,
    "x-agent-timestamp": timestamp,
    "x-agent-signature": signature,
    ...extraHeaders,
  };
}

async function createAndAuthenticateAgent(name: string): Promise<AuthenticatedAgent> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();

  const registrationResponse = await fetch("http://127.0.0.1:4002/v1/agents/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      developer_id: `dev_${name}`,
      name,
      runtime_type: "custom",
      public_key: publicKeyPem,
    }),
  });
  if (!registrationResponse.ok) {
    throw new Error(`Agent registration failed with ${registrationResponse.status}`);
  }
  const agent = (await registrationResponse.json()) as { id: string };

  const challengeResponse = await fetch("http://127.0.0.1:4002/v1/agents/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_id: agent.id }),
  });
  if (!challengeResponse.ok) {
    throw new Error(`Challenge creation failed with ${challengeResponse.status}`);
  }
  const challenge = (await challengeResponse.json()) as { challenge_id: string; payload: string };

  const challengeSignature = signDetached(null, Buffer.from(challenge.payload, "utf8"), privateKey).toString("base64");
  const verifyResponse = await fetch("http://127.0.0.1:4002/v1/agents/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: agent.id,
      challenge_id: challenge.challenge_id,
      signature: challengeSignature,
    }),
  });
  if (!verifyResponse.ok) {
    throw new Error(`Challenge verification failed with ${verifyResponse.status}`);
  }
  const auth = (await verifyResponse.json()) as { access_token: string };

  return {
    id: agent.id,
    token: auth.access_token,
    privateKey,
  };
}

async function openStreamSocket(token: string) {
  const socket = new WebSocket("ws://127.0.0.1:4007/v1/stream/ws", {
    headers: {
      authorization: `Bearer ${token}`,
    },
  });

  const received: StreamMessage[] = [];
  socket.on("message", (chunk) => {
    received.push(JSON.parse(chunk.toString()) as StreamMessage);
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (error) => reject(error));
  });

  return { socket, received };
}

async function waitForCondition(predicate: () => boolean, description: string, timeoutMs = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function main() {
  const databasePort = await reservePort();
  const matchingEnginePort = await reservePort();
  const sourcePort = await reservePort();
  const collectorAlphaPort = await reservePort();
  const collectorBetaPort = await reservePort();
  const databaseDirectory = await mkdtemp(path.join(os.tmpdir(), "automakit-streams-"));
  const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${databasePort}/postgres`;
  const repoRoot = process.cwd();
  const pgliteServerBin = path.join(repoRoot, "node_modules", ".bin", "pglite-server");

  const processes: ManagedProcess[] = [];
  let streamSocket: WebSocket | null = null;
  let replaySocket: WebSocket | null = null;
  const sourceServer = http.createServer((request, response) => {
    if (request.url === "/sources/btc") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          price: 121000,
          observed_at: new Date().toISOString(),
        }),
      );
      return;
    }

    response.writeHead(404);
    response.end();
  });
  try {
    await new Promise<void>((resolve) => {
      sourceServer.listen(sourcePort, "127.0.0.1", () => resolve());
    });
    processes.push(
      startProcess(
        "database",
        pgliteServerBin,
        ["--db", databaseDirectory, "--host", "127.0.0.1", "--port", String(databasePort), "--max-connections", "16"],
      ),
    );
    await waitForDatabase(databaseUrl);

    processes.push(
      startProcess(
        "matching-engine",
        "cargo",
        ["run", "--manifest-path", "services/matching-engine/Cargo.toml"],
        {
          MATCHING_ENGINE_PORT: String(matchingEnginePort),
          DATABASE_URL: databaseUrl,
        },
        repoRoot,
      ),
    );
    processes.push(
      startProcess(
        "portfolio-service",
        process.execPath,
        ["dist/index.js"],
        { DATABASE_URL: databaseUrl },
        path.join(repoRoot, "services", "portfolio-service"),
      ),
    );
    processes.push(
      startProcess(
        "market-service",
        process.execPath,
        ["dist/index.js"],
        { DATABASE_URL: databaseUrl },
        path.join(repoRoot, "services", "market-service"),
      ),
    );
    processes.push(
      startProcess(
        "auth-registry",
        process.execPath,
        ["dist/index.js"],
        { DATABASE_URL: databaseUrl },
        path.join(repoRoot, "services", "auth-registry"),
      ),
    );
    processes.push(
      startProcess(
        "agent-gateway",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          AUTH_REGISTRY_URL: "http://127.0.0.1:4002",
          MARKET_SERVICE_URL: "http://127.0.0.1:4003",
          PORTFOLIO_SERVICE_URL: "http://127.0.0.1:4004",
          MATCHING_ENGINE_URL: `http://127.0.0.1:${matchingEnginePort}`,
        },
        path.join(repoRoot, "services", "agent-gateway"),
      ),
    );
    processes.push(
      startProcess(
        "resolution-service",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          MARKET_SERVICE_URL: "http://127.0.0.1:4003",
          PORTFOLIO_SERVICE_URL: "http://127.0.0.1:4004",
          RESOLUTION_QUORUM_THRESHOLD: "2",
        },
        path.join(repoRoot, "services", "resolution-service"),
      ),
    );
    processes.push(
      startProcess(
        "stream-service",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          AUTH_REGISTRY_URL: "http://127.0.0.1:4002",
        },
        path.join(repoRoot, "services", "stream-service"),
      ),
    );

    await waitForJson("http://127.0.0.1:4002/health");
    await waitForJson("http://127.0.0.1:4004/health");
    await waitForJson("http://127.0.0.1:4003/health");
    await waitForJson("http://127.0.0.1:4001/health");
    await waitForJson("http://127.0.0.1:4006/health");
    await waitForJson("http://127.0.0.1:4007/health");
    await waitForJson(`http://127.0.0.1:${matchingEnginePort}/health`);

    const marketCreation = await fetch("http://127.0.0.1:4003/v1/internal/markets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proposal_id: "stream-flow-market",
        title: "Will BTC close above $120k on December 31, 2026?",
        category: "crypto",
        close_time: new Date(Date.now() - 60_000).toISOString(),
        resolution_criteria: "Resolve YES if BTC closes above 120,000 USD by the close time.",
        resolution_spec: {
          kind: "price_threshold",
          source: {
            adapter: "http_json",
            canonical_url: `http://127.0.0.1:${sourcePort}/sources/btc`,
            allowed_domains: ["127.0.0.1", "localhost"],
          },
          observation_schema: {
            type: "object",
            fields: {
              price: {
                type: "number",
                path: "price",
              },
              observed_at: {
                type: "string",
                path: "observed_at",
              },
            },
          },
          decision_rule: {
            kind: "price_threshold",
            observation_field: "price",
            operator: "gt",
            threshold: 120000,
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
        },
      }),
    });
    if (!marketCreation.ok) {
      throw new Error(`Market creation failed with ${marketCreation.status}`);
    }
    const market = (await marketCreation.json()) as { id: string };

    const maker = await createAndAuthenticateAgent("stream-maker");
    const taker = await createAndAuthenticateAgent("stream-taker");

    const mintResponse = await fetch("http://127.0.0.1:4004/v1/internal/markets/mint-complete-set", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent_id: maker.id,
        market_id: market.id,
        size: 100,
      }),
    });
    if (!mintResponse.ok) {
      throw new Error(`Complete set mint failed with ${mintResponse.status}`);
    }

    const initialConnection = await openStreamSocket(maker.token);
    streamSocket = initialConnection.socket;
    const initialMessages = initialConnection.received;
    await delay(250);

    streamSocket.send(
      JSON.stringify({
        type: "subscribe",
        channels: [
          "market.snapshot",
          "orderbook.delta",
          "trade.fill",
          "order.update",
          "portfolio.update",
          "resolution.update",
        ],
        market_id: market.id,
      }),
    );

    await waitForCondition(
      () =>
        ["market.snapshot", "orderbook.delta", "trade.fill", "order.update", "portfolio.update", "resolution.update"].every(
          (channel) => initialMessages.some((message) => message.type === "snapshot" && message.channel === channel),
        ),
      "initial stream snapshots",
    );

    const makerOrderBody = {
      market_id: market.id,
      side: "sell" as const,
      outcome: "YES" as const,
      price: 0.58,
      size: 40,
      client_order_id: "stream-maker-sell-yes-1",
    };
    const makerOrderResponse = await fetch("http://127.0.0.1:4001/v1/orders", {
      method: "POST",
      headers: buildSignedHeaders(maker, "POST", "/v1/orders", makerOrderBody, {
        "idempotency-key": "stream-maker-sell-yes-1",
      }),
      body: JSON.stringify(makerOrderBody),
    });
    if (!makerOrderResponse.ok) {
      throw new Error(`Maker order failed with ${makerOrderResponse.status}`);
    }

    await waitForCondition(
      () =>
        initialMessages.some((message) => message.type === "event" && message.channel === "order.update") &&
        initialMessages.some((message) => message.type === "event" && message.channel === "orderbook.delta") &&
        initialMessages.some((message) => message.type === "event" && message.channel === "portfolio.update"),
      "maker-side stream events",
    );

    const lastSeenSequence = Math.max(
      ...initialMessages
        .filter((message) => typeof message.sequence_id === "number")
        .map((message) => message.sequence_id as number),
    );
    streamSocket.close();

    const takerOrderBody = {
      market_id: market.id,
      side: "buy" as const,
      outcome: "YES" as const,
      price: 0.6,
      size: 40,
      client_order_id: "stream-taker-buy-yes-1",
    };
    const takerOrderResponse = await fetch("http://127.0.0.1:4001/v1/orders", {
      method: "POST",
      headers: buildSignedHeaders(taker, "POST", "/v1/orders", takerOrderBody, {
        "idempotency-key": "stream-taker-buy-yes-1",
      }),
      body: JSON.stringify(takerOrderBody),
    });
    if (!takerOrderResponse.ok) {
      throw new Error(`Taker order failed with ${takerOrderResponse.status}`);
    }

    processes.push(
      startProcess(
        "resolution-collector-alpha",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          MARKET_SERVICE_URL: "http://127.0.0.1:4003",
          RESOLUTION_SERVICE_URL: "http://127.0.0.1:4006",
          COLLECTOR_AGENT_ID: "resolver-alpha",
          RESOLUTION_COLLECTOR_PORT: String(collectorAlphaPort),
          RESOLUTION_COLLECTOR_INTERVAL_MS: "500",
        },
        path.join(repoRoot, "services", "resolution-collector"),
      ),
    );
    processes.push(
      startProcess(
        "resolution-collector-beta",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          MARKET_SERVICE_URL: "http://127.0.0.1:4003",
          RESOLUTION_SERVICE_URL: "http://127.0.0.1:4006",
          COLLECTOR_AGENT_ID: "resolver-beta",
          RESOLUTION_COLLECTOR_PORT: String(collectorBetaPort),
          RESOLUTION_COLLECTOR_INTERVAL_MS: "500",
        },
        path.join(repoRoot, "services", "resolution-collector"),
      ),
    );

    await waitForJson(`http://127.0.0.1:${collectorAlphaPort}/health`);
    await waitForJson(`http://127.0.0.1:${collectorBetaPort}/health`);

    const replayConnection = await openStreamSocket(maker.token);
    replaySocket = replayConnection.socket;
    const replayMessages = replayConnection.received;
    await delay(250);
    replaySocket.send(
      JSON.stringify({
        type: "subscribe",
        channels: [
          "trade.fill",
          "order.update",
          "portfolio.update",
          "orderbook.delta",
          "resolution.update",
          "market.snapshot",
        ],
        market_id: market.id,
        from_sequence: lastSeenSequence,
        snapshot: false,
      }),
    );

    await waitForCondition(
      () =>
        replayMessages.some((message) => message.type === "event" && message.channel === "trade.fill") &&
        replayMessages.some((message) => message.type === "event" && message.channel === "order.update") &&
        replayMessages.some((message) => message.type === "event" && message.channel === "portfolio.update") &&
        replayMessages.some((message) => message.type === "event" && message.channel === "orderbook.delta") &&
        replayMessages.some(
          (message) =>
            message.type === "event" &&
            message.channel === "market.snapshot" &&
            typeof message.payload === "object" &&
            message.payload !== null &&
            (message.payload as { status?: string }).status === "resolved",
        ) &&
        replayMessages.some(
          (message) =>
            message.type === "event" &&
            message.channel === "resolution.update" &&
            typeof message.payload === "object" &&
            message.payload !== null &&
            (message.payload as { final_outcome?: string }).final_outcome === "YES",
        ),
      "replayed delta stream events",
    );

    const replaySequences = replayMessages
      .filter((message) => message.type === "event")
      .map((message) => message.sequence_id as number);
    if (replaySequences.some((value) => value <= lastSeenSequence)) {
      throw new Error(`Replay delivered stale sequence ids: ${JSON.stringify(replaySequences)}`);
    }

    console.log("live-test-streams ok");
  } finally {
    streamSocket?.close();
    replaySocket?.close();
    sourceServer.close();
    await Promise.all(processes.map((process) => stopProcess(process)));
    await rm(databaseDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
