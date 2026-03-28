import Link from "next/link";

export const dynamic = "force-dynamic";

type Proposal = {
  id: string;
  category?: string;
  title: string;
  status: "queued" | "published" | "suppressed";
  confidence_score: number;
  autonomy_note: string;
  origin: "agent" | "automation";
  close_time?: string;
  created_at?: string;
};

async function fetchProposals(): Promise<Proposal[]> {
  const baseUrl = process.env.PROPOSAL_PIPELINE_URL ?? "http://localhost:4005";

  try {
    const response = await fetch(`${baseUrl}/v1/proposals`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as { items?: Proposal[] };
    return payload.items ?? [];
  } catch {
    return [];
  }
}

export default async function ProposalQueuePage() {
  const proposals = await fetchProposals();
  const published = proposals.filter((proposal) => proposal.status === "published").length;
  const queued = proposals.filter((proposal) => proposal.status === "queued").length;
  const suppressed = proposals.filter((proposal) => proposal.status === "suppressed").length;

  return (
    <main className="obs-root">
      <div className="obs-noise" />
      <div className="obs-shell">
        <header className="obs-topbar">
          <Link href="/" className="obs-brand">
            Automakit Observer
          </Link>
          <nav className="obs-nav">
            <a href="http://localhost:3000">Markets</a>
            <Link href="/proposals" className="active">
              Proposals
            </Link>
          </nav>
          <span className="obs-pill">Agents Pipeline</span>
        </header>

        <section className="obs-hero">
          <h1>Proposal Queue</h1>
          <p>Listing approval and publication outcomes from the autonomous pipeline.</p>
          <div className="obs-stats">
            <div>
              <span>Published</span>
              <strong>{published}</strong>
            </div>
            <div>
              <span>Queued</span>
              <strong>{queued}</strong>
            </div>
            <div>
              <span>Suppressed</span>
              <strong>{suppressed}</strong>
            </div>
          </div>
        </section>

        {proposals.length === 0 ? (
          <section className="obs-panel">
            <h2>No proposals</h2>
            <p>No autonomous proposals are currently visible.</p>
          </section>
        ) : (
          <section className="obs-grid">
            {proposals.map((proposal) => (
              <article key={proposal.id} className="obs-proposal-card">
                <div className="obs-card-head">
                  <span className="obs-category">{proposal.category ?? "uncategorized"}</span>
                  <span className={`obs-status ${proposal.status}`}>{proposal.status}</span>
                </div>
                <h2>{proposal.title}</h2>
                <div className="obs-meta">
                  <span>Origin {proposal.origin}</span>
                  <span>Confidence {(proposal.confidence_score * 100).toFixed(1)}%</span>
                </div>
                <p>{proposal.autonomy_note}</p>
              </article>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}
