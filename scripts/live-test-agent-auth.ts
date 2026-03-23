import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign as signDetached, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";

type ManagedProcess = {
  name: string;
  child: ReturnType<typeof spawn>;
  command: string;
  args: string[];
  extraEnv: Record<string, string>;
  cwd: string;
};

type AuthenticatedAgent = {
  id: string;
  token: string;
  privateKey: KeyObject;
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

  return { name, child, command, args, extraEnv, cwd };
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
  const auth = (await verifyResponse.json()) as { access_token: string; agent: { status: string } };
  if (auth.agent.status !== "active") {
    throw new Error(`Expected active agent after verify, received ${auth.agent.status}`);
  }

  return {
    id: agent.id,
    token: auth.access_token,
    privateKey,
  };
}

async function main() {
  const databasePort = await reservePort();
  const matchingEnginePort = await reservePort();
  const databaseDirectory = await mkdtemp(path.join(os.tmpdir(), "automakit-agent-auth-"));
  const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${databasePort}/postgres`;
  const repoRoot = process.cwd();
  const pgliteServerBin = path.join(repoRoot, "node_modules", ".bin", "pglite-server");

  const processes: ManagedProcess[] = [];
  let matchingEngineProcess: ManagedProcess | null = null;
  try {
    processes.push(
      startProcess(
        "database",
        pgliteServerBin,
        ["--db", databaseDirectory, "--host", "127.0.0.1", "--port", String(databasePort), "--max-connections", "16"],
      ),
    );
    await waitForDatabase(databaseUrl);

    matchingEngineProcess = startProcess(
      "matching-engine",
      "cargo",
      ["run", "--manifest-path", "services/matching-engine/Cargo.toml"],
      {
        MATCHING_ENGINE_PORT: String(matchingEnginePort),
        DATABASE_URL: databaseUrl,
      },
      repoRoot,
    );
    processes.push(matchingEngineProcess);
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

    await waitForJson("http://127.0.0.1:4002/health");
    await waitForJson("http://127.0.0.1:4004/health");
    await waitForJson("http://127.0.0.1:4003/health");
    await waitForJson("http://127.0.0.1:4001/health");
    await waitForJson(`http://127.0.0.1:${matchingEnginePort}/health`);

    const marketCreation = await fetch("http://127.0.0.1:4003/v1/internal/markets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proposal_id: "auth-flow-market",
        title: "Will BTC close above $120k on December 31, 2026?",
        category: "crypto",
        close_time: "2026-12-31T23:59:59Z",
        resolution_criteria: "Resolve YES if BTC closes above 120,000 USD by the close time.",
        resolution_spec: {
          kind: "price_threshold",
          source: {
            adapter: "http_json",
            canonical_url: "http://127.0.0.1:4999/sources/btc",
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

    const maker = await createAndAuthenticateAgent("maker-agent");
    const taker = await createAndAuthenticateAgent("taker-agent");

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

    const makerOrderBody = {
      market_id: market.id,
      side: "sell" as const,
      outcome: "YES" as const,
      price: 0.59,
      size: 50,
      client_order_id: "maker-sell-yes-1",
    };
    const makerOrderResponse = await fetch("http://127.0.0.1:4001/v1/orders", {
      method: "POST",
      headers: buildSignedHeaders(maker, "POST", "/v1/orders", makerOrderBody, {
        "idempotency-key": "maker-sell-yes-1",
      }),
      body: JSON.stringify(makerOrderBody),
    });
    if (!makerOrderResponse.ok) {
      throw new Error(`Maker order failed with ${makerOrderResponse.status}`);
    }
    const makerOrderAck = (await makerOrderResponse.json()) as {
      order_id: string;
      status: string;
      filled_size: number;
    };
    if (makerOrderAck.status !== "open" || makerOrderAck.filled_size !== 0) {
      throw new Error(`Unexpected maker order ack: ${JSON.stringify(makerOrderAck)}`);
    }

    await stopProcess(matchingEngineProcess);
    matchingEngineProcess = startProcess(
      "matching-engine-restart",
      "cargo",
      ["run", "--manifest-path", "services/matching-engine/Cargo.toml"],
      {
        MATCHING_ENGINE_PORT: String(matchingEnginePort),
        DATABASE_URL: databaseUrl,
      },
      repoRoot,
    );
    processes.push(matchingEngineProcess);
    await waitForJson(`http://127.0.0.1:${matchingEnginePort}/health`);

    const takerOrderBody = {
      market_id: market.id,
      side: "buy" as const,
      outcome: "YES" as const,
      price: 0.61,
      size: 50,
      client_order_id: "taker-buy-yes-1",
    };
    const takerOrderResponse = await fetch("http://127.0.0.1:4001/v1/orders", {
      method: "POST",
      headers: buildSignedHeaders(taker, "POST", "/v1/orders", takerOrderBody, {
        "idempotency-key": "taker-buy-yes-1",
      }),
      body: JSON.stringify(takerOrderBody),
    });
    if (!takerOrderResponse.ok) {
      throw new Error(`Taker order failed with ${takerOrderResponse.status}`);
    }
    const takerOrderAck = (await takerOrderResponse.json()) as {
      order_id: string;
      status: string;
      filled_size: number;
    };
    if (takerOrderAck.status !== "filled" || takerOrderAck.filled_size !== 50) {
      throw new Error(`Unexpected taker order ack: ${JSON.stringify(takerOrderAck)}`);
    }

    const [makerOrder, takerOrder] = await Promise.all([
      fetch(`http://127.0.0.1:4001/v1/orders/${makerOrderAck.order_id}`, {
        headers: {
          authorization: `Bearer ${maker.token}`,
        },
      }).then((response) => response.json() as Promise<{ status: string; filled_size: number }>),
      fetch(`http://127.0.0.1:4001/v1/orders/${takerOrderAck.order_id}`, {
        headers: {
          authorization: `Bearer ${taker.token}`,
        },
      }).then((response) => response.json() as Promise<{ status: string; filled_size: number }>),
    ]);

    if (makerOrder.status !== "filled" || makerOrder.filled_size !== 50) {
      throw new Error(`Maker order did not fill: ${JSON.stringify(makerOrder)}`);
    }
    if (takerOrder.status !== "filled" || takerOrder.filled_size !== 50) {
      throw new Error(`Taker order did not fill: ${JSON.stringify(takerOrder)}`);
    }

    const [makerFills, takerFills] = await Promise.all([
      fetch("http://127.0.0.1:4001/v1/fills", {
        headers: {
          authorization: `Bearer ${maker.token}`,
        },
      }).then((response) =>
        response.json() as Promise<{ items: Array<{ price: number; size: number; outcome: string }> }>
      ),
      fetch("http://127.0.0.1:4001/v1/fills", {
        headers: {
          authorization: `Bearer ${taker.token}`,
        },
      }).then((response) =>
        response.json() as Promise<{ items: Array<{ price: number; size: number; outcome: string }> }>
      ),
    ]);

    if (
      makerFills.items.length !== 1 ||
      takerFills.items.length !== 1 ||
      makerFills.items[0].price !== 0.59 ||
      takerFills.items[0].size !== 50
    ) {
      throw new Error(`Unexpected fill state: ${JSON.stringify({ makerFills, takerFills })}`);
    }

    const [makerPortfolio, takerPortfolio] = await Promise.all([
      fetch("http://127.0.0.1:4001/v1/portfolio", {
        headers: { authorization: `Bearer ${maker.token}` },
      }).then((response) =>
        response.json() as Promise<{ cash_balance: number; reserved_balance: number; positions: Array<{ quantity: number }> }>
      ),
      fetch("http://127.0.0.1:4001/v1/portfolio", {
        headers: { authorization: `Bearer ${taker.token}` },
      }).then((response) =>
        response.json() as Promise<{
          cash_balance: number;
          reserved_balance: number;
          positions: Array<{ outcome: string; quantity: number; average_price: number }>;
        }>
      ),
    ]);

    if (makerPortfolio.cash_balance <= 100000 || makerPortfolio.reserved_balance !== 0) {
      throw new Error(`Unexpected maker portfolio: ${JSON.stringify(makerPortfolio)}`);
    }
    if (
      takerPortfolio.cash_balance >= 100000 ||
      takerPortfolio.positions.length !== 1 ||
      takerPortfolio.positions[0].quantity !== 50 ||
      Math.abs(takerPortfolio.positions[0].average_price - 0.59) > 1e-9
    ) {
      throw new Error(`Unexpected taker portfolio: ${JSON.stringify(takerPortfolio)}`);
    }

    const marketDetail = (await (
      await fetch(`http://127.0.0.1:4003/v1/markets/${market.id}`)
    ).json()) as { last_traded_price_yes: number; volume_24h: number };
    if (Math.abs(marketDetail.last_traded_price_yes - 0.59) > 1e-9 || marketDetail.volume_24h !== 50) {
      throw new Error(`Unexpected market stats after fill: ${JSON.stringify(marketDetail)}`);
    }

    const cancelableOrderBody = {
      market_id: market.id,
      side: "buy" as const,
      outcome: "NO" as const,
      price: 0.42,
      size: 25,
      client_order_id: "maker-buy-no-open-1",
    };
    const openOrderResponse = await fetch("http://127.0.0.1:4001/v1/orders", {
      method: "POST",
      headers: buildSignedHeaders(maker, "POST", "/v1/orders", cancelableOrderBody, {
        "idempotency-key": "maker-buy-no-open-1",
      }),
      body: JSON.stringify(cancelableOrderBody),
    });
    if (!openOrderResponse.ok) {
      throw new Error(`Open order failed with ${openOrderResponse.status}`);
    }
    const openOrderAck = (await openOrderResponse.json()) as { order_id: string; status: string };
    if (openOrderAck.status !== "open") {
      throw new Error(`Unexpected open-order ack: ${JSON.stringify(openOrderAck)}`);
    }

    const reservedBeforeCancel = (await (
      await fetch("http://127.0.0.1:4001/v1/portfolio", {
        headers: { authorization: `Bearer ${maker.token}` },
      })
    ).json()) as { reserved_balance: number };
    if (Math.abs(reservedBeforeCancel.reserved_balance - 10.5) > 1e-9) {
      throw new Error(`Expected reserved balance before cancel: ${JSON.stringify(reservedBeforeCancel)}`);
    }

    const cancelBody = { order_id: openOrderAck.order_id };
    const cancelResponse = await fetch("http://127.0.0.1:4001/v1/orders/cancel", {
      method: "POST",
      headers: buildSignedHeaders(maker, "POST", "/v1/orders/cancel", cancelBody),
      body: JSON.stringify(cancelBody),
    });
    if (!cancelResponse.ok) {
      throw new Error(`Order cancel failed with ${cancelResponse.status}`);
    }

    const canceledOrder = (await (
      await fetch(`http://127.0.0.1:4001/v1/orders/${openOrderAck.order_id}`, {
        headers: { authorization: `Bearer ${maker.token}` },
      })
    ).json()) as { status: string };
    if (canceledOrder.status !== "canceled") {
      throw new Error(`Expected canceled order: ${JSON.stringify(canceledOrder)}`);
    }

    const reservedAfterCancel = (await (
      await fetch("http://127.0.0.1:4001/v1/portfolio", {
        headers: { authorization: `Bearer ${maker.token}` },
      })
    ).json()) as { reserved_balance: number };
    if (reservedAfterCancel.reserved_balance !== 0) {
      throw new Error(`Expected zero reserved balance after cancel: ${JSON.stringify(reservedAfterCancel)}`);
    }

    const verificationPool = new Pool({ connectionString: databaseUrl });
    try {
      const eventCounts = await verificationPool.query<{ event_type: string; count: string }>(
        `
          SELECT event_type, COUNT(*)::text AS count
          FROM order_events
          GROUP BY event_type
          ORDER BY event_type ASC
        `,
      );
      const counts = Object.fromEntries(
        eventCounts.rows.map((row) => [row.event_type, Number(row.count)]),
      ) as Record<string, number>;

      if (counts.accepted !== 3 || counts.fill !== 1 || counts.canceled !== 1) {
        throw new Error(`Unexpected order event log counts: ${JSON.stringify(counts)}`);
      }
    } finally {
      await verificationPool.end();
    }

    console.log("live-test-agent-auth ok");
  } finally {
    await Promise.all(processes.map((process) => stopProcess(process)));
    await rm(databaseDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
