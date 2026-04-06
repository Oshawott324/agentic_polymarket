#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PIDS=()
CLEANING_UP=0

cleanup_existing_frontend_processes() {
  local stale_pids=()
  local pid child_pid

  while IFS= read -r pid; do
    if [[ -n "$pid" && "$pid" != "$$" ]]; then
      stale_pids+=("$pid")
    fi
  done < <(lsof -ti:3000 -i:3001 -sTCP:LISTEN 2>/dev/null | sort -u || true)

  for pattern in "@automakit/web start" "@automakit/observer-console start"; do
    while IFS= read -r pid; do
      if [[ -n "$pid" && "$pid" != "$$" ]]; then
        stale_pids+=("$pid")
      fi
    done < <(pgrep -f "$pattern" || true)
  done

  if [[ "${#stale_pids[@]}" -eq 0 ]]; then
    return
  fi

  echo "[start-web] cleaning stale frontend processes"
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

cleanup_existing_frontend_processes

echo "[start-web] building frontends"
pnpm --filter @automakit/web build
pnpm --filter @automakit/observer-console build

echo "[start-web] starting @automakit/web"
pnpm --filter @automakit/web start &
PIDS+=("$!")

echo "[start-web] starting @automakit/observer-console"
pnpm --filter @automakit/observer-console start &
PIDS+=("$!")

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
      echo "[start-web] frontend process ${index} exited with status ${status}" >&2
      exit "$status"
    fi
  done

  if [[ "$active" -eq 0 ]]; then
    break
  fi

  sleep 1
done
