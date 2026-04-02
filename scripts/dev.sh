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

DEFAULT_DEV_PACKAGES=(
  "@automakit/market-service"
  "@automakit/portfolio-service"
  "@automakit/proposal-pipeline"
  "@automakit/resolution-service"
  "@automakit/world-input"
  "@automakit/event-builder"
  "@automakit/world-model"
  "@automakit/scenario-agent"
  "@automakit/synthesis-agent"
  "@automakit/approval-agent"
  "@automakit/proposal-agent"
  "@automakit/simulation-orchestrator"
  "@automakit/resolution-collector"
)

if [[ -n "${AUTOMAKIT_DEV_PACKAGES:-}" ]]; then
  # shellcheck disable=SC2206
  DEV_PACKAGES=(${AUTOMAKIT_DEV_PACKAGES})
else
  DEV_PACKAGES=("${DEFAULT_DEV_PACKAGES[@]}")
fi

cleanup_existing_dev_processes() {
  local pkg pid child_pid
  local stale_pids=()

  for pkg in "${DEV_PACKAGES[@]}"; do
    while IFS= read -r pid; do
      if [[ -z "$pid" || "$pid" == "$$" ]]; then
        continue
      fi
      stale_pids+=("$pid")
    done < <(pgrep -f "pnpm --filter ${pkg} dev" || true)
  done

  if [[ "${#stale_pids[@]}" -eq 0 ]]; then
    return
  fi

  echo "[dev] cleaning stale backend dev processes"
  for pid in "${stale_pids[@]}"; do
    while IFS= read -r child_pid; do
      [[ -n "$child_pid" ]] && kill "$child_pid" >/dev/null 2>&1 || true
    done < <(pgrep -P "$pid" || true)
    kill "$pid" >/dev/null 2>&1 || true
  done

  sleep 1

  for pid in "${stale_pids[@]}"; do
    while IFS= read -r child_pid; do
      [[ -n "$child_pid" ]] && kill -9 "$child_pid" >/dev/null 2>&1 || true
    done < <(pgrep -P "$pid" || true)
    kill -9 "$pid" >/dev/null 2>&1 || true
  done
}

PIDS=()
CLEANING_UP=0

cleanup() {
  if [[ "$CLEANING_UP" -eq 1 ]]; then
    return
  fi
  CLEANING_UP=1

  for pid in "${PIDS[@]:-}"; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done

  sleep 1

  for pid in "${PIDS[@]:-}"; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
  done
}

trap cleanup EXIT INT TERM

echo "[dev] starting curated workspace stack"
cleanup_existing_dev_processes

for pkg in "${DEV_PACKAGES[@]}"; do
  echo "[dev] launching ${pkg}"
  pnpm --filter "${pkg}" dev &
  PIDS+=("$!")
done

while true; do
  active=0
  for index in "${!PIDS[@]}"; do
    pid="${PIDS[$index]}"
    if kill -0 "$pid" >/dev/null 2>&1; then
      active=1
      continue
    fi

    set +e
    wait "$pid"
    status=$?
    set -e

    if [[ "$status" -ne 0 ]]; then
      echo "[dev] ${DEV_PACKAGES[$index]} exited with status ${status}" >&2
      exit "$status"
    fi
  done

  if [[ "$active" -eq 0 ]]; then
    break
  fi

  sleep 1
done
