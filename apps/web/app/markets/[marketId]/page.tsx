import Link from "next/link";

export const dynamic = "force-dynamic";

type MarketDetail = {
  id: string;
  title: string;
  last_traded_price_yes: number | null;
  volume_24h: number;
  rules: string;
  orderbook: {
    yes_bids: Array<{ price: number; size: number }>;
    yes_asks: Array<{ price: number; size: number }>;
    no_bids: Array<{ price: number; size: number }>;
    no_asks: Array<{ price: number; size: number }>;
  };
  close_time: string;
  status: "open" | "closed" | "resolved" | "canceled" | "suspended";
  category: string;
  resolution_source: string;
};

async function fetchMarket(marketId: string): Promise<MarketDetail | null> {
  const baseUrl = process.env.MARKET_SERVICE_URL ?? "http://localhost:4003";

  try {
    const response = await fetch(`${baseUrl}/v1/markets/${marketId}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as MarketDetail;
  } catch {
    return null;
  }
}

export default async function MarketPage({
  params,
}: {
  params: Promise<{ marketId: string }>;
}) {
  const { marketId } = await params;
  const market = await fetchMarket(marketId);
  const yesPrice = market?.last_traded_price_yes ?? null;
  const noPrice = yesPrice === null ? null : 1 - yesPrice;

  function formatPercent(value: number | null) {
    if (value === null) {
      return "--";
    }
    return `${(value * 100).toFixed(1)}%`;
  }

  function formatNumber(value: number) {
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 2,
    }).format(value);
  }

  function renderBookRows(side: Array<{ price: number; size: number }>) {
    if (side.length === 0) {
      return (
        <tr>
          <td colSpan={2} className="pm-book-empty">
            No depth
          </td>
        </tr>
      );
    }
    return side.slice(0, 6).map((level) => (
      <tr key={`${level.price}-${level.size}`}>
        <td>{formatPercent(level.price)}</td>
        <td>{formatNumber(level.size)}</td>
      </tr>
    ));
  }

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
          <span className="pm-mode-pill">Watch Only</span>
        </header>

        {!market ? (
          <section className="pm-empty">
            <h1>Market Not Found</h1>
            <p>The selected market id is not available.</p>
            <Link href="/">Back to markets</Link>
          </section>
        ) : (
          <>
            <section className="pm-detail-hero">
              <p className="pm-detail-bread">
                <Link href="/">Markets</Link>
                <span>/</span>
                <span>{market.category}</span>
              </p>
              <h1>{market.title}</h1>
              <div className="pm-detail-meta">
                <span className={`pm-status ${market.status}`}>{market.status}</span>
                <span>Close {new Date(market.close_time).toUTCString()}</span>
                <span>Volume {formatNumber(market.volume_24h)}</span>
              </div>
            </section>

            <section className="pm-detail-grid">
              <article className="pm-price-panel">
                <h2>Outcome Prices</h2>
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
                <p className="pm-rules">{market.rules}</p>
                <p className="pm-source">
                  Source:{" "}
                  <a href={market.resolution_source} target="_blank" rel="noreferrer">
                    {market.resolution_source}
                  </a>
                </p>
              </article>

              <article className="pm-ticket">
                <h2>Order Ticket</h2>
                <p>Agent order flow is routed via `agent-gateway` with signed requests.</p>
                <button type="button" disabled>
                  Buy YES (Observer Mode)
                </button>
                <button type="button" disabled>
                  Buy NO (Observer Mode)
                </button>
              </article>
            </section>

            <section className="pm-book-grid">
              <article className="pm-book-card">
                <h3>YES Bids</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Price</th>
                      <th>Size</th>
                    </tr>
                  </thead>
                  <tbody>{renderBookRows(market.orderbook.yes_bids)}</tbody>
                </table>
              </article>
              <article className="pm-book-card">
                <h3>YES Asks</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Price</th>
                      <th>Size</th>
                    </tr>
                  </thead>
                  <tbody>{renderBookRows(market.orderbook.yes_asks)}</tbody>
                </table>
              </article>
              <article className="pm-book-card">
                <h3>NO Bids</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Price</th>
                      <th>Size</th>
                    </tr>
                  </thead>
                  <tbody>{renderBookRows(market.orderbook.no_bids)}</tbody>
                </table>
              </article>
              <article className="pm-book-card">
                <h3>NO Asks</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Price</th>
                      <th>Size</th>
                    </tr>
                  </thead>
                  <tbody>{renderBookRows(market.orderbook.no_asks)}</tbody>
                </table>
              </article>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
