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

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Request failed ${response.status} ${url}: ${await response.text()}`);
  }
  return response.json();
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
  const approvalAlphaPort = await reservePort();
  const approvalBetaPort = await reservePort();
  const approvalGammaPort = await reservePort();
  const worldInputPort = await reservePort();
  const orchestratorPort = await reservePort();
  const worldModelAlphaPort = await reservePort();
  const worldModelBetaPort = await reservePort();
  const scenarioBasePort = await reservePort();
  const scenarioBullPort = await reservePort();
  const scenarioBearPort = await reservePort();
  const synthesisPort = await reservePort();
  const proposalAgentPort = await reservePort();
  const databaseDirectory = await mkdtemp(path.join(os.tmpdir(), "automakit-live-test-"));
  const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${databasePort}/postgres`;
  const repoRoot = process.cwd();
  const dbPool = new Pool({ connectionString: databaseUrl, max: 1 });
  dbPool.on("error", () => undefined);
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
  const worldInputXPayload = {
    data: [
      {
        id: "x-live-1",
        text: "Macro desks tracking CPI and Fed path",
        created_at: resolvedCloseTime,
        author_id: "world-agent-1",
      },
    ],
    meta: {
      newest_id: "x-live-1",
      result_count: 1,
    },
  };
  const worldInputRedditPayload = {
    data: {
      children: [
        {
          data: {
            id: "reddit-live-1",
            subreddit: "economy",
            title: "Fed path discussion",
            selftext: "Community expects easing if inflation cools.",
            created_utc: Math.floor(new Date(resolvedCloseTime).getTime() / 1000),
            permalink: "/r/economy/comments/reddit-live-1/fed_path_discussion",
          },
        },
      ],
    },
  };
  const worldInputRssPayload = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Automakit News</title>
    <item>
      <guid>rss-live-1</guid>
      <title>Inflation cooldown headline</title>
      <link>https://news.example/rss-live-1</link>
      <description>Markets digest lower inflation prints.</description>
      <pubDate>${new Date(resolvedCloseTime).toUTCString()}</pubDate>
    </item>
  </channel>
