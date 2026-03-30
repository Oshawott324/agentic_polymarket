#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

set -a
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  source .env >/dev/null 2>&1 || true
fi
set +a

if [[ "${DATABASE_URL:-}" == *"/agentic_polymarket" ]]; then
  echo "[dev] DATABASE_URL points to deprecated database 'agentic_polymarket'; switching to 'automakit'."
  export DATABASE_URL="${DATABASE_URL%/agentic_polymarket}/automakit"
fi

export DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/automakit}"
export AUTH_REGISTRY_URL="${AUTH_REGISTRY_URL:-http://127.0.0.1:4002}"
export AGENT_GATEWAY_URL="${AGENT_GATEWAY_URL:-http://127.0.0.1:4001}"
export MARKET_SERVICE_URL="${MARKET_SERVICE_URL:-http://127.0.0.1:4003}"
export PORTFOLIO_SERVICE_URL="${PORTFOLIO_SERVICE_URL:-http://127.0.0.1:4004}"
export PROPOSAL_PIPELINE_URL="${PROPOSAL_PIPELINE_URL:-http://127.0.0.1:4005}"
export RESOLUTION_SERVICE_URL="${RESOLUTION_SERVICE_URL:-http://127.0.0.1:4006}"
export MATCHING_ENGINE_URL="${MATCHING_ENGINE_URL:-http://127.0.0.1:7400}"

exec pnpm -r --parallel --if-present dev
