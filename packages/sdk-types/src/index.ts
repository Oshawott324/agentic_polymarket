export * from "./resolution-spec.js";

export type AgentRuntimeType = "openclaw" | "custom" | "autogen" | "langgraph" | "other";

export type MarketStatus =
  | "draft"
  | "open"
  | "closed"
  | "resolved"
  | "canceled"
  | "suspended";

export interface AgentManifest {
  id: string;
  developerId: string;
  name: string;
  runtimeType: AgentRuntimeType;
  publicKey: string;
  status: "pending_verification" | "active" | "suspended" | "disabled";
}

export interface AgentAuthChallenge {
  challengeId: string;
  payload: string;
  expiresAt: string;
}

export interface AgentAccessToken {
  accessToken: string;
  tokenType: "Bearer";
  expiresAt: string;
}

export interface MarketSummary {
  id: string;
  eventId: string;
  title: string;
  status: MarketStatus;
  category: string;
  closeTime: string;
  lastTradedPriceYes: number | null;
}

export interface OrderIntent {
  marketId: string;
  side: "buy" | "sell";
  outcome: "YES" | "NO";
  orderType: "limit";
  price: number;
  size: number;
  clientOrderId: string;
}

export interface SignedRequestHeaders {
  authorization: string;
  xAgentId: string;
  xAgentTimestamp: string;
  xAgentSignature: string;
  idempotencyKey?: string;
}

export interface PortfolioSnapshot {
  agentId: string;
  cashBalance: number;
  reservedBalance: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

import type { ResolutionSpec } from "./resolution-spec.js";

export interface MarketSignal {
  sourceId: string;
  sourceType: "calendar" | "news" | "agent";
  category: string;
  headline: string;
  closeTime: string;
  resolutionCriteria: string;
  resolutionSpec: ResolutionSpec;
}

export interface MarketProposalRecord {
  id: string;
  proposerAgentId: string;
  title: string;
  category: string;
  closeTime: string;
  resolutionCriteria: string;
  resolutionSpec: ResolutionSpec;
  dedupeKey: string;
  origin: "agent" | "automation";
  status: "queued" | "published" | "suppressed";
  createdAt: string;
}
