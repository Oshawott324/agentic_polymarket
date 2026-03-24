# Simulation Runtime (Python)

This service provides the first external simulation-runtime adapter for Automakit.

It exposes versioned runtime-agnostic contracts over HTTP:

- `POST /v1/runtime/runs`
- `GET /v1/runtime/runs/{runtime_run_id}`
- `GET /v1/runtime/runs/{runtime_run_id}/result`

The orchestration boundary stays in TypeScript (`simulation-orchestrator`). This service only executes world/simulation agents and returns typed outputs.

## Run

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 4016
```

For native CAMEL/Oasis execution mode:

```bash
pip install -r requirements-camel-oasis.txt
```

## Mode Configuration

Primary mode (recommended):

- `CAMEL_OASIS_RUNNER_CMD` points to an external CAMEL/Oasis runner executable.
- The runner should accept two args: `<input_json_path> <output_json_path>`.

Native CAMEL/Oasis mode (clean-room runtime implementation):

- Set `SIM_RUNTIME_ENABLE_CAMEL_OASIS=true`.
- Requires valid OpenAI-compatible LLM config:
  - `LLM_API_KEY`
  - `LLM_BASE_URL`
  - `LLM_MODEL_NAME`
- Optional controls:
  - `SIM_RUNTIME_CAMEL_OASIS_PLATFORM=twitter|reddit` (default: `twitter`)
  - `SIM_RUNTIME_CAMEL_OASIS_ROUNDS` (default: `3`)
  - `SIM_RUNTIME_CAMEL_OASIS_MIN_ACTIVE_AGENTS` (default: `2`)
  - `SIM_RUNTIME_CAMEL_OASIS_MAX_ACTIVE_AGENTS` (default: `8`)
  - `SIM_RUNTIME_CAMEL_OASIS_SEMAPHORE` (default: `16`)
  - `SIM_RUNTIME_CAMEL_OASIS_RANDOM_SEED` (optional, deterministic sampling for tests)

Fallback mode (no external runner and no native CAMEL/Oasis):

- Set `SIM_RUNTIME_ALLOW_DIRECT_LLM=true` and provide:
  - `LLM_API_KEY`
  - `LLM_BASE_URL` (default: `https://api.openai.com/v1`)
  - `LLM_MODEL_NAME` (default: `gpt-4o-mini`)

In fallback mode this service runs role-scoped LLM agent prompts directly while preserving the same request/response contracts.
