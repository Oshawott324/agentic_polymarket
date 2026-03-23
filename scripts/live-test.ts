import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
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

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`);
  });

  return { name, child, command, args, extraEnv, cwd };
}

async function waitForJson(url: string, attempts = 50) {
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

async function waitForText(url: string, expected: string, attempts = 50) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const text = await response.text();
        if (text.includes(expected)) {
          return;
        }
      }
    } catch {}

    await delay(500);
  }

  throw new Error(`Timed out waiting for text ${expected} at ${url}`);
}

async function waitForCondition(
  label: string,
  predicate: () => Promise<boolean>,
  attempts = 50,
) {
  for (let index = 0; index < attempts; index += 1) {
    if (await predicate()) {
      return;
    }
    await delay(500);
  }

  throw new Error(`Timed out waiting for condition: ${label}`);
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
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
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

function restartProcess(processes: ManagedProcess[], process: ManagedProcess) {
  const index = processes.indexOf(process);
  const restarted = startProcess(process.name, process.command, process.args, process.extraEnv, process.cwd);
  if (index >= 0) {
    processes[index] = restarted;
  } else {
    processes.push(restarted);
  }
  return restarted;
}

async function main() {
  const databasePort = await reservePort();
  const feedPort = await reservePort();
  const collectorAlphaPort = await reservePort();
  const collectorBetaPort = await reservePort();
  const worldInputPort = await reservePort();
  const worldModelPort = await reservePort();
  const proposalAgentPort = await reservePort();
  const databaseDirectory = await mkdtemp(path.join(os.tmpdir(), "automakit-live-test-"));
  const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${databasePort}/postgres`;
  const repoRoot = process.cwd();
  const nextBin = path.join(repoRoot, "node_modules", ".pnpm", "node_modules", ".bin", "next");
  const pgliteServerBin = path.join(repoRoot, "node_modules", ".bin", "pglite-server");
  const resolvedCloseTime = new Date(Date.now() - 60_000).toISOString();
  const worldInputPricePayload = {
    items: [
      {
        source_id: "btc-threshold-jun-2026",
        title: "BTC threshold candidate",
        summary: "BTC threshold world signal",
        effective_at: resolvedCloseTime,
        payload: {
          kind: "price_threshold",
          asset_symbol: "BTC",
          threshold: 100000,
          operator: "gt",
          target_time: resolvedCloseTime,
          canonical_source_url: `http://127.0.0.1:${feedPort}/sources/btc`,
          category: "crypto",
        },
      },
    ],
  };
  const worldInputFedPayload = {
    items: [
      {
        source_id: "fed-cut-jul-2026",
        title: "Federal Reserve rate decision candidate",
        summary: "Federal Reserve rate cut world signal",
        effective_at: resolvedCloseTime,
        payload: {
          kind: "rate_decision",
          institution: "Federal Reserve",
          direction: "cut",
          target_time: resolvedCloseTime,
          canonical_source_url: `http://127.0.0.1:${feedPort}/sources/fed`,
          category: "macro",
        },
      },
    ],
  };

  let fedObservationCount = 0;

  const feedServer = http.createServer((request, response) => {
    if (request.url === "/world-input/price") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(worldInputPricePayload));
      return;
    }

    if (request.url === "/world-input/fed-calendar") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(worldInputFedPayload));
      return;
    }

    if (request.url === "/sources/btc") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          price: 100500,
          observed_at: new Date().toISOString(),
        }),
      );
      return;
    }

    if (request.url === "/sources/fed") {
      fedObservationCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          fedObservationCount === 1
            ? {
                previous_upper_bound_bps: 450,
                current_upper_bound_bps: 425,
                observed_at: new Date().toISOString(),
              }
            : {
                previous_upper_bound_bps: 450,
                current_upper_bound_bps: 450,
                observed_at: new Date().toISOString(),
              },
        ),
      );
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => {
    feedServer.listen(feedPort, "127.0.0.1", () => resolve());
  });

  const processes: ManagedProcess[] = [];
  try {
    processes.push(
      startProcess(
        "database",
        pgliteServerBin,
        [
          "--db",
          databaseDirectory,
          "--host",
          "127.0.0.1",
          "--port",
          String(databasePort),
          "--max-connections",
          "16",
        ],
      ),
    );
    await waitForDatabase(databaseUrl);

    processes.push(
      startProcess(
        "portfolio-service",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
        },
        path.join(repoRoot, "services", "portfolio-service"),
      ),
    );
    processes.push(
      startProcess(
        "market-service",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
        },
        path.join(repoRoot, "services", "market-service"),
      ),
    );
    processes.push(
      startProcess(
        "proposal-pipeline",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          MARKET_SERVICE_URL: "http://127.0.0.1:4003",
        },
        path.join(repoRoot, "services", "proposal-pipeline"),
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
        },
        path.join(repoRoot, "services", "resolution-service"),
      ),
    );
    processes.push(
      startProcess(
        "world-input",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          WORLD_INPUT_SOURCES_JSON: JSON.stringify([
            {
              key: "btc-price",
              adapter: "http_json_price",
              url: `http://127.0.0.1:${feedPort}/world-input/price`,
              poll_interval_seconds: 1,
              backfill_hours: 24,
              trust_tier: "exchange",
            },
            {
              key: "fed-calendar",
              adapter: "http_json_calendar",
              url: `http://127.0.0.1:${feedPort}/world-input/fed-calendar`,
              poll_interval_seconds: 1,
              backfill_hours: 24,
              trust_tier: "official",
            },
          ]),
          WORLD_INPUT_PORT: String(worldInputPort),
          WORLD_INPUT_INTERVAL_MS: "250",
        },
        path.join(repoRoot, "services", "world-input"),
      ),
    );
    processes.push(
      startProcess(
        "world-model",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          WORLD_MODEL_PORT: String(worldModelPort),
          WORLD_MODEL_INTERVAL_MS: "250",
        },
        path.join(repoRoot, "services", "world-model"),
      ),
    );
    processes.push(
      startProcess(
        "proposal-agent",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          PROPOSAL_PIPELINE_URL: "http://127.0.0.1:4005",
          PROPOSAL_AGENT_PORT: String(proposalAgentPort),
          PROPOSAL_AGENT_INTERVAL_MS: "250",
        },
        path.join(repoRoot, "services", "proposal-agent"),
      ),
    );
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
    processes.push(
      startProcess(
        "web",
        nextBin,
        ["start", "-p", "3000"],
        {
          MARKET_SERVICE_URL: "http://127.0.0.1:4003",
        },
        path.join(repoRoot, "apps", "web"),
      ),
    );
    processes.push(
      startProcess(
        "observer-console",
        nextBin,
        ["start", "-p", "3001"],
        {
          PROPOSAL_PIPELINE_URL: "http://127.0.0.1:4005",
        },
        path.join(repoRoot, "apps", "observer-console"),
      ),
    );

    await waitForJson("http://127.0.0.1:4003/health");
    await waitForJson("http://127.0.0.1:4004/health");
    await waitForJson("http://127.0.0.1:4005/health");
    await waitForJson("http://127.0.0.1:4006/health");
    await waitForJson(`http://127.0.0.1:${worldInputPort}/health`);
    await waitForJson(`http://127.0.0.1:${worldModelPort}/health`);
    await waitForJson(`http://127.0.0.1:${proposalAgentPort}/health`);
    await waitForJson(`http://127.0.0.1:${collectorAlphaPort}/health`);
    await waitForJson(`http://127.0.0.1:${collectorBetaPort}/health`);
    await waitForText("http://127.0.0.1:3000", "Markets");
    await waitForText("http://127.0.0.1:3001/proposals", "Proposal Queue");

    await waitForCondition("world signals", async () => {
      const signals = (await waitForJson(`http://127.0.0.1:${worldInputPort}/v1/internal/world-signals`)) as {
        items: Array<{ source_id: string }>;
      };
      return signals.items.length >= 2;
    });

    await waitForCondition("world hypotheses", async () => {
      const hypotheses = (await waitForJson(`http://127.0.0.1:${worldModelPort}/v1/internal/world-hypotheses`)) as {
        items: Array<{ status: string }>;
      };
      return hypotheses.items.length >= 2;
    });

    await waitForCondition("published proposals", async () => {
      const proposals = (await waitForJson("http://127.0.0.1:4005/v1/proposals")) as {
        items: Array<{ status: string }>;
      };
      return proposals.items.length >= 2 && proposals.items.every((proposal) => proposal.status === "published");
    });

    const proposals = (await waitForJson("http://127.0.0.1:4005/v1/proposals")) as {
      items: Array<{ title: string; status: string; linked_market_id?: string }>;
    };

    await waitForCondition("published markets", async () => {
      const markets = (await waitForJson("http://127.0.0.1:4003/v1/markets")) as {
        items: Array<{ id: string; title: string }>;
      };
      return markets.items.length >= 2;
    });

    const markets = (await waitForJson("http://127.0.0.1:4003/v1/markets")) as {
      items: Array<{ id: string; title: string }>;
    };

    const btcMarket = markets.items.find((entry) => entry.title.includes("BTC trade above"));
    const fedMarket = markets.items.find((entry) => entry.title.includes("Federal Reserve cut rates"));

    if (!btcMarket || !fedMarket) {
      throw new Error(`Expected BTC and Fed markets, received ${JSON.stringify(markets.items)}`);
    }

    const proposalTitles = proposals.items.map((proposal) => proposal.title).sort();
    if (
      proposalTitles.length < 2 ||
      !proposalTitles.some((title) => title.includes("BTC trade above")) ||
      !proposalTitles.some((title) => title.includes("Federal Reserve cut rates"))
    ) {
      throw new Error(`Unexpected proposal set: ${JSON.stringify(proposals.items)}`);
    }

    await waitForText("http://127.0.0.1:3000", "Will BTC trade above $100,000");
    await waitForText("http://127.0.0.1:3001/proposals", "Will Federal Reserve cut rates");

    await waitForCondition("autonomous resolutions", async () => {
      const resolutions = (await waitForJson("http://127.0.0.1:4006/v1/resolutions")) as {
        items: Array<{ market_id: string; status: string; final_outcome: string | null }>;
      };
      const finalizedResolution = resolutions.items.find((entry) => entry.market_id === btcMarket.id);
      const quarantinedResolution = resolutions.items.find((entry) => entry.market_id === fedMarket.id);
      return (
        finalizedResolution?.status === "finalized" &&
        finalizedResolution.final_outcome === "YES" &&
        quarantinedResolution?.status === "quarantined"
      );
    });

    const resolutions = (await waitForJson("http://127.0.0.1:4006/v1/resolutions")) as {
      items: Array<{ market_id: string; status: string; final_outcome: string | null }>;
    };
    const finalizedResolution = resolutions.items.find((entry) => entry.market_id === btcMarket.id);
    const quarantinedResolution = resolutions.items.find((entry) => entry.market_id === fedMarket.id);

    if (
      !finalizedResolution ||
      finalizedResolution.status !== "finalized" ||
      finalizedResolution.final_outcome !== "YES"
    ) {
      throw new Error(`Unexpected resolution state: ${JSON.stringify(resolutions.items)}`);
    }

    if (!quarantinedResolution || quarantinedResolution.status !== "quarantined") {
      throw new Error(`Expected quarantined resolution state: ${JSON.stringify(resolutions.items)}`);
    }

    const resolvedMarketDetail = (await waitForJson(`http://127.0.0.1:4003/v1/markets/${btcMarket.id}`)) as {
      status: string;
    };
    const quarantinedMarketDetail = (await waitForJson(`http://127.0.0.1:4003/v1/markets/${fedMarket.id}`)) as {
      status: string;
    };
    if (resolvedMarketDetail.status !== "resolved" || quarantinedMarketDetail.status !== "suspended") {
      throw new Error(
        `Unexpected market statuses after autonomous resolution: ${JSON.stringify({
          btc: resolvedMarketDetail,
          fed: quarantinedMarketDetail,
        })}`,
      );
    }

    for (const process of ["proposal-agent", "world-model", "world-input"]) {
      const service = processes.find((entry) => entry.name === process);
      if (!service) {
        throw new Error(`${process} process not found`);
      }
      await stopProcess(service);
    }

    const proposalPipeline = processes.find((entry) => entry.name === "proposal-pipeline");
    const marketService = processes.find((entry) => entry.name === "market-service");
    const resolutionService = processes.find((entry) => entry.name === "resolution-service");

    if (!proposalPipeline || !marketService || !resolutionService) {
      throw new Error("Missing persisted service process for restart validation");
    }

    await stopProcess(proposalPipeline);
    await stopProcess(marketService);
    await stopProcess(resolutionService);

    restartProcess(processes, marketService);
    restartProcess(processes, proposalPipeline);
    restartProcess(processes, resolutionService);

    await waitForJson("http://127.0.0.1:4003/health");
    await waitForJson("http://127.0.0.1:4004/health");
    await waitForJson("http://127.0.0.1:4005/health");
    await waitForJson("http://127.0.0.1:4006/health");

    const persistedProposals = (await waitForJson("http://127.0.0.1:4005/v1/proposals")) as {
      items: Array<{ status: string; title: string }>;
    };
    if (
      persistedProposals.items.length < 2 ||
      !persistedProposals.items.every((proposal) => proposal.status === "published")
    ) {
      throw new Error(`Proposals were not persisted across restart: ${JSON.stringify(persistedProposals.items)}`);
    }

    const persistedMarkets = (await waitForJson("http://127.0.0.1:4003/v1/markets")) as {
      items: Array<{ id: string; title: string; status: string }>;
    };
    if (
      persistedMarkets.items.length < 2 ||
      !persistedMarkets.items.some((market) => market.id === btcMarket.id) ||
      !persistedMarkets.items.some((market) => market.id === fedMarket.id)
    ) {
      throw new Error(`Markets were not persisted across restart: ${JSON.stringify(persistedMarkets.items)}`);
    }
    if (!persistedMarkets.items.some((market) => market.id === btcMarket.id && market.status === "resolved")) {
      throw new Error(`Resolved market status was not persisted: ${JSON.stringify(persistedMarkets.items)}`);
    }
    if (!persistedMarkets.items.some((market) => market.id === fedMarket.id && market.status === "suspended")) {
      throw new Error(`Suspended market status was not persisted: ${JSON.stringify(persistedMarkets.items)}`);
    }

    const persistedResolutions = (await waitForJson("http://127.0.0.1:4006/v1/resolutions")) as {
      items: Array<{ market_id: string; status: string; final_outcome: string | null }>;
    };
    const persistedBtcResolution = persistedResolutions.items.find((entry) => entry.market_id === btcMarket.id);
    const persistedFedResolution = persistedResolutions.items.find((entry) => entry.market_id === fedMarket.id);
    if (
      !persistedBtcResolution ||
      persistedBtcResolution.status !== "finalized" ||
      persistedBtcResolution.final_outcome !== "YES"
    ) {
      throw new Error(`Finalized resolution was not persisted: ${JSON.stringify(persistedResolutions.items)}`);
    }
    if (!persistedFedResolution || persistedFedResolution.status !== "quarantined") {
      throw new Error(`Quarantined resolution was not persisted: ${JSON.stringify(persistedResolutions.items)}`);
    }

    await waitForText("http://127.0.0.1:3000", "Will BTC trade above $100,000");
    await waitForText("http://127.0.0.1:3001/proposals", "Will Federal Reserve cut rates");

    console.log("live-test ok");
  } finally {
    await Promise.all(
      processes.map((process) => stopProcess(process)),
    );

    await new Promise<void>((resolve, reject) => {
      feedServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await rm(databaseDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
