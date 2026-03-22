import { randomUUID } from "node:crypto";
import Fastify from "fastify";

type Outcome = "YES" | "NO" | "CANCELED";
type ResolutionStatus = "pending_evidence" | "finalizing" | "finalized" | "quarantined";

type ResolutionEvidence = {
  id: string;
  market_id: string;
  submitter_agent_id: string;
  evidence_type: "url" | "text" | "file";
  claimed_outcome: Outcome;
  summary: string;
  source_url: string;
  observed_at: string;
  observed_value?: string;
  created_at: string;
};

type ResolutionCase = {
  market_id: string;
  status: ResolutionStatus;
  draft_outcome: Outcome | null;
  final_outcome: Outcome | null;
  canonical_source_url: string | null;
  evidence: ResolutionEvidence[];
  quorum_threshold: number;
  last_updated_at: string;
};

const port = Number(process.env.RESOLUTION_SERVICE_PORT ?? 4006);
const app = Fastify({ logger: true });
const resolutionCases = new Map<string, ResolutionCase>();
const marketServiceUrl = process.env.MARKET_SERVICE_URL ?? "http://localhost:4003";
const quorumThreshold = Number(process.env.RESOLUTION_QUORUM_THRESHOLD ?? 2);

app.get("/health", async () => ({ service: "resolution-service", status: "ok" }));

function normalizeHostname(url: string) {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

function isAllowedSource(candidateUrl: string, canonicalUrl: string) {
  const canonicalHost = normalizeHostname(canonicalUrl);
  const candidateHost = normalizeHostname(candidateUrl);
  return candidateHost === canonicalHost || candidateHost.endsWith(`.${canonicalHost}`);
}

async function fetchMarketResolutionSource(marketId: string) {
  const response = await fetch(`${marketServiceUrl}/v1/markets/${marketId}`);
  if (!response.ok) {
    throw new Error(`market lookup failed with ${response.status}`);
  }

  const payload = (await response.json()) as { resolution_source?: string };
  if (!payload.resolution_source) {
    throw new Error("market resolution source missing");
  }

  return payload.resolution_source;
}

function updateResolutionCaseState(resolutionCase: ResolutionCase) {
  const evidenceCount = resolutionCase.evidence.length;
  if (evidenceCount === 0) {
    resolutionCase.status = "pending_evidence";
    resolutionCase.draft_outcome = null;
    resolutionCase.final_outcome = null;
    resolutionCase.last_updated_at = new Date().toISOString();
    return;
  }

  const counts = new Map<Outcome, number>();
  for (const evidence of resolutionCase.evidence) {
    counts.set(evidence.claimed_outcome, (counts.get(evidence.claimed_outcome) ?? 0) + 1);
  }

  if (counts.size > 1) {
    resolutionCase.status = "quarantined";
    resolutionCase.draft_outcome = null;
    resolutionCase.final_outcome = null;
    resolutionCase.last_updated_at = new Date().toISOString();
    return;
  }

  const [[outcome, count]] = [...counts.entries()];
  resolutionCase.draft_outcome = outcome;

  if (count >= resolutionCase.quorum_threshold) {
    resolutionCase.status = "finalized";
    resolutionCase.final_outcome = outcome;
    resolutionCase.last_updated_at = new Date().toISOString();
    return;
  }

  resolutionCase.status = "finalizing";
  resolutionCase.final_outcome = null;
  resolutionCase.last_updated_at = new Date().toISOString();
}

app.post("/v1/resolution-evidence", async (request, reply) => {
  const body = request.body as {
    market_id?: string;
    evidence_type?: "url" | "text" | "file";
    claimed_outcome?: Outcome;
    summary?: string;
    source_url?: string;
    observed_at?: string;
    observed_value?: string;
  };
  const submitterAgentId = request.headers["x-agent-id"];
  if (typeof submitterAgentId !== "string" || submitterAgentId.length === 0) {
    reply.code(400);
    return { error: "missing_agent_identity" };
  }

  const marketId = body.market_id ?? "unknown-market";
  const claimedOutcome = body.claimed_outcome;
  if (!claimedOutcome || !body.source_url || !body.observed_at || !body.summary) {
    reply.code(400);
    return { error: "invalid_resolution_evidence" };
  }

  let canonicalSourceUrl: string;
  try {
    canonicalSourceUrl = await fetchMarketResolutionSource(marketId);
  } catch (error) {
    reply.code(404);
    return { error: `unknown_market_resolution_source:${String(error)}` };
  }

  try {
    if (!isAllowedSource(body.source_url, canonicalSourceUrl)) {
      reply.code(422);
      return { error: "source_url_not_allowed_for_market" };
    }
  } catch {
    reply.code(400);
    return { error: "invalid_source_url" };
  }

  const resolutionCase =
    resolutionCases.get(marketId) ??
    {
      market_id: marketId,
      status: "pending_evidence",
      draft_outcome: null,
      final_outcome: null,
      canonical_source_url: canonicalSourceUrl,
      evidence: [],
      quorum_threshold: quorumThreshold,
      last_updated_at: new Date().toISOString(),
    };

  if (resolutionCase.status === "finalized") {
    reply.code(409);
    return { error: "resolution_case_already_finalized" };
  }

  const duplicateAgentEvidence = resolutionCase.evidence.find(
    (entry) => entry.submitter_agent_id === submitterAgentId,
  );
  if (duplicateAgentEvidence) {
    reply.code(409);
    return { error: "duplicate_resolver_agent" };
  }

  const evidence: ResolutionEvidence = {
    id: randomUUID(),
    market_id: marketId,
    submitter_agent_id: submitterAgentId,
    evidence_type: body.evidence_type ?? "text",
    claimed_outcome: claimedOutcome,
    summary: body.summary,
    source_url: body.source_url,
    observed_at: body.observed_at,
    observed_value: body.observed_value,
    created_at: new Date().toISOString(),
  };

  resolutionCase.evidence.push(evidence);
  updateResolutionCaseState(resolutionCase);
  resolutionCases.set(marketId, resolutionCase);
  reply.code(201);
  return evidence;
});

app.get("/v1/resolutions", async () => ({
  items: [...resolutionCases.values()],
}));

app.listen({ port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
