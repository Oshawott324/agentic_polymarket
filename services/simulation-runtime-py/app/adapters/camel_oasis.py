from __future__ import annotations

import asyncio
import csv
import hashlib
import json
import os
import random
import shlex
import sqlite3
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence
from uuid import uuid4

import httpx

from ..contracts import (
    SimulationRunRequestV1,
    SimulationRunResultV1,
    SimulationOutputsV1,
    now_iso,
)

ProgressCallback = Callable[[str, float], Awaitable[None]]


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def dedupe_key(value: Any) -> str:
    return hashlib.sha256(stable_json(value).encode("utf-8")).hexdigest()


def clamp(value: float, low: float = 0.05, high: float = 0.95) -> float:
    return max(low, min(high, value))


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(slots=True)
class LlmConfig:
    api_key: str
    base_url: str
    model: str
    temperature: float
    max_tokens: int
    timeout_seconds: float


@dataclass(slots=True)
class OasisNativeConfig:
    enabled: bool
    platform: str
    rounds: int
    min_active_agents: int
    max_active_agents: int
    semaphore: int
    random_seed: Optional[int]


def env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class CamelOasisAdapter:
    """
    Primary mode:
      - CAMEL/Oasis external runner process configured by CAMEL_OASIS_RUNNER_CMD.
    Fallback mode:
      - direct role-scoped LLM simulation under the same contracts.
    """

    def __init__(self) -> None:
        self.runner_cmd = os.getenv("CAMEL_OASIS_RUNNER_CMD", "").strip()
        platform = os.getenv("SIM_RUNTIME_CAMEL_OASIS_PLATFORM", "twitter").strip().lower()
        if platform not in {"twitter", "reddit"}:
            platform = "twitter"
        seed_raw = os.getenv("SIM_RUNTIME_CAMEL_OASIS_RANDOM_SEED", "").strip()
        self.oasis_native = OasisNativeConfig(
            enabled=env_bool("SIM_RUNTIME_ENABLE_CAMEL_OASIS", False),
            platform=platform,
            rounds=max(1, int(os.getenv("SIM_RUNTIME_CAMEL_OASIS_ROUNDS", "3"))),
            min_active_agents=max(1, int(os.getenv("SIM_RUNTIME_CAMEL_OASIS_MIN_ACTIVE_AGENTS", "2"))),
            max_active_agents=max(1, int(os.getenv("SIM_RUNTIME_CAMEL_OASIS_MAX_ACTIVE_AGENTS", "8"))),
            semaphore=max(1, int(os.getenv("SIM_RUNTIME_CAMEL_OASIS_SEMAPHORE", "16"))),
            random_seed=int(seed_raw) if seed_raw else None,
        )
        self.allow_direct_llm = os.getenv("SIM_RUNTIME_ALLOW_DIRECT_LLM", "true").lower() in (
            "1",
            "true",
            "yes",
            "on",
        )
        llm_api_key = os.getenv("LLM_API_KEY", "").strip()
        self.llm: Optional[LlmConfig] = None
        if llm_api_key:
            self.llm = LlmConfig(
                api_key=llm_api_key,
                base_url=os.getenv("LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/"),
                model=os.getenv("LLM_MODEL_NAME", "gpt-4o-mini"),
                temperature=float(os.getenv("LLM_TEMPERATURE", "0.4")),
                max_tokens=int(os.getenv("LLM_MAX_TOKENS", "2048")),
                timeout_seconds=float(os.getenv("LLM_TIMEOUT_SECONDS", "60")),
            )

    async def execute(
        self,
        request: SimulationRunRequestV1,
        progress: ProgressCallback,
    ) -> SimulationRunResultV1:
        if self.runner_cmd:
            return await self._execute_runner_mode(request, progress)
        if self.oasis_native.enabled:
            return await self._execute_native_oasis_mode(request, progress)
        if self.allow_direct_llm:
            return await self._execute_direct_mode(request, progress)
        raise RuntimeError(
            "simulation_runtime_not_configured: set CAMEL_OASIS_RUNNER_CMD, "
            "or SIM_RUNTIME_ENABLE_CAMEL_OASIS=true, "
            "or SIM_RUNTIME_ALLOW_DIRECT_LLM=true"
        )

    async def _execute_native_oasis_mode(
        self,
        request: SimulationRunRequestV1,
        progress: ProgressCallback,
    ) -> SimulationRunResultV1:
        if self.llm is None:
            raise RuntimeError("camel_oasis_native_requires_llm_config")

        try:
            from camel.models import ModelFactory
            from camel.types import ModelPlatformType
            import oasis
            from oasis import LLMAction
            from oasis import generate_reddit_agent_graph, generate_twitter_agent_graph
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"camel_oasis_import_failed:{exc}") from exc

        if self.oasis_native.random_seed is not None:
            random.seed(self.oasis_native.random_seed)

        roles = self._collect_runtime_roles(request)
        simulation_summary: Dict[str, Any] = {
            "platform": self.oasis_native.platform,
            "rounds": self.oasis_native.rounds,
            "active_agent_counts": [],
            "trace_rows": 0,
            "trace_actions": {},
            "top_subjects": [],
        }

        with tempfile.TemporaryDirectory(prefix="automakit-camel-oasis-") as temp_dir:
            profile_path = self._write_profiles(temp_dir=temp_dir, roles=roles)
            database_path = os.path.join(temp_dir, f"{self.oasis_native.platform}.db")

            os.environ["OPENAI_API_KEY"] = self.llm.api_key
            if self.llm.base_url:
                os.environ["OPENAI_API_BASE_URL"] = self.llm.base_url

            model = ModelFactory.create(
                model_platform=ModelPlatformType.OPENAI,
                model_type=self.llm.model,
            )

            await progress("world_model", 5)
            if self.oasis_native.platform == "reddit":
                agent_graph = await generate_reddit_agent_graph(
                    profile_path=profile_path,
                    model=model,
                )
                platform_value = oasis.DefaultPlatformType.REDDIT
            else:
                agent_graph = await generate_twitter_agent_graph(
                    profile_path=profile_path,
                    model=model,
                )
                platform_value = oasis.DefaultPlatformType.TWITTER

            env = oasis.make(
                agent_graph=agent_graph,
                platform=platform_value,
                database_path=database_path,
                semaphore=self.oasis_native.semaphore,
            )
            await env.reset()

            round_subjects = self._top_subjects(request, limit=5)
            for round_index in range(self.oasis_native.rounds):
                selected_ids = self._select_active_ids(len(roles))
                simulation_summary["active_agent_counts"].append(len(selected_ids))
                if selected_ids:
                    actions: Dict[Any, Any] = {}
                    for agent_id in selected_ids:
                        agent = env.agent_graph.get_agent(agent_id)
                        actions[agent] = LLMAction()
                    await env.step(actions)
                progress_value = 5 + (65 * (round_index + 1) / max(self.oasis_native.rounds, 1))
                await progress("scenario", progress_value)

            simulation_summary["trace_rows"], simulation_summary["trace_actions"] = self._read_trace_stats(database_path)
            simulation_summary["top_subjects"] = round_subjects

        world_roles = request.agent_roles.world_model or ["world-model-alpha"]
        scenario_roles = request.agent_roles.scenario or ["scenario-base"]
        synthesis_roles = request.agent_roles.synthesis or ["synthesis-core"]

        world_state_proposals: List[Dict[str, Any]] = []
        direct_hypotheses: List[Dict[str, Any]] = []
        scenario_path_proposals: List[Dict[str, Any]] = []
        synthesized_beliefs: List[Dict[str, Any]] = []

        await progress("world_model", 72)
        for idx, agent_id in enumerate(world_roles, start=1):
            state, hypotheses = await self._run_world_model_agent(
                request=request,
                agent_id=agent_id,
                simulation_summary=simulation_summary,
            )
            world_state_proposals.append(state)
            direct_hypotheses.extend(hypotheses)
            await progress("world_model", 72 + 8 * idx / max(len(world_roles), 1))

        await progress("scenario", 82)
        for idx, agent_id in enumerate(scenario_roles, start=1):
            scenario = await self._run_scenario_agent(
                request=request,
                agent_id=agent_id,
                direct_hypotheses=direct_hypotheses,
            )
            scenario_path_proposals.append(scenario)
            await progress("scenario", 82 + 8 * idx / max(len(scenario_roles), 1))

        await progress("synthesis", 90)
        for idx, agent_id in enumerate(synthesis_roles, start=1):
            beliefs = await self._run_synthesis_agent(
                request=request,
                agent_id=agent_id,
                direct_hypotheses=direct_hypotheses,
                scenario_paths=scenario_path_proposals,
            )
            synthesized_beliefs.extend(beliefs)
            await progress("synthesis", 90 + 10 * idx / max(len(synthesis_roles), 1))

        return SimulationRunResultV1(
            contract_version="sim-runtime.v1",
            run_id=request.run_id,
            runtime_run_id=f"camel-oasis-{request.run_id}",
            completed_at=now_iso(),
            outputs=SimulationOutputsV1(
                world_state_proposals=world_state_proposals,
                direct_hypotheses=direct_hypotheses,
                scenario_path_proposals=scenario_path_proposals,
                synthesized_beliefs=synthesized_beliefs,
            ),
        )

    async def _execute_runner_mode(
        self,
        request: SimulationRunRequestV1,
        progress: ProgressCallback,
    ) -> SimulationRunResultV1:
        await progress("world_model", 5)
        with tempfile.TemporaryDirectory(prefix="automakit-sim-") as temp_dir:
            input_path = os.path.join(temp_dir, "input.json")
            output_path = os.path.join(temp_dir, "output.json")
            with open(input_path, "w", encoding="utf-8") as handle:
                handle.write(request.model_dump_json())

            argv = shlex.split(self.runner_cmd) + [input_path, output_path]
            process = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate()
            if process.returncode != 0:
                raise RuntimeError(
                    f"camel_oasis_runner_failed:{process.returncode}:"
                    f"{stderr.decode('utf-8', errors='ignore') or stdout.decode('utf-8', errors='ignore')}"
                )

            await progress("synthesis", 85)
            if not os.path.exists(output_path):
                raise RuntimeError("camel_oasis_runner_output_missing")

            with open(output_path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)

        outputs = payload.get("outputs")
        if not isinstance(outputs, dict):
            raise RuntimeError("camel_oasis_runner_output_invalid")

        return SimulationRunResultV1(
            contract_version="sim-runtime.v1",
            run_id=request.run_id,
            runtime_run_id=payload.get("runtime_run_id", f"runner-{request.run_id}"),
            completed_at=now_iso(),
            outputs=SimulationOutputsV1(
                world_state_proposals=list(outputs.get("world_state_proposals", [])),
                direct_hypotheses=list(outputs.get("direct_hypotheses", [])),
                scenario_path_proposals=list(outputs.get("scenario_path_proposals", [])),
                synthesized_beliefs=list(outputs.get("synthesized_beliefs", [])),
            ),
        )

    async def _execute_direct_mode(
        self,
        request: SimulationRunRequestV1,
        progress: ProgressCallback,
    ) -> SimulationRunResultV1:
        world_roles = request.agent_roles.world_model or ["world-model-alpha"]
        scenario_roles = request.agent_roles.scenario or ["scenario-base"]
        synthesis_roles = request.agent_roles.synthesis or ["synthesis-core"]

        world_state_proposals: List[Dict[str, Any]] = []
        direct_hypotheses: List[Dict[str, Any]] = []
        scenario_path_proposals: List[Dict[str, Any]] = []
        synthesized_beliefs: List[Dict[str, Any]] = []

        await progress("world_model", 10)
        for idx, agent_id in enumerate(world_roles, start=1):
            state, hypotheses = await self._run_world_model_agent(request, agent_id)
            world_state_proposals.append(state)
            direct_hypotheses.extend(hypotheses)
            await progress("world_model", 10 + 35 * idx / max(len(world_roles), 1))

        await progress("scenario", 50)
        for idx, agent_id in enumerate(scenario_roles, start=1):
            scenario = await self._run_scenario_agent(request, agent_id, direct_hypotheses)
            scenario_path_proposals.append(scenario)
            await progress("scenario", 50 + 25 * idx / max(len(scenario_roles), 1))

        await progress("synthesis", 78)
        for idx, agent_id in enumerate(synthesis_roles, start=1):
            beliefs = await self._run_synthesis_agent(
                request=request,
                agent_id=agent_id,
                direct_hypotheses=direct_hypotheses,
                scenario_paths=scenario_path_proposals,
            )
            synthesized_beliefs.extend(beliefs)
            await progress("synthesis", 78 + 20 * idx / max(len(synthesis_roles), 1))

        return SimulationRunResultV1(
            contract_version="sim-runtime.v1",
            run_id=request.run_id,
            runtime_run_id=f"direct-{request.run_id}",
            completed_at=now_iso(),
            outputs=SimulationOutputsV1(
                world_state_proposals=world_state_proposals,
                direct_hypotheses=direct_hypotheses,
                scenario_path_proposals=scenario_path_proposals,
                synthesized_beliefs=synthesized_beliefs,
            ),
        )

    async def _run_world_model_agent(
        self,
        request: SimulationRunRequestV1,
        agent_id: str,
        simulation_summary: Optional[Dict[str, Any]] = None,
    ) -> tuple[Dict[str, Any], List[Dict[str, Any]]]:
        signal_ids = [signal.id for signal in request.signals]
        top_signal = request.signals[-1] if request.signals else None
        event_cases = list(request.event_cases)

        llm_payload = await self._chat_json(
            system_prompt=(
                "You are a world-model simulation agent. Return JSON only with keys "
                "regime_labels, reasoning_summary, and hypotheses."
            ),
            user_payload={
                "run_id": request.run_id,
                "agent_id": agent_id,
                "signals": [signal.model_dump() for signal in request.signals],
                "event_cases": [event_case.model_dump() for event_case in event_cases],
                "simulation_summary": simulation_summary or {},
            },
        )

        regime_labels = []
        if isinstance(llm_payload, dict) and isinstance(llm_payload.get("regime_labels"), list):
            regime_labels = [str(entry) for entry in llm_payload["regime_labels"] if str(entry).strip()]
        if not regime_labels:
            regime_labels = ["mixed_regime"]

        reasoning_summary = (
            f"{agent_id} processed {len(event_cases)} event cases backed by "
            f"{len(request.signals)} signals."
            if event_cases
            else f"{agent_id} processed {len(request.signals)} signals."
        )
        if simulation_summary:
            trace_rows = int(simulation_summary.get("trace_rows", 0))
            rounds = int(simulation_summary.get("rounds", 0))
            reasoning_summary = (
                f"{agent_id} processed {len(event_cases) if event_cases else len(request.signals)} "
                f"{'event cases' if event_cases else 'signals'} after "
                f"{rounds} simulation rounds with {trace_rows} trace events."
            )
        if isinstance(llm_payload, dict) and isinstance(llm_payload.get("reasoning_summary"), str):
            reasoning_summary = llm_payload["reasoning_summary"][:500]

        entities = []
        seen_entity_ids: set[str] = set()
        for event_case in event_cases:
            entity_name = str(event_case.primary_entity or event_case.title).strip()
            entity_id = f"event:{event_case.id}"
            if entity_name and entity_id not in seen_entity_ids:
                seen_entity_ids.add(entity_id)
                entities.append(
                    {
                        "id": entity_id,
                        "kind": "event",
                        "name": entity_name,
                        "attributes": {
                            "event_case_id": event_case.id,
                            "event_case_kind": event_case.kind,
                        },
                    }
                )
        for signal in request.signals:
            for ref in signal.entity_refs:
                kind = str(ref.get("kind", "event"))
                value = str(ref.get("value", "unknown"))
                entity_id = f"{kind}:{value}"
                if entity_id in seen_entity_ids:
                    continue
                seen_entity_ids.add(entity_id)
                entities.append(
                    {
                        "id": entity_id,
                        "kind": kind,
                        "name": value,
                        "attributes": {
                            "source_signal_id": signal.id,
                            "source_type": signal.source_type,
                        },
                    }
                )

        if not entities and top_signal is not None:
            entities.append(
                {
                    "id": f"event:{top_signal.source_id}",
                    "kind": "event",
                    "name": top_signal.title,
                    "attributes": {"source_signal_id": top_signal.id},
                }
            )

        active_events = (
            [
                {
                    "id": event_case.id,
                    "title": event_case.title,
                    "event_type": event_case.kind,
                    "effective_at": event_case.last_signal_at,
                    "source_signal_ids": list(event_case.source_signal_ids),
                }
                for event_case in event_cases
            ]
            if event_cases
            else [
                {
                    "id": signal.id,
                    "title": signal.title,
                    "event_type": signal.source_type,
                    "effective_at": signal.effective_at,
                    "source_signal_ids": [signal.id],
                }
                for signal in request.signals
            ]
        )

        observed_types = {
            source_type
            for event_case in event_cases
            for source_type in event_case.source_types
        } or {signal.source_type for signal in request.signals}

        world_state = {
            "id": str(uuid4()),
            "run_id": request.run_id,
            "agent_id": agent_id,
            "source_signal_ids": signal_ids,
            "as_of": now_iso(),
            "entities": entities,
            "active_events": active_events,
            "factors": [
                {
                    "factor": "event_flow",
                    "value": clamp(len(active_events) / 8, 0.2, 0.95),
                    "direction": "up",
                    "rationale": f"{agent_id} observed persistent upstream event activity.",
                },
                {
                    "factor": "source_diversity",
                    "value": clamp(len(observed_types) / 5, 0.2, 0.95),
                    "direction": "up" if len(observed_types) >= 3 else "flat",
                    "rationale": f"{agent_id} observed {len(observed_types)} source-type buckets in the current context.",
                }
            ],
            "regime_labels": regime_labels,
            "reasoning_summary": reasoning_summary,
            "created_at": now_iso(),
        }

        hypotheses = self._build_hypotheses_from_signals(request, agent_id, llm_payload)
        return world_state, hypotheses

    async def _run_scenario_agent(
        self,
        request: SimulationRunRequestV1,
        agent_id: str,
        direct_hypotheses: Sequence[Dict[str, Any]],
    ) -> Dict[str, Any]:
        label = "base"
        lowered = agent_id.lower()
        if "bear" in lowered:
            label = "bear"
        elif "bull" in lowered:
            label = "bull"
        elif "stress" in lowered:
            label = "stress"

        llm_payload = await self._chat_json(
            system_prompt=(
                "You are a scenario simulation agent. Return JSON with narrative, probability, "
                "and hypothesis_adjustments array [{key, confidence_delta, reasoning_summary}]."
            ),
            user_payload={
                "run_id": request.run_id,
                "agent_id": agent_id,
                "label": label,
                "direct_hypotheses": list(direct_hypotheses),
            },
        )

        probability = {"bull": 0.28, "bear": 0.26, "stress": 0.16}.get(label, 0.3)
        if isinstance(llm_payload, dict):
            maybe_probability = llm_payload.get("probability")
            if isinstance(maybe_probability, (int, float)):
                probability = clamp(float(maybe_probability), 0.01, 0.99)

        narrative = f"{agent_id} explored a {label} path."
        if isinstance(llm_payload, dict) and isinstance(llm_payload.get("narrative"), str):
            narrative = llm_payload["narrative"][:600]

        adjustments_map: Dict[str, Dict[str, Any]] = {}
        if isinstance(llm_payload, dict) and isinstance(llm_payload.get("hypothesis_adjustments"), list):
            for item in llm_payload["hypothesis_adjustments"]:
                if not isinstance(item, dict):
                    continue
                key = item.get("key")
                delta = item.get("confidence_delta")
                if not isinstance(key, str) or not isinstance(delta, (int, float)):
                    continue
                adjustments_map[key] = {
                    "delta": float(delta),
                    "reasoning_summary": str(item.get("reasoning_summary", "")).strip(),
                }

        path_hypotheses: List[Dict[str, Any]] = []
        for hypothesis in direct_hypotheses:
            key = str(hypothesis.get("dedupe_key", ""))
            if not key:
                continue
            adjustment = adjustments_map.get(key, {"delta": 0.0, "reasoning_summary": ""})
            confidence = clamp(float(hypothesis.get("confidence_score", 0.5)) + float(adjustment["delta"]))
            path_hypotheses.append(
                {
                    "key": key,
                    "hypothesis_kind": hypothesis.get("hypothesis_kind"),
                    "category": hypothesis.get("category"),
                    "subject": hypothesis.get("subject"),
                    "predicate": hypothesis.get("predicate"),
                    "target_time": hypothesis.get("target_time"),
                    "confidence_score": confidence,
                    "reasoning_summary": adjustment["reasoning_summary"]
                    or f"{agent_id} adjusted confidence in {label} path.",
                    "source_signal_ids": hypothesis.get("source_signal_ids", []),
                    "machine_resolvable": bool(hypothesis.get("machine_resolvable", False)),
                    "suggested_resolution_spec": hypothesis.get("suggested_resolution_spec"),
                }
            )

        return {
            "id": str(uuid4()),
            "run_id": request.run_id,
            "agent_id": agent_id,
            "label": label,
            "probability": probability,
            "narrative": narrative,
            "factor_deltas": {"label": label},
            "path_events": [],
            "path_hypotheses": path_hypotheses,
            "created_at": now_iso(),
        }

    async def _run_synthesis_agent(
        self,
        request: SimulationRunRequestV1,
        agent_id: str,
        direct_hypotheses: Sequence[Dict[str, Any]],
        scenario_paths: Sequence[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        scenario_by_key: Dict[str, List[float]] = {}
        for path in scenario_paths:
            probability = float(path.get("probability", 0.0))
            for hypothesis in path.get("path_hypotheses", []):
                if not isinstance(hypothesis, dict):
                    continue
                key = hypothesis.get("key")
                score = hypothesis.get("confidence_score")
                if not isinstance(key, str) or not isinstance(score, (int, float)):
                    continue
                scenario_by_key.setdefault(key, []).append(float(score) * probability)

        llm_payload = await self._chat_json(
            system_prompt=(
                "You are a synthesis agent. Return JSON with decisions array "
                "[{key, status, confidence_score, agreement_score, disagreement_score, conflict_notes, suppression_reason}]."
            ),
            user_payload={
                "run_id": request.run_id,
                "agent_id": agent_id,
                "direct_hypotheses": list(direct_hypotheses),
                "scenario_paths": list(scenario_paths),
            },
        )

        decisions: Dict[str, Dict[str, Any]] = {}
        if isinstance(llm_payload, dict) and isinstance(llm_payload.get("decisions"), list):
            for item in llm_payload["decisions"]:
                if not isinstance(item, dict):
                    continue
                key = item.get("key")
                if isinstance(key, str):
                    decisions[key] = item

        beliefs: List[Dict[str, Any]] = []
        for hypothesis in direct_hypotheses:
            key = str(hypothesis.get("dedupe_key", ""))
            if not key:
                continue

            base_confidence = float(hypothesis.get("confidence_score", 0.5))
            weighted_scores = scenario_by_key.get(key, [])
            scenario_confidence = sum(weighted_scores) / max(len(weighted_scores), 1) if weighted_scores else base_confidence
            confidence = clamp(0.65 * base_confidence + 0.35 * scenario_confidence)

            all_scores = [base_confidence]
            if weighted_scores:
                all_scores.extend(weighted_scores)
            disagreement = clamp(max(all_scores) - min(all_scores), 0.0, 1.0)
            agreement = clamp(1.0 - disagreement, 0.0, 1.0)

            status = "new" if confidence >= 0.62 and disagreement <= 0.4 else "ambiguous"
            suppression_reason = None
            if confidence < 0.5:
                status = "suppressed"
                suppression_reason = "insufficient_combined_confidence"

            decision = decisions.get(key)
            if isinstance(decision, dict):
                decision_status = decision.get("status")
                if isinstance(decision_status, str) and decision_status in ("new", "ambiguous", "suppressed"):
                    status = decision_status
                if isinstance(decision.get("confidence_score"), (int, float)):
                    confidence = clamp(float(decision["confidence_score"]))
                if isinstance(decision.get("agreement_score"), (int, float)):
                    agreement = clamp(float(decision["agreement_score"]), 0.0, 1.0)
                if isinstance(decision.get("disagreement_score"), (int, float)):
                    disagreement = clamp(float(decision["disagreement_score"]), 0.0, 1.0)
                if isinstance(decision.get("suppression_reason"), str):
                    suppression_reason = decision["suppression_reason"][:200]

            conflict_notes = None
            if disagreement > 0.3:
                conflict_notes = f"{agent_id} observed disagreement across scenario paths for {hypothesis.get('subject', 'subject')}."
            if isinstance(decisions.get(key, {}).get("conflict_notes"), str):
                conflict_notes = str(decisions[key]["conflict_notes"])[:300]

            synthesized_hypothesis = dict(hypothesis)
            synthesized_hypothesis["id"] = str(uuid4())
            synthesized_hypothesis["agent_id"] = agent_id
            synthesized_hypothesis["confidence_score"] = confidence
            synthesized_hypothesis["reasoning_summary"] = (
                f"{agent_id} synthesized direct and scenario evidence into one belief."
            )
            synthesized_hypothesis["created_at"] = now_iso()

            beliefs.append(
                {
                    "id": str(uuid4()),
                    "run_id": request.run_id,
                    "agent_id": agent_id,
                    "parent_hypothesis_ids": [hypothesis.get("id")] if hypothesis.get("id") else [],
                    "agreement_score": agreement,
                    "disagreement_score": disagreement,
                    "confidence_score": confidence,
                    "conflict_notes": conflict_notes,
                    "hypothesis": synthesized_hypothesis,
                    "status": status,
                    "suppression_reason": suppression_reason,
                    "linked_proposal_id": None,
                    "created_at": now_iso(),
                    "updated_at": now_iso(),
                }
            )
        return beliefs

    def _build_hypotheses_from_signals(
        self,
        request: SimulationRunRequestV1,
        agent_id: str,
        llm_payload: Any,
    ) -> List[Dict[str, Any]]:
        hypotheses: List[Dict[str, Any]] = []
        signal_map = {signal.id: signal for signal in request.signals}

        llm_hypotheses = []
        if isinstance(llm_payload, dict) and isinstance(llm_payload.get("hypotheses"), list):
            llm_hypotheses = [entry for entry in llm_payload["hypotheses"] if isinstance(entry, dict)]

        candidates: List[Dict[str, Any]] = []
        if request.event_cases:
            for event_case in request.event_cases:
                linked_signals = [
                    signal_map[signal_id]
                    for signal_id in event_case.source_signal_ids
                    if signal_id in signal_map
                ]
                anchor_signal = linked_signals[-1] if linked_signals else (request.signals[-1] if request.signals else None)
                if anchor_signal is None:
                    continue
                candidates.append(
                    {
                        "event_case_id": event_case.id,
                        "event_case_kind": event_case.kind,
                        "source_signal_ids": [signal.id for signal in linked_signals] or [anchor_signal.id],
                        "signal": anchor_signal,
                        "subject": str(event_case.primary_entity or anchor_signal.title),
                        "summary_title": event_case.title,
                        "source_types": list(event_case.source_types),
                    }
                )
        else:
            for signal in request.signals:
                candidates.append(
                    {
                        "event_case_id": None,
                        "event_case_kind": signal.source_type,
                        "source_signal_ids": [signal.id],
                        "signal": signal,
                        "subject": str(signal.payload.get("asset_symbol") or signal.payload.get("institution") or signal.title),
                        "summary_title": signal.title,
                        "source_types": [signal.source_type],
                    }
                )

        for candidate in candidates:
            signal = candidate["signal"]
            source_types = set(candidate["source_types"])
            source_kind = signal.source_type
            target_time = self._target_time_for(signal.effective_at)
            subject = candidate["subject"]
            category = self._category_for_candidate(subject=subject, source_types=source_types, signal=signal)
            predicate = self._event_occurrence_predicate(signal, candidate["summary_title"])
            kind = "event_occurrence"
            observation_path = signal.payload.get("observation_occurrence_path") or self._default_event_occurrence_path(signal)
            resolution_spec = (
                self._build_event_occurrence_spec(signal, str(observation_path))
                if isinstance(observation_path, str) and observation_path.strip()
                else None
            )

            if "economic_calendar" in source_types or source_kind == "economic_calendar":
                kind = "rate_decision"
                category = "economy"
                institution = str(signal.payload.get("institution") or subject or "Federal Reserve")
                subject = institution
                direction = str(
                    signal.payload.get("expected_direction")
                    or signal.payload.get("direction")
                    or "hold"
                ).lower()
                if direction not in {"cut", "hold", "hike"}:
                    direction = "hold"
                predicate = f"{institution} will {direction} rates by target date"
                resolution_spec = self._build_rate_decision_spec(signal, direction)
            elif "price_feed" in source_types or source_kind == "price_feed":
                kind = "price_threshold"
                try:
                    current = float(
                        signal.payload.get("price")
                        or signal.payload.get("close")
                        or signal.payload.get("current_price")
                        or 0
                    )
                except Exception:
                    current = 0.0
                threshold = round(current * 1.03, 2) if current > 0 else 100.0
                predicate = f"{subject} spot price >= {threshold} by target date"
                resolution_spec = self._build_price_threshold_spec(signal, threshold, "gte")

            llm_override = next(
                (
                    item
                    for item in llm_hypotheses
                    if str(item.get("source_signal_id", "")) in candidate["source_signal_ids"]
                    or str(item.get("event_case_id", "")) == str(candidate.get("event_case_id") or "")
                ),
                None,
            )
            confidence = 0.54 if kind == "event_occurrence" else 0.58
            reasoning = (
                f"{agent_id} formed a {kind} hypothesis from "
                f"{'event case ' + str(candidate['event_case_id']) if candidate.get('event_case_id') else 'signal ' + signal.id}."
            )
            if isinstance(llm_override, dict):
                if isinstance(llm_override.get("confidence_score"), (int, float)):
                    confidence = clamp(float(llm_override["confidence_score"]))
                if isinstance(llm_override.get("reasoning_summary"), str):
                    reasoning = llm_override["reasoning_summary"][:500]

            key = {
                "run_id": request.run_id,
                "signal_ids": candidate["source_signal_ids"],
                "event_case_id": candidate.get("event_case_id"),
                "kind": kind,
                "subject": subject,
                "predicate": predicate,
                "target_time": target_time,
            }
            machine_resolvable = resolution_spec is not None
            hypotheses.append(
                {
                    "id": str(uuid4()),
                    "run_id": request.run_id,
                    "agent_id": agent_id,
                    "parent_ids": [],
                    "hypothesis_kind": kind,
                    "category": category,
                    "subject": str(subject),
                    "predicate": predicate,
                    "target_time": target_time,
                    "confidence_score": confidence,
                    "reasoning_summary": reasoning,
                    "source_signal_ids": candidate["source_signal_ids"],
                    "machine_resolvable": machine_resolvable,
                    "suggested_resolution_spec": resolution_spec,
                    "dedupe_key": dedupe_key(key),
                    "created_at": now_iso(),
                }
            )
        return hypotheses

    def _target_time_for(self, effective_at: Optional[str]) -> str:
        if effective_at:
            try:
                base = datetime.fromisoformat(effective_at.replace("Z", "+00:00"))
                return (base + timedelta(days=3)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
            except Exception:
                pass
        return (utc_now() + timedelta(days=3)).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    def _category_for_candidate(
        self,
        subject: str,
        source_types: set[str],
        signal: Any,
    ) -> str:
        if "economic_calendar" in source_types:
            return "economy"
        if "price_feed" in source_types:
            return "crypto" if "BTC" in subject.upper() or "ETH" in subject.upper() else "markets"
        payload_category = signal.payload.get("category")
        if isinstance(payload_category, str) and payload_category.strip():
            normalized = payload_category.strip().lower()
            if normalized in {"met", "meteorological", "geo"}:
                return "weather"
            return normalized
        if "filing" in source_types:
            return "business"
        if "official_announcement" in source_types:
            return "world"
        return "news"

    def _event_occurrence_predicate(self, signal: Any, summary_title: str) -> str:
        publishability_class = str(signal.payload.get("publishability_class") or "").strip().lower()
        event_name = str(signal.payload.get("event_name") or signal.payload.get("event") or summary_title).strip() or summary_title
        if publishability_class == "official_news":
            return f"{event_name} will be officially announced by target date"
        if publishability_class == "weather_event":
            return f"{event_name} weather event will occur by target date"
        if publishability_class == "sports_event":
            return f"{event_name} sports event will occur by target date"
        return f"{event_name} will occur by target date"

    def _build_resolution_source_spec(self, signal: Any, canonical_url: str) -> Dict[str, Any]:
        source: Dict[str, Any] = {
            "adapter": "http_json",
            "canonical_url": canonical_url,
            "allowed_domains": [self._domain_of(canonical_url)],
        }
        extraction_mode = signal.payload.get("resolution_extraction_mode")
        if isinstance(extraction_mode, str) and extraction_mode in {"agent_extract", "deterministic_json"}:
            source["extraction_mode"] = extraction_mode
        elif self._should_default_agent_extract(signal):
            source["extraction_mode"] = "agent_extract"
        return source

    def _default_event_occurrence_path(self, signal: Any) -> Optional[str]:
        explicit = signal.payload.get("observation_occurrence_path")
        if isinstance(explicit, str) and explicit.strip():
            return explicit.strip()
        if self._should_default_agent_extract(signal):
            return "occurred"
        return None

    def _should_default_agent_extract(self, signal: Any) -> bool:
        adapter = str(getattr(signal, "source_adapter", "") or "").strip().lower()
        trust_tier = str(getattr(signal, "trust_tier", "") or "").strip().lower()
        return adapter in {"news_rss", "http_json_official_announcement", "opencli_command"} and trust_tier in {"official", "curated"}

    def _build_price_threshold_spec(
        self,
        signal: Any,
        threshold: float,
        operator: str,
    ) -> Optional[Dict[str, Any]]:
        canonical_url = str(signal.payload.get("canonical_source_url") or signal.source_url or "").strip()
        if not canonical_url or threshold <= 0:
            return None
        observation_path = str(signal.payload.get("observation_price_path") or "price").strip() or "price"
        return {
            "kind": "price_threshold",
            "source": self._build_resolution_source_spec(signal, canonical_url),
            "observation_schema": {
                "type": "object",
                "fields": {
                    "price": {"type": "number", "path": observation_path},
                    "observed_at": {"type": "string", "path": "observed_at", "required": False},
                },
            },
            "decision_rule": {
                "kind": "price_threshold",
                "observation_field": "price",
                "operator": operator,
                "threshold": threshold,
            },
            "quorum_rule": {
                "min_observations": 2,
                "min_distinct_collectors": 2,
                "agreement": "all",
            },
            "quarantine_rule": {
                "on_source_fetch_failure": True,
                "on_schema_validation_failure": True,
                "on_observation_conflict": True,
                "max_observation_age_seconds": 3600,
            },
        }

    def _build_rate_decision_spec(self, signal: Any, direction: str) -> Optional[Dict[str, Any]]:
        canonical_url = str(signal.payload.get("canonical_source_url") or signal.source_url or "").strip()
        if not canonical_url:
            return None
        return {
            "kind": "rate_decision",
            "source": self._build_resolution_source_spec(signal, canonical_url),
            "observation_schema": {
                "type": "object",
                "fields": {
                    "previous_upper_bound_bps": {"type": "number", "path": "previous_upper_bound_bps"},
                    "current_upper_bound_bps": {"type": "number", "path": "current_upper_bound_bps"},
                    "observed_at": {"type": "string", "path": "observed_at", "required": False},
                },
            },
            "decision_rule": {
                "kind": "rate_decision",
                "previous_field": "previous_upper_bound_bps",
                "current_field": "current_upper_bound_bps",
                "direction": direction,
            },
            "quorum_rule": {
                "min_observations": 2,
                "min_distinct_collectors": 2,
                "agreement": "all",
            },
            "quarantine_rule": {
                "on_source_fetch_failure": True,
                "on_schema_validation_failure": True,
                "on_observation_conflict": True,
                "max_observation_age_seconds": 3600,
            },
        }

    def _build_event_occurrence_spec(
        self,
        signal: Any,
        observation_path: str,
    ) -> Optional[Dict[str, Any]]:
        canonical_url = str(signal.payload.get("canonical_source_url") or signal.source_url or "").strip()
        normalized_path = observation_path.strip()
        if not canonical_url or not normalized_path:
            return None
        return {
            "kind": "event_occurrence",
            "source": self._build_resolution_source_spec(signal, canonical_url),
            "observation_schema": {
                "type": "object",
                "fields": {
                    "occurred": {"type": "boolean", "path": normalized_path},
                    "observed_at": {"type": "string", "path": "observed_at", "required": False},
                },
            },
            "decision_rule": {
                "kind": "event_occurrence",
                "observation_field": "occurred",
                "expected_value": True,
            },
            "quorum_rule": {
                "min_observations": 2,
                "min_distinct_collectors": 2,
                "agreement": "all",
            },
            "quarantine_rule": {
                "on_source_fetch_failure": True,
                "on_schema_validation_failure": True,
                "on_observation_conflict": True,
                "max_observation_age_seconds": 3600,
            },
        }

    async def _chat_json(self, system_prompt: str, user_payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if self.llm is None:
            return None
        endpoint = f"{self.llm.base_url}/chat/completions"
        body = {
            "model": self.llm.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=True)},
            ],
            "temperature": self.llm.temperature,
            "max_tokens": self.llm.max_tokens,
            "response_format": {"type": "json_object"},
        }

        timeout = httpx.Timeout(self.llm.timeout_seconds, connect=min(10.0, self.llm.timeout_seconds))
        headers = {"authorization": f"Bearer {self.llm.api_key}", "content-type": "application/json"}

        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(endpoint, headers=headers, json=body)
            response.raise_for_status()
            payload = response.json()

        content = (
            payload.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
        )
        if not isinstance(content, str) or not content.strip():
            return None
        content = content.strip()
        if content.startswith("```"):
            content = content.strip("`").strip()
            if content.startswith("json"):
                content = content[4:].strip()
        try:
            parsed = json.loads(content)
            if isinstance(parsed, dict):
                return parsed
            return None
        except json.JSONDecodeError:
            return None

    def _domain_of(self, url: str) -> str:
        try:
            host = url.split("//", 1)[1].split("/", 1)[0].lower()
            return host[4:] if host.startswith("www.") else host
        except Exception:
            return "unknown.local"

    def _collect_runtime_roles(self, request: SimulationRunRequestV1) -> List[str]:
        ordered: List[str] = []
        seen: set[str] = set()
        for role in (
            request.agent_roles.world_model
            + request.agent_roles.scenario
            + request.agent_roles.synthesis
        ):
            key = str(role).strip()
            if not key or key in seen:
                continue
            seen.add(key)
            ordered.append(key)
        if not ordered:
            ordered = [
                "world-model-alpha",
                "world-model-beta",
                "scenario-base",
                "scenario-bear",
                "synthesis-core",
            ]
        return ordered

    def _write_profiles(self, temp_dir: str, roles: Sequence[str]) -> str:
        if self.oasis_native.platform == "reddit":
            return self._write_reddit_profiles(temp_dir, roles)
        return self._write_twitter_profiles(temp_dir, roles)

    def _write_twitter_profiles(self, temp_dir: str, roles: Sequence[str]) -> str:
        path = os.path.join(temp_dir, "oasis_profiles_twitter.csv")
        with open(path, "w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(["user_id", "name", "username", "user_char", "description"])
            for idx, role in enumerate(roles):
                persona = (
                    f"{role} is an autonomous forecasting participant focused on extracting "
                    "causal signals, uncertainty, and market-facing implications."
                )
                writer.writerow(
                    [
                        idx,
                        role.replace("-", " ").title(),
                        role.replace("-", "_"),
                        persona,
                        f"{role} simulation participant",
                    ]
                )
        return path

    def _write_reddit_profiles(self, temp_dir: str, roles: Sequence[str]) -> str:
        path = os.path.join(temp_dir, "oasis_profiles_reddit.json")
        payload: List[Dict[str, Any]] = []
        for idx, role in enumerate(roles):
            payload.append(
                {
                    "user_id": idx,
                    "username": role.replace("-", "_"),
                    "name": role.replace("-", " ").title(),
                    "bio": f"{role} monitors macro and market narratives.",
                    "persona": (
                        "Autonomous agent that scans narratives, disputes assumptions, "
                        "and contributes probabilistic hypotheses."
                    ),
                    "karma": 500 + idx * 17,
                    "created_at": utc_now().strftime("%Y-%m-%d"),
                    "age": 30,
                    "gender": "other",
                    "mbti": "INTJ",
                    "country": "global",
                }
            )
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        return path

    def _select_active_ids(self, population_size: int) -> List[int]:
        if population_size <= 0:
            return []
        minimum = min(self.oasis_native.min_active_agents, population_size)
        maximum = min(max(minimum, self.oasis_native.max_active_agents), population_size)
        target = random.randint(minimum, maximum)
        return random.sample(list(range(population_size)), target)

    def _read_trace_stats(self, database_path: str) -> tuple[int, Dict[str, int]]:
        if not os.path.exists(database_path):
            return 0, {}
        row_count = 0
        action_counts: Dict[str, int] = {}
        try:
            connection = sqlite3.connect(database_path)
            cursor = connection.cursor()
            cursor.execute("SELECT COUNT(*) FROM trace")
            found = cursor.fetchone()
            if found and isinstance(found[0], int):
                row_count = int(found[0])
            cursor.execute("SELECT action, COUNT(*) FROM trace GROUP BY action")
            for action, count in cursor.fetchall():
                action_counts[str(action)] = int(count)
            connection.close()
        except Exception:
            return row_count, action_counts
        return row_count, action_counts

    def _top_subjects(self, request: SimulationRunRequestV1, limit: int = 5) -> List[str]:
        subjects: List[str] = []
        for event_case in request.event_cases:
            raw = event_case.primary_entity or event_case.title
            value = str(raw).strip()
            if value and value not in subjects:
                subjects.append(value)
            if len(subjects) >= limit:
                return subjects
        for signal in request.signals:
            raw = signal.payload.get("asset_symbol") or signal.payload.get("institution") or signal.title
            value = str(raw).strip()
            if value and value not in subjects:
                subjects.append(value)
            if len(subjects) >= limit:
                break
        return subjects
