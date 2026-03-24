import {
  type BeliefHypothesisProposal,
  type ScenarioPathProposal,
  type SynthesizedBelief,
  type WorldSignal,
  type WorldStateProposal,
  validateBeliefHypothesisProposal,
  validateScenarioPathProposal,
  validateSynthesizedBelief,
  validateWorldSignal,
  validateWorldStateProposal,
} from "@automakit/world-sim";

export const SIM_RUNTIME_CONTRACT_VERSION_V1 = "sim-runtime.v1";

export type SimulationContractVersion = typeof SIM_RUNTIME_CONTRACT_VERSION_V1;

export type SimulationAgentRoles = {
  world_model: string[];
  scenario: string[];
  synthesis: string[];
};

export type SimulationRunTimeouts = {
  submit_timeout_ms: number;
  run_timeout_ms: number;
  status_poll_interval_ms: number;
};

export type SimulationRunRequestV1 = {
  contract_version: SimulationContractVersion;
  run_id: string;
  trace_id: string;
  submitted_at: string;
  signals: WorldSignal[];
  agent_roles: SimulationAgentRoles;
  timeouts: SimulationRunTimeouts;
};

export type SimulationRunState = "queued" | "running" | "succeeded" | "failed";
export type SimulationProgressPhase = "world_model" | "scenario" | "synthesis" | "complete";

export type SimulationRunStatusV1 = {
  contract_version: SimulationContractVersion;
  run_id: string;
  runtime_run_id: string;
  state: SimulationRunState;
  progress: {
    phase: SimulationProgressPhase;
    percent: number;
  };
  error?: string | null;
  updated_at: string;
};

export type SimulationOutputsV1 = {
  world_state_proposals: WorldStateProposal[];
  direct_hypotheses: BeliefHypothesisProposal[];
  scenario_path_proposals: ScenarioPathProposal[];
  synthesized_beliefs: SynthesizedBelief[];
};

export type SimulationRunResultV1 = {
  contract_version: SimulationContractVersion;
  run_id: string;
  runtime_run_id: string;
  completed_at: string;
  outputs: SimulationOutputsV1;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value);
}

function hasStringArray(value: unknown) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function validateSimulationRunRequestV1(request: unknown) {
  const errors: string[] = [];
  if (!isObject(request)) {
    return { ok: false as const, errors: ["simulation_run_request_must_be_object"] };
  }

  const candidate = request as Partial<SimulationRunRequestV1>;
  if (candidate.contract_version !== SIM_RUNTIME_CONTRACT_VERSION_V1) {
    errors.push("simulation_run_request_contract_version_invalid");
  }
  if (!candidate.run_id) {
    errors.push("simulation_run_request_run_id_required");
  }
  if (!candidate.trace_id) {
    errors.push("simulation_run_request_trace_id_required");
  }
  if (!candidate.submitted_at) {
    errors.push("simulation_run_request_submitted_at_required");
  }
  if (!Array.isArray(candidate.signals) || candidate.signals.length === 0) {
    errors.push("simulation_run_request_signals_required");
  } else {
    for (const signal of candidate.signals) {
      const validation = validateWorldSignal(signal);
      if (!validation.ok) {
        errors.push(...validation.errors.map((entry: string) => `simulation_run_request_${entry}`));
      }
    }
  }

  if (!candidate.agent_roles || typeof candidate.agent_roles !== "object") {
    errors.push("simulation_run_request_agent_roles_required");
  } else {
    if (!hasStringArray(candidate.agent_roles.world_model)) {
      errors.push("simulation_run_request_world_model_roles_required");
    }
    if (!hasStringArray(candidate.agent_roles.scenario)) {
      errors.push("simulation_run_request_scenario_roles_required");
    }
    if (!hasStringArray(candidate.agent_roles.synthesis)) {
      errors.push("simulation_run_request_synthesis_roles_required");
    }
  }

  if (!candidate.timeouts || typeof candidate.timeouts !== "object") {
    errors.push("simulation_run_request_timeouts_required");
  } else {
    if (!isFiniteNumber(candidate.timeouts.submit_timeout_ms) || candidate.timeouts.submit_timeout_ms <= 0) {
      errors.push("simulation_run_request_submit_timeout_invalid");
    }
    if (!isFiniteNumber(candidate.timeouts.run_timeout_ms) || candidate.timeouts.run_timeout_ms <= 0) {
      errors.push("simulation_run_request_run_timeout_invalid");
    }
    if (
      !isFiniteNumber(candidate.timeouts.status_poll_interval_ms) ||
      candidate.timeouts.status_poll_interval_ms <= 0
    ) {
      errors.push("simulation_run_request_status_poll_interval_invalid");
    }
  }

  return errors.length > 0
    ? { ok: false as const, errors }
    : { ok: true as const, request: candidate as SimulationRunRequestV1 };
}

