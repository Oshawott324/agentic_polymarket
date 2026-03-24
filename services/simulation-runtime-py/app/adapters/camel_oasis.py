from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shlex
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


class CamelOasisAdapter:
    """
    Primary mode:
      - CAMEL/Oasis external runner process configured by CAMEL_OASIS_RUNNER_CMD.
    Fallback mode:
      - direct role-scoped LLM simulation under the same contracts.
    """

    def __init__(self) -> None:
        self.runner_cmd = os.getenv("CAMEL_OASIS_RUNNER_CMD", "").strip()
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
        if self.allow_direct_llm:
            return await self._execute_direct_mode(request, progress)
        raise RuntimeError(
            "simulation_runtime_not_configured: set CAMEL_OASIS_RUNNER_CMD or SIM_RUNTIME_ALLOW_DIRECT_LLM=true"
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
    ) -> tuple[Dict[str, Any], List[Dict[str, Any]]]:
        signal_ids = [signal.id for signal in request.signals]
        top_signal = request.signals[-1] if request.signals else None

        llm_payload = await self._chat_json(
            system_prompt=(
                "You are a world-model simulation agent. Return JSON only with keys "
                "regime_labels, reasoning_summary, and hypotheses."
            ),
            user_payload={
                "run_id": request.run_id,
                "agent_id": agent_id,
                "signals": [signal.model_dump() for signal in request.signals],
            },
        )

        regime_labels = []
        if isinstance(llm_payload, dict) and isinstance(llm_payload.get("regime_labels"), list):
            regime_labels = [str(entry) for entry in llm_payload["regime_labels"] if str(entry).strip()]
        if not regime_labels:
            regime_labels = ["mixed_regime"]

        reasoning_summary = f"{agent_id} processed {len(request.signals)} signals."
        if isinstance(llm_payload, dict) and isinstance(llm_payload.get("reasoning_summary"), str):
            reasoning_summary = llm_payload["reasoning_summary"][:500]

        entities = []
        for signal in request.signals:
            for ref in signal.entity_refs:
                kind = str(ref.get("kind", "event"))
                value = str(ref.get("value", "unknown"))
                entities.append(
                    {
                        "id": f"{kind}:{value}",
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

        world_state = {
            "id": str(uuid4()),
            "run_id": request.run_id,
            "agent_id": agent_id,
            "source_signal_ids": signal_ids,
            "as_of": now_iso(),
            "entities": entities,
            "active_events": [
                {
                    "id": signal.id,
                    "title": signal.title,
                    "event_type": signal.source_type,
                    "effective_at": signal.effective_at,
                    "source_signal_ids": [signal.id],
                }
                for signal in request.signals
            ],
            "factors": [
                {
                    "factor": "signal_velocity",
                    "value": clamp(len(request.signals) / 10, 0.2, 0.9),
                    "direction": "up",
                    "rationale": f"{agent_id} observed persistent upstream activity.",
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

        llm_hypotheses = []
        if isinstance(llm_payload, dict) and isinstance(llm_payload.get("hypotheses"), list):
            llm_hypotheses = [entry for entry in llm_payload["hypotheses"] if isinstance(entry, dict)]

        for signal in request.signals:
            source_kind = signal.source_type
            target_time = (utc_now() + timedelta(days=3)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
            category = "macro"
            subject = signal.payload.get("asset_symbol") or signal.payload.get("institution") or signal.title
            predicate = "event will occur"
            kind = "price_threshold"
            resolution_spec: Dict[str, Any]

            if source_kind == "economic_calendar":
                kind = "rate_decision"
                category = "economy"
                institution = str(signal.payload.get("institution") or "Federal Reserve")
                subject = institution
                direction = str(signal.payload.get("expected_direction") or "hold").lower()
                if direction not in {"cut", "hold", "hike"}:
                    direction = "hold"
                predicate = f"{institution} will {direction} rates by target date"
                resolution_spec = {
                    "kind": "rate_decision",
                    "source": {
                        "canonical_url": signal.source_url,
                        "allowed_domains": [self._domain_of(signal.source_url)],
                        "adapter": "http_json",
                    },
                    "observation_schema": {"required": ["direction", "effective_at"]},
                    "decision_rule": {"direction": direction},
                    "quorum_rule": {"threshold": 2},
                    "quarantine_rule": {"on_conflict": "quarantine"},
                }
            else:
                kind = "price_threshold"
                category = "crypto" if "BTC" in str(subject).upper() or "ETH" in str(subject).upper() else "markets"
                try:
                    current = float(signal.payload.get("price", 0))
                except Exception:
                    current = 0.0
                threshold = round(current * 1.03, 2) if current > 0 else 100.0
                predicate = f"{subject} spot price >= {threshold} by target date"
                resolution_spec = {
                    "kind": "price_threshold",
                    "source": {
                        "canonical_url": signal.source_url,
                        "allowed_domains": [self._domain_of(signal.source_url)],
                        "adapter": "http_json",
                    },
                    "observation_schema": {"required": ["price", "timestamp"]},
                    "decision_rule": {"operator": "gte", "threshold": threshold},
                    "quorum_rule": {"threshold": 2},
                    "quarantine_rule": {"on_conflict": "quarantine"},
                }

            llm_override = next(
                (
                    item
                    for item in llm_hypotheses
                    if str(item.get("source_signal_id", "")) == signal.id
                ),
                None,
            )
            confidence = 0.58
            reasoning = f"{agent_id} formed a hypothesis from signal {signal.id}."
            if isinstance(llm_override, dict):
                if isinstance(llm_override.get("confidence_score"), (int, float)):
                    confidence = clamp(float(llm_override["confidence_score"]))
                if isinstance(llm_override.get("reasoning_summary"), str):
                    reasoning = llm_override["reasoning_summary"][:500]

            key = {
                "run_id": request.run_id,
                "signal_id": signal.id,
                "kind": kind,
                "subject": subject,
                "predicate": predicate,
                "target_time": target_time,
            }
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
                    "source_signal_ids": [signal.id],
                    "machine_resolvable": True,
                    "suggested_resolution_spec": resolution_spec,
                    "dedupe_key": dedupe_key(key),
                    "created_at": now_iso(),
                }
            )
        return hypotheses

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
