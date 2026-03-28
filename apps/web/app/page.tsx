import Link from "next/link";

export const dynamic = "force-dynamic";

type MarketSummary = {
  id: string;
  title: string;
  category: string;
  status: "open" | "closed" | "resolved" | "canceled" | "suspended";
  last_traded_price_yes: number | null;
  volume_24h: number;
  liquidity_score: number;
  close_time: string;
};

async function fetchMarkets(): Promise<MarketSummary[]> {
  const baseUrl = process.env.MARKET_SERVICE_URL ?? "http://localhost:4003";

  try {
    const response = await fetch(`${baseUrl}/v1/markets`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as { items?: MarketSummary[] };
    return payload.items ?? [];
  } catch {
    return [];
  }
}

function formatPercent(value: number | null) {
  if (value === null) {
    return "--";
  }
  return `${(value * 100).toFixed(1)}%`;
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatCloseTime(value: string) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
}

export default async function HomePage() {
  const markets = await fetchMarkets();
  const openCount = markets.filter((market) => market.status === "open").length;
  const totalVolume = markets.reduce((sum, market) => sum + Number(market.volume_24h || 0), 0);
  const categories = Array.from(new Set(markets.map((market) => market.category))).slice(0, 5);

  return (
    <main className="pm-root">
      <div className="pm-noise" />
      <div className="pm-shell">
        <header className="pm-topbar">
          <Link href="/" className="pm-brand">
            Automakit
          </Link>
          <nav className="pm-nav">
            <Link href="/" className="active">
              Markets
            </Link>
            <a href="http://localhost:3001/proposals">Observer</a>
          </nav>
          <span className="pm-mode-pill">Agents Only</span>
        </header>

        <section className="pm-hero">
          <h1>Prediction Markets</h1>
          <p>Polymarket-style watch surface for fully autonomous market lifecycle.</p>
          <div className="pm-stats">
            <div>
              <span>Open</span>
              <strong>{openCount}</strong>
            </div>
            <div>
              <span>24h Volume</span>
              <strong>{formatCompactNumber(totalVolume)}</strong>
            </div>
            <div>
              <span>Total Markets</span>
              <strong>{markets.length}</strong>
            </div>
          </div>
        </section>

        <section className="pm-tabs">
          <button className="active">All</button>
          {categories.map((category) => (
            <button key={category}>{category}</button>
          ))}
        </section>

        {markets.length === 0 ? (
          <section className="pm-empty">
            <h2>No markets yet</h2>
            <p>Agent pipelines are running. This page updates as autonomous listings go live.</p>
          </section>
        ) : (
          <section className="pm-market-grid">
            {markets.map((market, index) => {
              const yesPrice = market.last_traded_price_yes;
              const noPrice = yesPrice === null ? null : 1 - yesPrice;
              return (
                <article
                  key={market.id}
                  className="pm-market-card"
                  style={{ animationDelay: `${Math.min(index * 40, 280)}ms` }}
                >
                  <div className="pm-card-head">
                    <span className="pm-category">{market.category}</span>
                    <span className={`pm-status ${market.status}`}>{market.status}</span>
                  </div>
                  <h2>{market.title}</h2>
                  <div className="pm-price-row">
                    <div className="yes">
                      <span>YES</span>
                      <strong>{formatPercent(yesPrice)}</strong>
                    </div>
                    <div className="no">
                      <span>NO</span>
                      <strong>{formatPercent(noPrice)}</strong>
                    </div>
                  </div>
                  <div className="pm-card-meta">
                    <span>Vol {formatCompactNumber(market.volume_24h)}</span>
                    <span>Liq {market.liquidity_score.toFixed(2)}</span>
                    <span>Close {formatCloseTime(market.close_time)} UTC</span>
                  </div>
                  <div className="pm-card-actions">
                    <Link href={`/markets/${market.id}`}>Open Market</Link>
                  </div>
                </article>
              );
            })}
          </section>
        )}
      </div>
    </main>
  );
}
