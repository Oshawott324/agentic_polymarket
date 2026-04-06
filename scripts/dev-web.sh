#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PIDS=()
CLEANING_UP=0
WEB_PACKAGES=(
  "@automakit/web"
  "@automakit/observer-console"
)

cleanup_existing_frontend_processes() {
  local stale_pids=()
  local pid child_pid

  while IFS= read -r pid; do
    if [[ -n "$pid" && "$pid" != "$$" ]]; then
      stale_pids+=("$pid")
    fi
  done < <(lsof -ti:3000 -i:3001 -sTCP:LISTEN 2>/dev/null | sort -u || true)

  for pkg in "${WEB_PACKAGES[@]}"; do
    while IFS= read -r pid; do
      if [[ -n "$pid" && "$pid" != "$$" ]]; then
        stale_pids+=("$pid")
      fi
    done < <(pgrep -f "pnpm --filter ${pkg} dev" || true)
  done

  if [[ "${#stale_pids[@]}" -eq 0 ]]; then
    return
  fi

  echo "[dev-web] cleaning stale frontend processes"
  mapfile -t stale_pids < <(printf '%s\n' "${stale_pids[@]}" | sort -u)

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

echo "[dev-web] starting web frontends"
cleanup_existing_frontend_processes

for pkg in "${WEB_PACKAGES[@]}"; do
  echo "[dev-web] launching ${pkg}"
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
      echo "[dev-web] ${WEB_PACKAGES[$index]} exited with status ${status}" >&2
      exit "$status"
    fi
  done

  if [[ "$active" -eq 0 ]]; then
    break
  fi

  sleep 1
done
