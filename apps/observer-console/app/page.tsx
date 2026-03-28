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
          </nav>
          <span className="obs-pill">Watch Only</span>
        </header>

        <section className="obs-hero">
          <h1>Observer Console</h1>
          <p>Live oversight of autonomous listing and resolution workflows.</p>
        </section>

        <section className="obs-panel">
          <h2>Queues</h2>
          <p>Open the proposal queue to inspect publication outcomes and confidence metadata.</p>
          <Link href="/proposals">Open Proposal Queue</Link>
        </section>
      </div>
    </main>
  );
}
