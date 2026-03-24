from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field

ContractVersion = Literal["sim-runtime.v1"]
RunState = Literal["queued", "running", "succeeded", "failed"]
ProgressPhase = Literal["world_model", "scenario", "synthesis", "complete"]


class WorldSignal(BaseModel):
    id: str
    source_type: str
    source_adapter: str
    source_id: str
    source_url: str
    trust_tier: str
    fetched_at: str
    effective_at: Optional[str] = None
    title: str
    summary: str
    payload: Dict[str, Any]
    entity_refs: List[Dict[str, Any]]
    dedupe_key: str
    created_at: str


class SimulationAgentRoles(BaseModel):
    world_model: List[str] = Field(default_factory=list)
    scenario: List[str] = Field(default_factory=list)
    synthesis: List[str] = Field(default_factory=list)


class SimulationTimeouts(BaseModel):
    submit_timeout_ms: int
    run_timeout_ms: int
    status_poll_interval_ms: int


class SimulationRunRequestV1(BaseModel):
    contract_version: ContractVersion
    run_id: str
    trace_id: str
    submitted_at: str
    signals: List[WorldSignal]
    agent_roles: SimulationAgentRoles
    timeouts: SimulationTimeouts


class SimulationProgress(BaseModel):
    phase: ProgressPhase
    percent: float


class SimulationRunStatusV1(BaseModel):
    contract_version: ContractVersion
    run_id: str
    runtime_run_id: str
    state: RunState
    progress: SimulationProgress
    error: Optional[str] = None
    updated_at: str


class SimulationOutputsV1(BaseModel):
    world_state_proposals: List[Dict[str, Any]]
    direct_hypotheses: List[Dict[str, Any]]
    scenario_path_proposals: List[Dict[str, Any]]
    synthesized_beliefs: List[Dict[str, Any]]


class SimulationRunResultV1(BaseModel):
    contract_version: ContractVersion
    run_id: str
    runtime_run_id: str
    completed_at: str
    outputs: SimulationOutputsV1


def now_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
