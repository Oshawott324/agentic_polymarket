#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "${1:-}" != "--yes" ]]; then
  cat <<'MSG'
Refusing to reset dev data without confirmation.

This command truncates markets, proposals, world signals, event cases, simulation runs,
and resolution artifacts in the database referenced by .env / DATABASE_URL.

Re-run with:
  pnpm dev:reset-data -- --yes
MSG
  exit 1
fi

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/automakit}"

echo "Resetting dev data in ${DATABASE_URL}"
psql "$DATABASE_URL" <<'SQL'
TRUNCATE TABLE
  resolution_evidence,
  observations,
  resolution_collection_jobs,
  resolution_cases,
  markets,
  listing_approval_votes,
  listing_approval_cases,
  synthesized_beliefs,
  belief_hypothesis_proposals,
  scenario_path_proposals,
  world_state_proposals,
  simulation_runtime_runs,
  simulation_runs,
  world_input_runs,
  event_case_signals,
  event_cases,
  world_signals,
  proposals
RESTART IDENTITY CASCADE;

UPDATE world_input_sources
SET
  status = 'idle',
  cursor_value = NULL,
  last_polled_at = NULL,
  next_poll_at = NOW(),
  backoff_until = NULL,
  failure_count = 0,
  last_error = NULL,
  updated_at = NOW();
SQL

echo "Dev data reset complete."
