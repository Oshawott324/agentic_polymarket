import { createHash } from "node:crypto";
import type { MarketSignal } from "@automakit/sdk-types";
import { loadSignals } from "./signals.js";

const proposalPipelineUrl = process.env.PROPOSAL_PIPELINE_URL ?? "http://localhost:4005";
const loopIntervalMs = Number(process.env.MARKET_CREATOR_INTERVAL_MS ?? 15_000);
const automationAgentId = process.env.MARKET_CREATOR_AGENT_ID ?? "automation-market-creator";

function dedupeKeyFor(signal: MarketSignal) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sourceId: signal.sourceId,
        headline: signal.headline,
        closeTime: signal.closeTime,
      }),
    )
    .digest("hex");
}

async function submitSignal(signal: MarketSignal) {
  const dedupeKey = dedupeKeyFor(signal);
  const response = await fetch(`${proposalPipelineUrl}/v1/market-proposals`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer automation-worker",
      "idempotency-key": dedupeKey,
    },
    body: JSON.stringify({
      proposer_agent_id: automationAgentId,
      title: signal.headline,
      category: signal.category,
      close_time: signal.closeTime,
      resolution_criteria: signal.resolutionCriteria,
      resolution_spec: signal.resolutionSpec,
      dedupe_key: dedupeKey,
      origin: "automation",
      signal_source_id: signal.sourceId,
      signal_source_type: signal.sourceType,
    }),
  });

  const payload = (await response.json()) as { id?: string; deduped?: boolean; error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `proposal submission failed with ${response.status}`);
  }

  return {
    proposalId: payload.id ?? "unknown",
    deduped: Boolean(payload.deduped),
  };
}

async function waitForProposalPipeline() {
  for (;;) {
    try {
      const response = await fetch(`${proposalPipelineUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {}

    console.log("[market-creator] waiting for proposal-pipeline health");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function runLoop() {
  const signals = await loadSignals();
  console.log(`[market-creator] scanning ${signals.length} signals`);

  for (const signal of signals) {
    try {
      const result = await submitSignal(signal);
      console.log(
        `[market-creator] signal=${signal.sourceId} proposal=${result.proposalId} deduped=${result.deduped}`,
      );
    } catch (error) {
      console.error(`[market-creator] signal=${signal.sourceId} failed`, error);
    }
  }
}

console.log(
  `[market-creator] starting autonomous loop against ${proposalPipelineUrl} every ${loopIntervalMs}ms`,
);

void (async () => {
  await waitForProposalPipeline();
  await runLoop();
  setInterval(() => {
    void runLoop();
  }, loopIntervalMs);
})();
