from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass, field
from typing import Dict, Optional
from uuid import uuid4

from fastapi import FastAPI, HTTPException

from .adapters.camel_oasis import CamelOasisAdapter
from .contracts import (
    SimulationProgress,
    SimulationRunRequestV1,
    SimulationRunResultV1,
    SimulationRunStatusV1,
    now_iso,
)

app = FastAPI(title="automakit-simulation-runtime-py", version="0.1.0")


@dataclass(slots=True)
class RuntimeRunState:
    runtime_run_id: str
    request: SimulationRunRequestV1
    status: SimulationRunStatusV1
    result: Optional[SimulationRunResultV1] = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


runtime_runs: Dict[str, RuntimeRunState] = {}
runtime_lock = asyncio.Lock()
adapter = CamelOasisAdapter()


async def update_progress(runtime_run_id: str, phase: str, percent: float) -> None:
    run = runtime_runs.get(runtime_run_id)
    if run is None:
        return
    async with run.lock:
        run.status = SimulationRunStatusV1(
            contract_version="sim-runtime.v1",
            run_id=run.request.run_id,
            runtime_run_id=runtime_run_id,
            state="running",
            progress=SimulationProgress(phase=phase, percent=max(0.0, min(100.0, percent))),
            error=None,
            updated_at=now_iso(),
        )


async def execute_run(runtime_run_id: str) -> None:
    run = runtime_runs.get(runtime_run_id)
    if run is None:
        return
    request = run.request

    try:
        await update_progress(runtime_run_id, "world_model", 1.0)
        result = await adapter.execute(
            request=request,
            progress=lambda phase, percent: update_progress(runtime_run_id, phase, percent),
        )
        async with run.lock:
            run.result = result
            run.status = SimulationRunStatusV1(
                contract_version="sim-runtime.v1",
                run_id=request.run_id,
                runtime_run_id=runtime_run_id,
                state="succeeded",
                progress=SimulationProgress(phase="complete", percent=100.0),
                error=None,
                updated_at=now_iso(),
            )
    except Exception as exc:  # noqa: BLE001
        async with run.lock:
            run.status = SimulationRunStatusV1(
                contract_version="sim-runtime.v1",
                run_id=request.run_id,
                runtime_run_id=runtime_run_id,
                state="failed",
                progress=SimulationProgress(phase="complete", percent=100.0),
                error=str(exc),
                updated_at=now_iso(),
            )


@app.get("/health")
async def health() -> dict:
    return {
        "service": "simulation-runtime-py",
        "status": "ok",
        "active_runs": sum(1 for run in runtime_runs.values() if run.status.state in ("queued", "running")),
        "runner_configured": bool(os.getenv("CAMEL_OASIS_RUNNER_CMD")),
        "direct_llm_enabled": os.getenv("SIM_RUNTIME_ALLOW_DIRECT_LLM", "true").lower() in ("1", "true", "yes", "on"),
    }


@app.post("/v1/runtime/runs")
async def submit_run(request: SimulationRunRequestV1) -> dict:
    runtime_run_id = str(uuid4())
    status = SimulationRunStatusV1(
        contract_version=request.contract_version,
        run_id=request.run_id,
        runtime_run_id=runtime_run_id,
        state="queued",
        progress=SimulationProgress(phase="world_model", percent=0.0),
        error=None,
        updated_at=now_iso(),
    )
    state = RuntimeRunState(runtime_run_id=runtime_run_id, request=request, status=status)

    async with runtime_lock:
        runtime_runs[runtime_run_id] = state

    asyncio.create_task(execute_run(runtime_run_id))
    return {"runtime_run_id": runtime_run_id}


@app.get("/v1/runtime/runs/{runtime_run_id}", response_model=SimulationRunStatusV1)
async def get_run_status(runtime_run_id: str) -> SimulationRunStatusV1:
    run = runtime_runs.get(runtime_run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="runtime_run_not_found")
    return run.status


@app.get("/v1/runtime/runs/{runtime_run_id}/result", response_model=SimulationRunResultV1)
async def get_run_result(runtime_run_id: str) -> SimulationRunResultV1:
    run = runtime_runs.get(runtime_run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="runtime_run_not_found")
    if run.status.state != "succeeded":
        raise HTTPException(status_code=409, detail=f"runtime_run_not_ready:{run.status.state}")
    if run.result is None:
        raise HTTPException(status_code=500, detail="runtime_run_result_missing")
    return run.result