</rss>`;

  let fedObservationCount = 0;
  function toJsonCompletion(content: unknown) {
    return {
      id: "chatcmpl-live-test",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "live-test-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: JSON.stringify(content) },
          finish_reason: "stop",
        },
      ],
    };
  }

  async function readJsonRequestBody(request: http.IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    if (chunks.length === 0) {
      return {};
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
  }

  function asString(value: unknown, fallback = "") {
    return typeof value === "string" ? value : fallback;
  }

  function asNumber(value: unknown, fallback = 0) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  function handleWorldModelMock(payload: Record<string, unknown>) {
    const userMessage = Array.isArray(payload.messages)
      ? ((payload.messages as Array<Record<string, unknown>>).find(
          (message) => message.role === "user",
        ) as Record<string, unknown> | undefined)
      : undefined;
    const userContent =
      userMessage && typeof userMessage.content === "string"
        ? (JSON.parse(userMessage.content) as { signals?: Array<Record<string, unknown>> })
        : { signals: [] };
    const signals = Array.isArray(userContent.signals) ? userContent.signals : [];
    const hypotheses = signals
      .map((signal) => {
        const payloadObject =
          signal.payload && typeof signal.payload === "object"
            ? (signal.payload as Record<string, unknown>)
            : {};
        const signalId = asString(signal.id);
        if (!signalId) {
          return null;
        }
        if (payloadObject.kind === "price_threshold") {
          return {
            source_signal_id: signalId,
            hypothesis_kind: "price_threshold",
            category: typeof payloadObject.category === "string" ? payloadObject.category : "crypto",
            subject: typeof payloadObject.asset_symbol === "string" ? payloadObject.asset_symbol : "BTC",
            predicate: "price_threshold",
            target_time:
              typeof payloadObject.target_time === "string"
                ? payloadObject.target_time
                : new Date().toISOString(),
            confidence_score: 0.79,
            reasoning_summary: "LLM world-model interpreted the threshold signal as bullish.",
            machine_resolvable: true,
          };
        }
        if (payloadObject.kind === "rate_decision") {
          const direction =
            payloadObject.direction === "hold" || payloadObject.direction === "hike"
              ? payloadObject.direction
              : "cut";
          return {
            source_signal_id: signalId,
            hypothesis_kind: "rate_decision",
            category: typeof payloadObject.category === "string" ? payloadObject.category : "macro",
            subject:
              typeof payloadObject.institution === "string" ? payloadObject.institution : "Federal Reserve",
            predicate: `rate_decision_${direction}`,
            target_time:
              typeof payloadObject.target_time === "string"
                ? payloadObject.target_time
                : new Date().toISOString(),
            confidence_score: 0.74,
            reasoning_summary: "LLM world-model interpreted policy signal as easing-biased.",
            machine_resolvable: true,
          };
        }
        return null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    const entities = signals.flatMap((signal) => {
      const signalId = asString(signal.id);
      if (!signalId) {
        return [];
      }
      const refs = Array.isArray(signal.entity_refs) ? signal.entity_refs : [];
      return refs
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => {
          const typed = entry as Record<string, unknown>;
          return {
            id: `${asString(typed.kind)}:${asString(typed.value)}`,
            kind: asString(typed.kind),
            name: asString(typed.value),
            attributes: {
              source_signal_id: signalId,
            },
          };
        });
    });
    const activeEvents = signals
      .map((signal) => {
        const signalId = asString(signal.id);
        if (!signalId) {
          return null;
        }
        return {
          id: signalId,
          title: asString(signal.title, "world-signal"),
          event_type:
            signal.payload &&
            typeof signal.payload === "object" &&
            typeof (signal.payload as Record<string, unknown>).kind === "string"
              ? asString((signal.payload as Record<string, unknown>).kind)
              : "world_signal",
          effective_at: signal.effective_at ?? null,
          source_signal_ids: [signalId],
        };
      })
      .filter((event): event is NonNullable<typeof event> => Boolean(event));

    return {
      world_state: {
        as_of: new Date().toISOString(),
        entities,
        active_events: activeEvents,
        factors: [
          {
            factor: "llm_sentiment",
            value: 0.72,
            direction: "up",
            rationale: "LLM interpreted a constructive outlook from incoming signals.",
          },
        ],
        regime_labels: ["belief-layer", "market:risk_on"],
        reasoning_summary: "LLM world-model synthesized incoming signals into a coherent regime view.",
      },
      hypotheses,
    };
  }

  function handleScenarioMock(payload: Record<string, unknown>) {
    const userMessage = Array.isArray(payload.messages)
      ? ((payload.messages as Array<Record<string, unknown>>).find(
          (message) => message.role === "user",
        ) as Record<string, unknown> | undefined)
      : undefined;
    const userContent =
      userMessage && typeof userMessage.content === "string"
        ? (JSON.parse(userMessage.content) as {
            scenario_label?: string;
            hypotheses?: Array<Record<string, unknown>>;
          })
        : { scenario_label: "base", hypotheses: [] };
    const scenarioLabel = typeof userContent.scenario_label === "string" ? userContent.scenario_label : "base";
    const hypotheses = Array.isArray(userContent.hypotheses) ? userContent.hypotheses : [];
    const delta = scenarioLabel === "bull" ? 0.1 : scenarioLabel === "bear" ? -0.1 : -0.02;
    return {
      narrative: `LLM scenario agent produced a ${scenarioLabel} path.`,
      factor_deltas: {
        scenario_label: scenarioLabel,
        llm_path: true,
      },
      path_events: [
        {
          title: `${scenarioLabel} path launched`,
          event_type: "scenario_path",
          description: `LLM ${scenarioLabel} path event.`,
          effective_at: new Date().toISOString(),
        },
      ],
      path_hypotheses: hypotheses.map((hypothesis) => ({
        key: asString(hypothesis.key),
        confidence_score: Math.max(0.05, Math.min(0.95, asNumber(hypothesis.average_confidence, 0.6) + delta)),
        reasoning_summary: `LLM scenario adjustment for ${scenarioLabel} path.`,
      })),
    };
  }

  function handleSynthesisMock(payload: Record<string, unknown>) {
    const userMessage = Array.isArray(payload.messages)
      ? ((payload.messages as Array<Record<string, unknown>>).find(
          (message) => message.role === "user",
        ) as Record<string, unknown> | undefined)
      : undefined;
    const userContent =
      userMessage && typeof userMessage.content === "string"
        ? (JSON.parse(userMessage.content) as { candidates?: Array<Record<string, unknown>> })
        : { candidates: [] };
    const candidates = Array.isArray(userContent.candidates) ? userContent.candidates : [];
    return {
      beliefs: candidates.map((candidate) => {
        const direct = Array.isArray(candidate.direct) ? candidate.direct : [];
        const scenario = Array.isArray(candidate.scenario) ? candidate.scenario : [];
        const directAvg =
          direct.length > 0
            ? direct.reduce((sum, entry) => sum + Number((entry as Record<string, unknown>).confidence ?? 0), 0) /
              direct.length
            : 0.55;
        const scenarioAvg =
          scenario.length > 0
            ? scenario.reduce((sum, entry) => {
                const typed = entry as Record<string, unknown>;
                return sum + Number(typed.confidence ?? 0) * Number(typed.probability ?? 0);
              }, 0) /
              Math.max(scenario.reduce((sum, entry) => sum + asNumber((entry as Record<string, unknown>).probability), 0), 1)
            : directAvg;
        const confidence = Math.max(0.05, Math.min(0.95, directAvg * 0.55 + scenarioAvg * 0.45));
        return {
          key: asString(candidate.key),
          agreement_score: 0.72,
          disagreement_score: 0.18,
          confidence_score: confidence,
          status: confidence >= 0.62 ? "new" : "suppressed",
          conflict_notes: null,
          suppression_reason: confidence >= 0.62 ? null : "insufficient_combined_confidence",
          reasoning_summary: "LLM synthesis merged world-model and scenario outputs.",
        };
      }),
    };
  }

  const feedServer = http.createServer(async (request, response) => {
    if (request.url === "/v1/chat/completions" && request.method === "POST") {
      const body = await readJsonRequestBody(request);
      const systemMessage = Array.isArray(body.messages)
        ? ((body.messages as Array<Record<string, unknown>>).find(
            (message) => message.role === "system",
          ) as Record<string, unknown> | undefined)
        : undefined;
      const systemPrompt =
        systemMessage && typeof systemMessage.content === "string" ? systemMessage.content : "";
      if (systemPrompt.includes("world-model agent")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(toJsonCompletion(handleWorldModelMock(body))));
        return;
      }
      if (systemPrompt.includes("scenario simulation agent")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(toJsonCompletion(handleScenarioMock(body))));
        return;
      }
      if (systemPrompt.includes("synthesis agent for a prediction-market simulation fabric")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(toJsonCompletion(handleSynthesisMock(body))));
        return;
      }

      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unsupported_prompt" }));
      return;
    }

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

    if (request.url?.startsWith("/world-input/x")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(worldInputXPayload));
      return;
    }

    if (request.url?.startsWith("/world-input/reddit")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(worldInputRedditPayload));
      return;
    }

    if (request.url?.startsWith("/world-input/rss")) {
      response.writeHead(200, { "content-type": "application/rss+xml" });
      response.end(worldInputRssPayload);
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

  const llmEnv = {
    LLM_API_KEY: "live-test-key",
    LLM_BASE_URL: `http://127.0.0.1:${feedPort}/v1`,
    LLM_MODEL_NAME: "live-test-model",
  };

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
          "32",
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
          WORLD_INPUT_BOOTSTRAP_SOURCES_JSON: "[]",
          WORLD_INPUT_PORT: String(worldInputPort),
          WORLD_INPUT_INTERVAL_MS: "250",
        },
        path.join(repoRoot, "services", "world-input"),
      ),
    );
    processes.push(
      startProcess(
        "simulation-orchestrator",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          SIMULATION_ORCHESTRATOR_PORT: String(orchestratorPort),
          SIMULATION_ORCHESTRATOR_INTERVAL_MS: "250",
          SIMULATION_WORLD_MODEL_REQUIRED: "2",
          SIMULATION_SCENARIO_REQUIRED: "3",
          SIMULATION_SYNTHESIS_REQUIRED: "1",
        },
        path.join(repoRoot, "services", "simulation-orchestrator"),
      ),
    );
    processes.push(
      startProcess(
        "world-model-alpha",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          WORLD_MODEL_PORT: String(worldModelAlphaPort),
          WORLD_MODEL_INTERVAL_MS: "250",
          WORLD_MODEL_AGENT_ID: "world-model-alpha",
          WORLD_MODEL_AGENT_PROFILE: "macro",
          WORLD_MODEL_MODE: "llm",
          ...llmEnv,
        },
        path.join(repoRoot, "services", "world-model"),
      ),
    );
    processes.push(
      startProcess(
        "world-model-beta",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          WORLD_MODEL_PORT: String(worldModelBetaPort),
          WORLD_MODEL_INTERVAL_MS: "250",
          WORLD_MODEL_AGENT_ID: "world-model-beta",
          WORLD_MODEL_AGENT_PROFILE: "market",
          WORLD_MODEL_MODE: "llm",
          ...llmEnv,
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
        "scenario-agent-base",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          SCENARIO_AGENT_PORT: String(scenarioBasePort),
          SCENARIO_AGENT_INTERVAL_MS: "250",
          SCENARIO_AGENT_ID: "scenario-base",
          SCENARIO_LABEL: "base",
          SCENARIO_PROBABILITY: "0.5",
          SCENARIO_AGENT_MODE: "llm",
          ...llmEnv,
        },
        path.join(repoRoot, "services", "scenario-agent"),
      ),
    );
    processes.push(
      startProcess(
        "scenario-agent-bull",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          SCENARIO_AGENT_PORT: String(scenarioBullPort),
          SCENARIO_AGENT_INTERVAL_MS: "250",
          SCENARIO_AGENT_ID: "scenario-bull",
          SCENARIO_LABEL: "bull",
          SCENARIO_PROBABILITY: "0.3",
          SCENARIO_AGENT_MODE: "llm",
          ...llmEnv,
        },
        path.join(repoRoot, "services", "scenario-agent"),
      ),
    );
    processes.push(
      startProcess(
        "scenario-agent-bear",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          SCENARIO_AGENT_PORT: String(scenarioBearPort),
          SCENARIO_AGENT_INTERVAL_MS: "250",
          SCENARIO_AGENT_ID: "scenario-bear",
          SCENARIO_LABEL: "bear",
          SCENARIO_PROBABILITY: "0.2",
          SCENARIO_AGENT_MODE: "llm",
          ...llmEnv,
        },
        path.join(repoRoot, "services", "scenario-agent"),
      ),
    );
    processes.push(
      startProcess(
        "synthesis-agent",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          SYNTHESIS_AGENT_PORT: String(synthesisPort),
          SYNTHESIS_AGENT_INTERVAL_MS: "250",
          SYNTHESIS_AGENT_ID: "synthesis-core",
          SYNTHESIS_AGENT_MODE: "llm",
          ...llmEnv,
        },
        path.join(repoRoot, "services", "synthesis-agent"),
      ),
    );
    processes.push(
      startProcess(
        "approval-agent-alpha",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          APPROVAL_AGENT_PORT: String(approvalAlphaPort),
          APPROVAL_AGENT_ID: "approval-alpha",
          APPROVAL_AGENT_INTERVAL_MS: "250",
          APPROVAL_AGENT_BATCH_SIZE: "20",
          APPROVAL_QUORUM_REQUIRED: "2",
          APPROVAL_MIN_APPROVALS: "2",
          APPROVAL_MAX_AMBIGUITY: "0.4",
          APPROVAL_MIN_RESOLVABILITY: "0.55",
          APPROVAL_MAX_MANIPULATION_RISK: "0.7",
        },
        path.join(repoRoot, "services", "approval-agent"),
      ),
    );
    processes.push(
      startProcess(
        "approval-agent-beta",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          APPROVAL_AGENT_PORT: String(approvalBetaPort),
          APPROVAL_AGENT_ID: "approval-beta",
          APPROVAL_AGENT_INTERVAL_MS: "250",
          APPROVAL_AGENT_BATCH_SIZE: "20",
          APPROVAL_QUORUM_REQUIRED: "2",
          APPROVAL_MIN_APPROVALS: "2",
          APPROVAL_MAX_AMBIGUITY: "0.4",
          APPROVAL_MIN_RESOLVABILITY: "0.55",
          APPROVAL_MAX_MANIPULATION_RISK: "0.7",
        },
        path.join(repoRoot, "services", "approval-agent"),
      ),
    );
    processes.push(
      startProcess(
        "approval-agent-gamma",
        process.execPath,
        ["dist/index.js"],
        {
          DATABASE_URL: databaseUrl,
          APPROVAL_AGENT_PORT: String(approvalGammaPort),
          APPROVAL_AGENT_ID: "approval-gamma",
          APPROVAL_AGENT_INTERVAL_MS: "250",
          APPROVAL_AGENT_BATCH_SIZE: "20",
          APPROVAL_QUORUM_REQUIRED: "2",
          APPROVAL_MIN_APPROVALS: "2",
          APPROVAL_MAX_AMBIGUITY: "0.4",
          APPROVAL_MIN_RESOLVABILITY: "0.55",
          APPROVAL_MAX_MANIPULATION_RISK: "0.7",
        },
        path.join(repoRoot, "services", "approval-agent"),
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
    await waitForJson(`http://127.0.0.1:${orchestratorPort}/health`);
    await waitForJson(`http://127.0.0.1:${worldModelAlphaPort}/health`);
    await waitForJson(`http://127.0.0.1:${worldModelBetaPort}/health`);
    await waitForJson(`http://127.0.0.1:${scenarioBasePort}/health`);
    await waitForJson(`http://127.0.0.1:${scenarioBullPort}/health`);
    await waitForJson(`http://127.0.0.1:${scenarioBearPort}/health`);
    await waitForJson(`http://127.0.0.1:${synthesisPort}/health`);
    await waitForJson(`http://127.0.0.1:${approvalAlphaPort}/health`);
    await waitForJson(`http://127.0.0.1:${approvalBetaPort}/health`);
    await waitForJson(`http://127.0.0.1:${approvalGammaPort}/health`);
    await waitForJson(`http://127.0.0.1:${proposalAgentPort}/health`);
    await waitForJson(`http://127.0.0.1:${collectorAlphaPort}/health`);
    await waitForJson(`http://127.0.0.1:${collectorBetaPort}/health`);
    await waitForText("http://127.0.0.1:3000", "Markets");
    await waitForText("http://127.0.0.1:3001/proposals", "Proposal Queue");

    await postJson(`http://127.0.0.1:${worldInputPort}/v1/internal/world-input/sources`, {
      key: "btc-price",
      adapter: "http_json_price",
      url: `http://127.0.0.1:${feedPort}/world-input/price`,
      poll_interval_seconds: 1,
      backfill_hours: 24,
      trust_tier: "exchange",
    });
    await postJson(`http://127.0.0.1:${worldInputPort}/v1/internal/world-input/sources`, {
      key: "fed-calendar",
      adapter: "http_json_calendar",
      url: `http://127.0.0.1:${feedPort}/world-input/fed-calendar`,
      poll_interval_seconds: 1,
      backfill_hours: 24,
      trust_tier: "official",
    });
    await postJson(`http://127.0.0.1:${worldInputPort}/v1/internal/world-input/sources`, {
      key: "x-recent",
      adapter: "x_api_recent_search",
      url: `http://127.0.0.1:${feedPort}/world-input/x`,
      poll_interval_seconds: 1,
      trust_tier: "curated",
      query: "btc OR fed",
    });
    await postJson(`http://127.0.0.1:${worldInputPort}/v1/internal/world-input/sources`, {
      key: "reddit-economy",
      adapter: "reddit_api_subreddit_new",
      url: `http://127.0.0.1:${feedPort}/world-input/reddit`,
      poll_interval_seconds: 1,
      trust_tier: "curated",
      subreddit: "economy",
    });
    await postJson(`http://127.0.0.1:${worldInputPort}/v1/internal/world-input/sources`, {
      key: "news-rss",
      adapter: "news_rss",
      url: `http://127.0.0.1:${feedPort}/world-input/rss`,
      poll_interval_seconds: 1,
      trust_tier: "curated",
    });

    await waitForCondition("registered world-input sources", async () => {
      const sources = (await waitForJson(
        `http://127.0.0.1:${worldInputPort}/v1/internal/world-input/sources?limit=20`,
      )) as {
        items: Array<{ key: string; adapter: string }>;
      };
      const keys = new Set(sources.items.map((entry) => entry.key));
      return (
        keys.has("btc-price") &&
        keys.has("fed-calendar") &&
        keys.has("x-recent") &&
        keys.has("reddit-economy") &&
        keys.has("news-rss")
      );
    });

    await waitForCondition("world signals", async () => {
      const signals = (await waitForJson(`http://127.0.0.1:${worldInputPort}/v1/internal/world-signals`)) as {
        items: Array<{ source_id: string; source_adapter: string }>;
      };
      const adapters = new Set(signals.items.map((entry) => entry.source_adapter));
      return (
        signals.items.length >= 5 &&
        adapters.has("http_json_price") &&
        adapters.has("http_json_calendar") &&
        adapters.has("x_api_recent_search") &&
        adapters.has("reddit_api_subreddit_new") &&
        adapters.has("news_rss")
      );
    });

    await waitForCondition("simulation run", async () => {
      const runs = (await waitForJson(`http://127.0.0.1:${orchestratorPort}/v1/internal/simulation-runs`)) as {
        items: Array<{ status: string }>;
      };
      return runs.items.length >= 1;
    });

    await waitForCondition("world-state proposals", async () => {
      const proposals = (await waitForJson(
        `http://127.0.0.1:${worldModelAlphaPort}/v1/internal/world-state-proposals`,
      )) as {
        items: Array<{ agent_id: string }>;
      };
      return proposals.items.length >= 2;
    });

    await waitForCondition("direct belief proposals", async () => {
      const beliefs = (await waitForJson(
        `http://127.0.0.1:${worldModelAlphaPort}/v1/internal/world-model-hypotheses`,
      )) as {
        items: Array<{ agent_id: string }>;
      };
      return beliefs.items.length >= 2;
    });

    await waitForCondition("scenario paths", async () => {
      const paths = (await waitForJson(`http://127.0.0.1:${scenarioBasePort}/v1/internal/scenario-paths`)) as {
        items: Array<{ label: string }>;
      };
      const labels = new Set(paths.items.map((entry) => entry.label));
      return paths.items.length >= 3 && labels.has("base") && labels.has("bull") && labels.has("bear");
    });

    await waitForCondition("synthesized beliefs", async () => {
      const beliefs = (await waitForJson(`http://127.0.0.1:${synthesisPort}/v1/internal/synthesized-beliefs`)) as {
        items: Array<{ status: string }>;
      };
      return beliefs.items.length >= 2;
    });

    const liveRun = (
      await dbPool.query<{ id: string }>(
        `
          SELECT id
          FROM simulation_runs
          ORDER BY started_at DESC, id DESC
          LIMIT 1
        `,
      )
    ).rows[0];
    if (!liveRun?.id) {
      throw new Error("Expected at least one simulation run for approval tranche");
    }

    const invalidApprovalBeliefId = "approval-invalid-belief-live-test";
    const invalidApprovalBeliefTitle = "Approval parity invalid belief";
    await dbPool.query(
      `
        INSERT INTO synthesized_beliefs (
          id,
          run_id,
          agent_id,
          belief_dedupe_key,
          parent_hypothesis_ids,
          agreement_score,
          disagreement_score,
          confidence_score,
          conflict_notes,
          hypothesis,
          status,
          suppression_reason,
          linked_proposal_id,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          'approval-test-seed',
          $3,
          $4::jsonb,
          0.91,
          0.07,
          0.88,
          NULL,
          $5::jsonb,
          'new',
          NULL,
          NULL,
          NOW(),
          NOW()
        )
        ON CONFLICT (run_id, agent_id, belief_dedupe_key) DO NOTHING
      `,
      [
        invalidApprovalBeliefId,
        liveRun.id,
        "approval-invalid-dedupe-key",
        JSON.stringify(["approval-invalid-parent"]),
        JSON.stringify({
          id: invalidApprovalBeliefId,
          run_id: liveRun.id,
          agent_id: "approval-test-seed",
          parent_ids: ["approval-invalid-parent"],
          hypothesis_kind: "price_threshold",
          category: "macro",
          subject: invalidApprovalBeliefTitle,
          predicate: "price_threshold",
          target_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          confidence_score: 0.88,
          reasoning_summary: "Intentional invalid belief for approval quarantine testing.",
          source_signal_ids: ["approval-invalid-signal"],
          machine_resolvable: true,
          dedupe_key: "approval-invalid-dedupe-key",
          created_at: new Date().toISOString(),
        }),
      ],
    );

    await waitForCondition("approval quorum cases", async () => {
      const cases = (await waitForJson(
        `http://127.0.0.1:${approvalAlphaPort}/v1/internal/listing-approval-cases?limit=20`,
      )) as {
        items: Array<{ belief_id: string; status: string; linked_proposal_id?: string | null }>;
      };
      return (
        cases.items.some((entry) => entry.status === "approved" || entry.status === "proposed") &&
        cases.items.some((entry) => entry.belief_id === invalidApprovalBeliefId && entry.status === "quarantined")
      );
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
    if (proposals.items.some((proposal) => proposal.title === invalidApprovalBeliefTitle)) {
      throw new Error(`Invalid belief was published unexpectedly: ${JSON.stringify(proposals.items)}`);
    }

    const approvalCases = (await waitForJson(
      `http://127.0.0.1:${approvalAlphaPort}/v1/internal/listing-approval-cases?limit=50`,
    )) as {
      items: Array<{ belief_id: string; status: string; linked_proposal_id?: string | null }>;
    };
    const approvedCases = approvalCases.items.filter((entry) => entry.status === "approved" || entry.status === "proposed");
    if (approvedCases.length === 0) {
      throw new Error(`Expected at least one approved/proposed approval case: ${JSON.stringify(approvalCases.items)}`);
    }
    const invalidApprovalCase = approvalCases.items.find((entry) => entry.belief_id === invalidApprovalBeliefId);
    if (!invalidApprovalCase || invalidApprovalCase.status !== "quarantined") {
      throw new Error(`Invalid belief was not quarantined: ${JSON.stringify(approvalCases.items)}`);
    }

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

    for (const process of [
      "proposal-agent",
      "synthesis-agent",
      "scenario-agent-base",
      "scenario-agent-bull",
      "scenario-agent-bear",
      "world-model-alpha",
      "world-model-beta",
      "simulation-orchestrator",
      "world-input",
    ]) {
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
    await dbPool.end().catch(() => undefined);
    await rm(databaseDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
