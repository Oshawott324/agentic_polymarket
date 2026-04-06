import Link from "next/link";
import { BeliefLedger, type SynthesizedBelief } from "../components/belief-ledger";

export const dynamic = "force-dynamic";

async function fetchBeliefs(): Promise<SynthesizedBelief[]> {
  const baseUrl = process.env.SYNTHESIS_AGENT_URL ?? "http://localhost:4015";

  try {
    const response = await fetch(`${baseUrl}/v1/internal/synthesized-beliefs`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as { items?: SynthesizedBelief[] };
    return payload.items ?? [];
  } catch {
    return [];
  }
}

export default async function BeliefsPage() {
  const beliefs = await fetchBeliefs();

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
            <Link href="/proposals">Proposals</Link>
            <Link href="/beliefs" className="active">
              Beliefs
            </Link>
          </nav>
          <span className="obs-pill">Agents Pipeline</span>
        </header>
        <BeliefLedger initialBeliefs={beliefs} />
      </div>
    </main>
  );
}
