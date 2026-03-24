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

## Mode Configuration

Primary mode (recommended):

- `CAMEL_OASIS_RUNNER_CMD` points to an external CAMEL/Oasis runner executable.
- The runner should accept two args: `<input_json_path> <output_json_path>`.

Fallback mode:

- Set `SIM_RUNTIME_ALLOW_DIRECT_LLM=true` and provide:
  - `LLM_API_KEY`
  - `LLM_BASE_URL` (default: `https://api.openai.com/v1`)
  - `LLM_MODEL_NAME` (default: `gpt-4o-mini`)

In fallback mode this service runs role-scoped LLM agent prompts directly while preserving the same request/response contracts.
