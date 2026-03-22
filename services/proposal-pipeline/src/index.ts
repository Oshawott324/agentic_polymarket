import { randomUUID } from "node:crypto";
import Fastify from "fastify";

type Proposal = {
  id: string;
  proposer_agent_id: string;
  title: string;
  category: string;
  close_time: string;
  resolution_criteria: string;
  source_of_truth_url: string;
  dedupe_key: string;
  origin: "agent" | "automation";
  signal_source_id?: string;
  signal_source_type?: "calendar" | "news" | "agent";
  status: "queued" | "published" | "suppressed";
  confidence_score: number;
  observation_count: number;
  autonomy_note: string;
  linked_market_id?: string;
  created_at: string;
};

const port = Number(process.env.PROPOSAL_PIPELINE_PORT ?? 4005);
const app = Fastify({ logger: true });
const proposals = new Map<string, Proposal>();
const proposalsByDedupeKey = new Map<string, Proposal>();
const marketServiceUrl = process.env.MARKET_SERVICE_URL ?? "http://localhost:4003";

app.get("/health", async () => ({ service: "proposal-pipeline", status: "ok" }));

function scoreProposal(input: {
  category?: string;
  title?: string;
  source_of_truth_url?: string;
  signal_source_type?: "calendar" | "news" | "agent";
}): { confidenceScore: number; status: Proposal["status"]; autonomyNote: string } {
  if (!input.title || !input.source_of_truth_url) {
    return {
      confidenceScore: 0,
      status: "suppressed" as const,
      autonomyNote: "Missing required title or source of truth.",
    };
  }

  let confidenceScore = 0.55;
  if (input.signal_source_type === "calendar") {
    confidenceScore += 0.2;
  }
  if (input.signal_source_type === "agent") {
    confidenceScore += 0.1;
  }
  if (input.signal_source_type === "news") {
    confidenceScore -= 0.05;
  }
  if (/federalreserve|cmegroup|sec|treasury/i.test(input.source_of_truth_url)) {
    confidenceScore += 0.12;
  }
  if (input.category === "crypto" || input.category === "macro") {
    confidenceScore += 0.05;
  }

  const status: Proposal["status"] =
    confidenceScore >= 0.8 ? "published" : confidenceScore >= 0.45 ? "queued" : "suppressed";
  const autonomyNote =
    status === "published"
      ? "Published automatically because confidence exceeded the autonomous publication threshold."
      : status === "queued"
        ? "Queued for autonomous republication once repeated signals increase confidence."
        : "Suppressed automatically because confidence was too low.";

  return {
    confidenceScore,
    status,
    autonomyNote,
  };
}

async function publishMarketFromProposal(proposal: Proposal) {
  const response = await fetch(`${marketServiceUrl}/v1/internal/markets`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      proposal_id: proposal.id,
      title: proposal.title,
      category: proposal.category,
      close_time: proposal.close_time,
      resolution_criteria: proposal.resolution_criteria,
      source_of_truth_url: proposal.source_of_truth_url,
    }),
  });

  if (!response.ok) {
    throw new Error(`market publication failed with ${response.status}`);
  }

  const payload = (await response.json()) as { id?: string };
  return payload.id ?? proposal.id;
}

async function maybePublishQueuedProposal(proposal: Proposal) {
  if (proposal.status !== "queued") {
    return;
  }

  const adjustedConfidence = Math.min(1, proposal.confidence_score + (proposal.observation_count - 1) * 0.12);
  proposal.confidence_score = adjustedConfidence;

  if (adjustedConfidence < 0.8) {
    proposal.autonomy_note =
      "Queued for autonomous republication until repeated signals raise confidence above the publication threshold.";
    return;
  }

  try {
    proposal.linked_market_id = await publishMarketFromProposal(proposal);
    proposal.status = "published";
    proposal.autonomy_note =
      "Published automatically after repeated signal confirmations raised confidence above the publication threshold.";
  } catch (error) {
    proposal.status = "suppressed";
    proposal.autonomy_note = `Suppressed because market publication failed: ${String(error)}`;
  }
}

app.post("/v1/market-proposals", async (request, reply) => {
  const body = request.body as {
    proposer_agent_id?: string;
    title?: string;
    category?: string;
    close_time?: string;
    resolution_criteria?: string;
    source_of_truth_url?: string;
    dedupe_key?: string;
    origin?: "agent" | "automation";
    signal_source_id?: string;
    signal_source_type?: "calendar" | "news" | "agent";
  };

  const dedupeKey =
    body.dedupe_key ??
    `${body.category ?? "uncategorized"}:${body.title ?? "Untitled proposal"}:${body.close_time ?? ""}`;
  const existing = proposalsByDedupeKey.get(dedupeKey);
  if (existing) {
    existing.observation_count += 1;
    await maybePublishQueuedProposal(existing);
    return {
      ...existing,
      deduped: true,
    };
  }

  const decision = scoreProposal(body);

  const proposal: Proposal = {
    id: randomUUID(),
    proposer_agent_id: body.proposer_agent_id ?? "seed-agent",
    title: body.title ?? "Untitled proposal",
    category: body.category ?? "uncategorized",
    close_time: body.close_time ?? new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
    resolution_criteria: body.resolution_criteria ?? "TBD",
    source_of_truth_url: body.source_of_truth_url ?? "https://example.com",
    dedupe_key: dedupeKey,
    origin: body.origin ?? "agent",
    signal_source_id: body.signal_source_id,
    signal_source_type: body.signal_source_type,
    status: decision.status,
    confidence_score: decision.confidenceScore,
    observation_count: 1,
    autonomy_note: decision.autonomyNote,
    created_at: new Date().toISOString(),
  };

  if (proposal.status === "published") {
    try {
      proposal.linked_market_id = await publishMarketFromProposal(proposal);
    } catch (error) {
      proposal.status = "suppressed";
      proposal.autonomy_note = `Suppressed because market publication failed: ${String(error)}`;
    }
  }

  proposals.set(proposal.id, proposal);
  proposalsByDedupeKey.set(proposal.dedupe_key, proposal);
  reply.code(201);
  return {
    ...proposal,
    deduped: false,
  };
});

app.get("/v1/market-proposals/:proposalId", async (request, reply) => {
  const proposalId = (request.params as { proposalId: string }).proposalId;
  const proposal = proposals.get(proposalId);
  if (!proposal) {
    reply.code(404);
    return { error: "proposal_not_found" };
  }
  return proposal;
});

app.get("/v1/proposals", async () => ({
  items: [...proposals.values()],
}));

app.listen({ port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
