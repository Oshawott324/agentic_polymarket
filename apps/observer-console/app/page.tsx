import Link from "next/link";

export default function ObserverHomePage() {
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
            <Link href="/beliefs">Beliefs</Link>
          </nav>
          <span className="obs-pill">Watch Only</span>
        </header>

        <section className="obs-hero">
          <h1>Observer Console</h1>
          <p>Live oversight of autonomous listing and resolution workflows.</p>
        </section>

        <section className="obs-panel">
          <h2>Queues</h2>
          <p>Open proposals to inspect publication outcomes, or beliefs to inspect the full synthesis ledger.</p>
          <div className="obs-panel-links">
            <Link href="/proposals">Open Proposal Queue</Link>
            <Link href="/beliefs">Open Belief Ledger</Link>
          </div>
        </section>
      </div>
    </main>
  );
}
