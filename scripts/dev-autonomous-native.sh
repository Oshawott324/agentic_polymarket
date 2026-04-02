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

if [[ -z "${LLM_API_KEY:-}" && -n "${OPENAI_API_KEY:-}" ]]; then
  export LLM_API_KEY="$OPENAI_API_KEY"
fi
if [[ -z "${LLM_API_KEY:-}" && -n "${AGENT_OPENAI_API_KEY:-}" ]]; then
  export LLM_API_KEY="$AGENT_OPENAI_API_KEY"
fi

if [[ -z "${LLM_API_KEY:-}" ]]; then
  echo "LLM_API_KEY (or OPENAI_API_KEY / AGENT_OPENAI_API_KEY) is required." >&2
  exit 1
fi

export SIMULATION_RUNTIME_BACKEND="${SIMULATION_RUNTIME_BACKEND:-camel_oasis_http}"
export SIMULATION_RUNTIME_URL="${SIMULATION_RUNTIME_URL:-http://127.0.0.1:4016}"
export SIM_RUNTIME_ENABLE_CAMEL_OASIS="${SIM_RUNTIME_ENABLE_CAMEL_OASIS:-true}"
export SIM_RUNTIME_ALLOW_DIRECT_LLM="${SIM_RUNTIME_ALLOW_DIRECT_LLM:-false}"
export SIM_RUNTIME_CAMEL_OASIS_PLATFORM="${SIM_RUNTIME_CAMEL_OASIS_PLATFORM:-twitter}"
export SIM_RUNTIME_CAMEL_OASIS_ROUNDS="${SIM_RUNTIME_CAMEL_OASIS_ROUNDS:-2}"
export SIM_RUNTIME_CAMEL_OASIS_MIN_ACTIVE_AGENTS="${SIM_RUNTIME_CAMEL_OASIS_MIN_ACTIVE_AGENTS:-2}"
export SIM_RUNTIME_CAMEL_OASIS_MAX_ACTIVE_AGENTS="${SIM_RUNTIME_CAMEL_OASIS_MAX_ACTIVE_AGENTS:-4}"
export SIM_RUNTIME_CAMEL_OASIS_SEMAPHORE="${SIM_RUNTIME_CAMEL_OASIS_SEMAPHORE:-8}"
export SIMULATION_RUNTIME_REQUEST_TIMEOUT_MS="${SIMULATION_RUNTIME_REQUEST_TIMEOUT_MS:-180000}"
export SIMULATION_RUNTIME_RUN_TIMEOUT_MS="${SIMULATION_RUNTIME_RUN_TIMEOUT_MS:-300000}"

RUNTIME_HOST="${SIM_RUNTIME_HOST:-127.0.0.1}"
RUNTIME_PORT="${SIM_RUNTIME_PORT:-4016}"
RUNTIME_PY_BIN="${RUNTIME_PY_BIN:-services/simulation-runtime-py/.venv/bin/uvicorn}"

if [[ ! -x "$RUNTIME_PY_BIN" ]]; then
  echo "Missing $RUNTIME_PY_BIN. Create it with:" >&2
  echo "  ~/.pyenv/versions/3.11.9/bin/python -m venv services/simulation-runtime-py/.venv" >&2
  echo "  services/simulation-runtime-py/.venv/bin/pip install -r services/simulation-runtime-py/requirements.txt -r services/simulation-runtime-py/requirements-camel-oasis.txt" >&2
  exit 1
fi

mkdir -p .runtime

cleanup() {
  set +e
  if [[ -n "${RUNTIME_PID:-}" ]]; then
    kill "$RUNTIME_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo "Starting simulation-runtime-py on ${RUNTIME_HOST}:${RUNTIME_PORT} ..."
"$RUNTIME_PY_BIN" app.main:app \
  --app-dir services/simulation-runtime-py \
  --host "$RUNTIME_HOST" \
  --port "$RUNTIME_PORT" \
  > .runtime/simulation-runtime-py.log 2>&1 &
RUNTIME_PID=$!

for i in $(seq 1 60); do
  if curl -sS "http://${RUNTIME_HOST}:${RUNTIME_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [[ "$i" -eq 60 ]]; then
    echo "simulation-runtime-py failed to start. Check .runtime/simulation-runtime-py.log" >&2
    exit 1
  fi
done

echo "Starting autonomous backend services (pnpm dev) with native runtime ..."
pnpm dev
