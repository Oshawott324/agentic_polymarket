import { spawn } from "node:child_process";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

type ManagedProcess = {
  name: string;
  child: ReturnType<typeof spawn>;
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

  return { name, child };
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

async function main() {
  const signalPayload = {
    items: [
      {
        sourceId: "btc-price-jun-2026",
        sourceType: "calendar",
        category: "crypto",
        headline: "Will BTC trade above $100k by June 30, 2026?",
        closeTime: "2026-06-30T23:59:59Z",
        resolutionCriteria:
          "Resolve YES if BTC spot trades above 100,000 USD on or before the close time.",
        sourceOfTruthUrl: "https://www.cmegroup.com/",
      },
      {
        sourceId: "fed-cut-jul-2026",
        sourceType: "calendar",
        category: "macro",
        headline: "Will the Fed cut rates before July 31, 2026?",
        closeTime: "2026-07-31T23:59:59Z",
        resolutionCriteria:
          "Resolve YES if the federal funds target range is lowered before the close time.",
        sourceOfTruthUrl: "https://www.federalreserve.gov/",
      },
    ],
  };

  const feedServer = http.createServer((request, response) => {
    if (request.url === "/signals") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(signalPayload));
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => {
    feedServer.listen(4100, "127.0.0.1", () => resolve());
  });

  const processes: ManagedProcess[] = [];
  try {
    processes.push(
      startProcess("market-service", "pnpm", ["--filter", "@agentic-polymarket/market-service", "start"]),
    );
    processes.push(
      startProcess(
        "proposal-pipeline",
        "pnpm",
        ["--filter", "@agentic-polymarket/proposal-pipeline", "start"],
        {
          MARKET_SERVICE_URL: "http://127.0.0.1:4003",
        },
      ),
    );
    processes.push(
      startProcess(
        "resolution-service",
        "pnpm",
        ["--filter", "@agentic-polymarket/resolution-service", "start"],
      ),
    );
    processes.push(
      startProcess(
        "market-creator",
        "pnpm",
        ["--filter", "@agentic-polymarket/market-creator", "start"],
        {
          PROPOSAL_PIPELINE_URL: "http://127.0.0.1:4005",
          MARKET_CREATOR_SIGNAL_FEED_URLS: "http://127.0.0.1:4100/signals",
          MARKET_CREATOR_INTERVAL_MS: "1000",
        },
      ),
    );
    processes.push(
      startProcess(
        "web",
        "pnpm",
        ["--filter", "@agentic-polymarket/web", "start"],
        {
          MARKET_SERVICE_URL: "http://127.0.0.1:4003",
        },
      ),
    );
    processes.push(
      startProcess(
        "observer-console",
        "pnpm",
        ["--filter", "@agentic-polymarket/observer-console", "start"],
        {
          PROPOSAL_PIPELINE_URL: "http://127.0.0.1:4005",
        },
      ),
    );

    await waitForJson("http://127.0.0.1:4003/health");
    await waitForJson("http://127.0.0.1:4005/health");
    await waitForJson("http://127.0.0.1:4006/health");
    await waitForText("http://127.0.0.1:3000", "Markets");
    await waitForText("http://127.0.0.1:3001/proposals", "Proposal Queue");

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

    await waitForText("http://127.0.0.1:3000", "Will BTC trade above $100k by June 30, 2026?");
    await waitForText("http://127.0.0.1:3001/proposals", "Will the Fed cut rates before July 31, 2026?");

    const evidenceResponse = await fetch("http://127.0.0.1:4006/v1/resolution-evidence", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        market_id: markets.items[0].id,
        evidence_type: "text",
        summary: "Outcome YES based on official source.",
      }),
    });

    if (!evidenceResponse.ok) {
      throw new Error(`Resolution evidence submission failed with ${evidenceResponse.status}`);
    }

    const resolutions = (await waitForJson("http://127.0.0.1:4006/v1/resolutions")) as {
      items: Array<{ market_id: string; status: string; final_outcome: string | null }>;
    };
    const resolution = resolutions.items.find((entry) => entry.market_id === markets.items[0].id);
    if (!resolution || resolution.status !== "finalized" || resolution.final_outcome !== "YES") {
      throw new Error(`Unexpected resolution state: ${JSON.stringify(resolutions.items)}`);
    }

    console.log("live-test ok");
  } finally {
    await Promise.all(
      processes.map(
        ({ child }) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null) {
              resolve();
              return;
            }
            child.once("exit", () => resolve());
            child.kill("SIGTERM");
            setTimeout(() => {
              if (child.exitCode === null) {
                child.kill("SIGKILL");
              }
            }, 1000);
          }),
      ),
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
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
