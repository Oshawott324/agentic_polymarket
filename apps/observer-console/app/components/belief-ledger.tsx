"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

export type SynthesizedBelief = {
  id: string;
  status: "new" | "ambiguous" | "proposed" | "suppressed";
  agreement_score: number;
  disagreement_score: number;
  confidence_score: number;
  suppression_reason: string | null;
  linked_proposal_id?: string | null;
  created_at?: string;
  updated_at?: string;
  hypothesis: {
    category?: string;
    subject: string;
    predicate: string;
    target_time?: string;
    hypothesis_kind?: string;
    machine_resolvable?: boolean;
    event_case_id?: string | null;
    case_family_key?: string | null;
    publishability_score?: number;
    reasoning_summary?: string;
  };
};

function formatDate(value?: string) {
  if (!value) {
    return "n/a";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
}

export function BeliefLedger({ initialBeliefs }: { initialBeliefs: SynthesizedBelief[] }) {
  const [beliefs, setBeliefs] = useState<SynthesizedBelief[]>(initialBeliefs);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string>(new Date().toISOString());

  useEffect(() => {
    setBeliefs(initialBeliefs);
    setLastUpdatedAt(new Date().toISOString());
  }, [initialBeliefs]);

  useEffect(() => {
    let disposed = false;

    const load = async () => {
      try {
        const response = await fetch("/api/beliefs", {
          cache: "no-store",
        });
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as { items?: SynthesizedBelief[] };
        if (disposed || !Array.isArray(payload.items)) {
          return;
        }
        setBeliefs(payload.items);
        setLastUpdatedAt(new Date().toISOString());
      } catch {
        // keep current snapshot on transient fetch failures
      }
    };

    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      void load();
    }, 15000);

    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, []);

  const counts = useMemo(() => {
    return {
      newCount: beliefs.filter((belief) => belief.status === "new").length,
      proposedCount: beliefs.filter((belief) => belief.status === "proposed").length,
      ambiguousCount: beliefs.filter((belief) => belief.status === "ambiguous").length,
      suppressedCount: beliefs.filter((belief) => belief.status === "suppressed").length,
    };
  }, [beliefs]);

  return (
    <>
      <section className="obs-hero">
        <h1>Belief Ledger</h1>
        <p>All synthesized beliefs, including publishable, ambiguous, and suppressed outcomes.</p>
        <div className="obs-stats">
          <div>
            <span>New</span>
            <strong>{counts.newCount}</strong>
          </div>
          <div>
            <span>Proposed</span>
            <strong>{counts.proposedCount}</strong>
          </div>
          <div>
            <span>Ambiguous</span>
            <strong>{counts.ambiguousCount}</strong>
          </div>
        </div>
        <div className="obs-stats obs-stats-secondary">
          <div>
            <span>Suppressed</span>
            <strong>{counts.suppressedCount}</strong>
          </div>
          <div>
            <span>Total</span>
            <strong>{beliefs.length}</strong>
          </div>
        </div>
        <div className="obs-meta obs-live-meta">
          <span>Auto-refresh 15s</span>
          <span>Last update {formatDate(lastUpdatedAt)}</span>
        </div>
      </section>

      {beliefs.length === 0 ? (
        <section className="obs-panel">
          <h2>No beliefs</h2>
          <p>No synthesized beliefs are currently visible.</p>
        </section>
      ) : (
        <section className="obs-grid">
          {beliefs.map((belief) => (
            <article key={belief.id} className="obs-proposal-card">
              <div className="obs-card-head">
                <span className="obs-category">{belief.hypothesis.category ?? "uncategorized"}</span>
                <span className={`obs-status ${belief.status}`}>{belief.status}</span>
              </div>
              <h2>{belief.hypothesis.subject}</h2>
              <div className="obs-meta">
                <span>Kind {belief.hypothesis.hypothesis_kind ?? "unknown"}</span>
                <span>Confidence {(belief.confidence_score * 100).toFixed(1)}%</span>
                <span>Agreement {(belief.agreement_score * 100).toFixed(1)}%</span>
                <span>Resolvable {belief.hypothesis.machine_resolvable ? "yes" : "no"}</span>
              </div>
              <p>{belief.hypothesis.predicate}</p>
              <div className="obs-belief-details">
                <span>Target {formatDate(belief.hypothesis.target_time)}</span>
                <span>Created {formatDate(belief.created_at)}</span>
                {belief.linked_proposal_id ? (
                  <span>
                    Proposal <Link href={`/proposals#${belief.linked_proposal_id}`}>{belief.linked_proposal_id.slice(0, 8)}</Link>
                  </span>
                ) : null}
                {belief.hypothesis.case_family_key ? (
                  <span>Case {belief.hypothesis.case_family_key.slice(0, 8)}</span>
                ) : null}
              </div>
              {belief.hypothesis.reasoning_summary ? <p>{belief.hypothesis.reasoning_summary}</p> : null}
              {belief.suppression_reason ? (
                <p className="obs-belief-warning">Suppression: {belief.suppression_reason}</p>
              ) : null}
            </article>
          ))}
        </section>
      )}
    </>
  );
}