export function validateSimulationRunStatusV1(status: unknown) {
  const errors: string[] = [];
  if (!isObject(status)) {
    return { ok: false as const, errors: ["simulation_run_status_must_be_object"] };
  }

  const candidate = status as Partial<SimulationRunStatusV1>;
  if (candidate.contract_version !== SIM_RUNTIME_CONTRACT_VERSION_V1) {
    errors.push("simulation_run_status_contract_version_invalid");
  }
  if (!candidate.run_id) {
    errors.push("simulation_run_status_run_id_required");
  }
  if (!candidate.runtime_run_id) {
    errors.push("simulation_run_status_runtime_run_id_required");
  }
  if (!candidate.state || !["queued", "running", "succeeded", "failed"].includes(candidate.state)) {
    errors.push("simulation_run_status_state_invalid");
  }

  if (!candidate.progress || typeof candidate.progress !== "object") {
    errors.push("simulation_run_status_progress_required");
  } else {
    const phase = candidate.progress.phase;
    if (!phase || !["world_model", "scenario", "synthesis", "complete"].includes(phase)) {
      errors.push("simulation_run_status_progress_phase_invalid");
    }
    if (!isFiniteNumber(candidate.progress.percent) || candidate.progress.percent < 0 || candidate.progress.percent > 100) {
      errors.push("simulation_run_status_progress_percent_invalid");
    }
  }

  if (!candidate.updated_at) {
    errors.push("simulation_run_status_updated_at_required");
  }

  return errors.length > 0
    ? { ok: false as const, errors }
    : { ok: true as const, status: candidate as SimulationRunStatusV1 };
}

export function validateSimulationRunResultV1(result: unknown) {
  const errors: string[] = [];
  if (!isObject(result)) {
    return { ok: false as const, errors: ["simulation_run_result_must_be_object"] };
  }

  const candidate = result as Partial<SimulationRunResultV1>;
  if (candidate.contract_version !== SIM_RUNTIME_CONTRACT_VERSION_V1) {
    errors.push("simulation_run_result_contract_version_invalid");
  }
  if (!candidate.run_id) {
    errors.push("simulation_run_result_run_id_required");
  }
  if (!candidate.runtime_run_id) {
    errors.push("simulation_run_result_runtime_run_id_required");
  }
  if (!candidate.completed_at) {
    errors.push("simulation_run_result_completed_at_required");
  }

  if (!candidate.outputs || typeof candidate.outputs !== "object") {
    errors.push("simulation_run_result_outputs_required");
  } else {
    if (!Array.isArray(candidate.outputs.world_state_proposals)) {
      errors.push("simulation_run_result_world_state_proposals_required");
    } else {
      for (const proposal of candidate.outputs.world_state_proposals) {
        const validation = validateWorldStateProposal(proposal);
        if (!validation.ok) {
          errors.push(...validation.errors.map((entry: string) => `simulation_run_result_${entry}`));
        }
      }
    }

    if (!Array.isArray(candidate.outputs.direct_hypotheses)) {
      errors.push("simulation_run_result_direct_hypotheses_required");
    } else {
      for (const proposal of candidate.outputs.direct_hypotheses) {
        const validation = validateBeliefHypothesisProposal(proposal);
        if (!validation.ok) {
          errors.push(...validation.errors.map((entry: string) => `simulation_run_result_${entry}`));
        }
      }
    }

    if (!Array.isArray(candidate.outputs.scenario_path_proposals)) {
      errors.push("simulation_run_result_scenario_path_proposals_required");
    } else {
      for (const proposal of candidate.outputs.scenario_path_proposals) {
        const validation = validateScenarioPathProposal(proposal);
        if (!validation.ok) {
          errors.push(...validation.errors.map((entry: string) => `simulation_run_result_${entry}`));
        }
      }
    }

    if (!Array.isArray(candidate.outputs.synthesized_beliefs)) {
      errors.push("simulation_run_result_synthesized_beliefs_required");
    } else {
      for (const belief of candidate.outputs.synthesized_beliefs) {
        const validation = validateSynthesizedBelief(belief);
        if (!validation.ok) {
          errors.push(...validation.errors.map((entry: string) => `simulation_run_result_${entry}`));
        }
      }
    }
  }

  return errors.length > 0
    ? { ok: false as const, errors }
    : { ok: true as const, result: candidate as SimulationRunResultV1 };
}
