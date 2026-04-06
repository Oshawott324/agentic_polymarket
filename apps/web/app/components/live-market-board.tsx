"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

export type MarketSummary = {
  id: string;
  title: string;
  category: string;
  status: "open" | "closed" | "resolved" | "canceled" | "suspended";
  last_traded_price_yes: number | null;
  volume_24h: number;
  liquidity_score: number;
  close_time: string;
};

type StreamSnapshotMessage = {
  type: "snapshot";
  channel: "market.snapshot";
  payload: MarketSummary[];
};

type StreamEventMessage = {
  type: "event";
  channel: "market.snapshot" | "trade.fill" | "resolution.update";
  payload: Record<string, unknown>;
};

type StreamMessage = StreamSnapshotMessage | StreamEventMessage;

function formatPercent(value: number | null) {
  if (value === null) {
    return "--";
  }
  return `${(value * 100).toFixed(1)}%`;
}

function formatCents(value: number | null) {
  if (value === null) {
    return "--";
  }
  return `${Math.round(value * 100)}¢`;
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

function upsertMarket(markets: MarketSummary[], candidate: MarketSummary) {
  const index = markets.findIndex((market) => market.id === candidate.id);
  if (index === -1) {
    return [...markets, candidate].sort((left, right) => left.close_time.localeCompare(right.close_time));
  }
  const next = [...markets];
  next[index] = { ...next[index], ...candidate };
  return next;
}

export function LiveMarketBoard({ initialMarkets }: { initialMarkets: MarketSummary[] }) {
  const router = useRouter();
  const [markets, setMarkets] = useState<MarketSummary[]>(initialMarkets);
  const [streamState, setStreamState] = useState<"live" | "connecting" | "offline">("connecting");
  const [activeCategory, setActiveCategory] = useState<string>("All");
  const [query, setQuery] = useState<string>("");
  const reconnectTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    setMarkets((current) => {
      if (initialMarkets.length === 0 && current.length > 0) {
        return current;
      }
      return initialMarkets;
    });
  }, [initialMarkets]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    const wsBase = process.env.NEXT_PUBLIC_STREAM_WS_URL ?? "ws://127.0.0.1:4007/v1/stream/ws";
    const streamToken = process.env.NEXT_PUBLIC_STREAM_TOKEN ?? "";

    const connect = () => {
      if (disposed) {
        return;
      }
      setStreamState("connecting");
      const streamUrl = streamToken
        ? `${wsBase}${wsBase.includes("?") ? "&" : "?"}token=${encodeURIComponent(streamToken)}`
        : wsBase;

      socket = new WebSocket(streamUrl);

      socket.onopen = () => {
        if (!socket) {
          return;
        }
        setStreamState("live");
        socket.send(
          JSON.stringify({
            type: "subscribe",
            channels: ["market.snapshot", "trade.fill", "resolution.update"],
            snapshot: true,
          }),
        );
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as StreamMessage;
          if (message.type === "snapshot" && message.channel === "market.snapshot" && Array.isArray(message.payload)) {
            setMarkets(message.payload);
            return;
          }
          if (message.type !== "event" || !message.payload || typeof message.payload !== "object") {
            return;
          }

          if (message.channel === "market.snapshot") {
            const market = message.payload as MarketSummary;
            if (typeof market.id === "string") {
              setMarkets((current) => upsertMarket(current, market));
            }
            return;
          }

          if (message.channel === "resolution.update") {
            const marketId = message.payload.market_id;
            const status = message.payload.status;
            if (typeof marketId === "string" && typeof status === "string") {
              setMarkets((current) =>
                current.map((market) => (market.id === marketId ? { ...market, status: status as MarketSummary["status"] } : market)),
              );
            }
            return;
          }

          if (message.channel === "trade.fill") {
            const marketId = message.payload.market_id;
            const outcome = message.payload.outcome;
            const price = Number(message.payload.price);
            const size = Number(message.payload.size ?? 0);
            if (typeof marketId === "string" && Number.isFinite(price) && Number.isFinite(size)) {
              setMarkets((current) =>
                current.map((market) => {
                  if (market.id !== marketId) {
                    return market;
                  }
                  const yesPrice = outcome === "NO" ? 1 - price : price;
                  return {
                    ...market,
                    last_traded_price_yes: yesPrice,
                    volume_24h: market.volume_24h + size,
                  };
                }),
              );
            }
          }
        } catch {
          // ignore malformed stream payload
        }
      };

      socket.onerror = () => {
        setStreamState("offline");
      };

      socket.onclose = () => {
        setStreamState("offline");
        if (!disposed) {
          reconnectTimer.current = setTimeout(connect, 1800);
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      if (socket && socket.readyState <= WebSocket.OPEN) {
        socket.close();
      }
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      router.refresh();
    }, 15000);

    return () => {
      clearInterval(interval);
    };
  }, [router]);

  const openCount = useMemo(() => markets.filter((market) => market.status === "open").length, [markets]);
  const totalVolume = useMemo(() => markets.reduce((sum, market) => sum + Number(market.volume_24h || 0), 0), [markets]);
  const categories = useMemo(
    () => Array.from(new Set(markets.map((market) => market.category))).slice(0, 5),
    [markets],
  );
  const tabs = useMemo(() => ["All", ...categories], [categories]);
  const filteredMarkets = useMemo(() => {
    return markets.filter((market) => {
      const passCategory = activeCategory === "All" || market.category === activeCategory;
      const passQuery = query.trim().length === 0 || market.title.toLowerCase().includes(query.toLowerCase());
      return passCategory && passQuery;
    });
  }, [activeCategory, markets, query]);

  useEffect(() => {
    if (activeCategory !== "All" && !categories.includes(activeCategory)) {
      setActiveCategory("All");
    }
  }, [activeCategory, categories]);

  return (
    <main className="pm-root">
      <div className="pm-shell">
        <header className="pm-topbar">
          <div className="pm-brand-wrap">
            <Link href="/" className="pm-brand">
              <span className="pm-brand-mark">A</span>
              <span>Automakit</span>
            </Link>
            <nav className="pm-nav">
              <Link href="/" className="active">
                Explore
              </Link>
              <Link href="/">Live</Link>
              <Link href="/">Resolved</Link>
            </nav>
          </div>
          <div className="pm-topbar-right">
            <label className="pm-search">
              <input
                aria-label="Search markets"
                placeholder="Search markets"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <a className="pm-observer-link" href="http://localhost:3001/proposals">
              Observer
            </a>
            <span className={`pm-mode-pill ${streamState}`}>
              {streamState === "live" ? "Live" : streamState === "connecting" ? "Syncing" : "Offline"}
            </span>
          </div>
        </header>

        <section className="pm-hero">
          <div>
            <h1>Automated Prediction Markets</h1>
            <p>Agent-run market generation, pricing, and resolution in a watch-only exchange surface.</p>
          </div>
          <div className="pm-stats">
            <div>
              <span>Open Markets</span>
              <strong>{openCount}</strong>
            </div>
            <div>
              <span>24h Volume</span>
              <strong>{formatCompactNumber(totalVolume)}</strong>
            </div>
            <div>
              <span>Listed Markets</span>
              <strong>{markets.length}</strong>
            </div>
          </div>
        </section>

        <section className="pm-tabs">
          {tabs.map((tab) => (
            <button
              key={tab}
              className={activeCategory === tab ? "active" : ""}
              type="button"
              onClick={() => setActiveCategory(tab)}
            >
              {tab}
            </button>
          ))}
        </section>

        {filteredMarkets.length === 0 ? (
          <section className="pm-empty">
            <h2>No matching markets</h2>
            <p>Agents are still publishing. Try a broader search or switch category.</p>
          </section>
        ) : (
          <section className="pm-market-grid">
            {filteredMarkets.map((market) => {
              const yesPrice = market.last_traded_price_yes;
              const noPrice = yesPrice === null ? null : 1 - yesPrice;
              const yesWidth = yesPrice === null ? 50 : Math.min(95, Math.max(5, yesPrice * 100));

              return (
                <article key={market.id} className="pm-market-card">
                  <div className="pm-card-head">
                    <span className="pm-category">{market.category}</span>
                    <span className={`pm-status ${market.status}`}>{market.status}</span>
                  </div>
                  <Link href={`/markets/${market.id}`} className="pm-card-title-link">
                    <h2>{market.title}</h2>
                  </Link>
                  <p className="pm-close-time">Closes {formatCloseTime(market.close_time)} UTC</p>
                  <div className="pm-prob-track" aria-hidden>
                    <span style={{ width: `${yesWidth}%` }} />
                  </div>
                  <div className="pm-price-row">
                    <Link className="pm-quote yes" href={`/markets/${market.id}`}>
                      <span>Yes</span>
                      <strong>{formatCents(yesPrice)}</strong>
                    </Link>
                    <Link className="pm-quote no" href={`/markets/${market.id}`}>
                      <span>No</span>
                      <strong>{formatCents(noPrice)}</strong>
                    </Link>
                  </div>
                  <div className="pm-card-meta">
                    <span>Vol {formatCompactNumber(market.volume_24h)}</span>
                    <span>Liq {market.liquidity_score.toFixed(2)}</span>
                    <span>Mid {formatPercent(yesPrice)}</span>
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
