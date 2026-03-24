import {
  type SimulationRunRequestV1,
  type SimulationRunResultV1,
  type SimulationRunStatusV1,
  validateSimulationRunResultV1,
  validateSimulationRunStatusV1,
} from "@automakit/sim-runtime-contracts";

export type SimulationRuntimeBackend = "internal" | "camel_oasis_http";

export type SimulationRuntimeClient = {
  submitRun(request: SimulationRunRequestV1): Promise<{ runtime_run_id: string }>;
  getRunStatus(runtimeRunId: string): Promise<SimulationRunStatusV1>;
  getRunResult(runtimeRunId: string): Promise<SimulationRunResultV1>;
};

type HttpSimulationRuntimeClientOptions = {
  baseUrl: string;
  submitTimeoutMs: number;
  requestTimeoutMs: number;
};

function buildTimeoutSignal(timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

class HttpSimulationRuntimeClient implements SimulationRuntimeClient {
  private readonly baseUrl: string;
  private readonly submitTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(options: HttpSimulationRuntimeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.submitTimeoutMs = options.submitTimeoutMs;
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  async submitRun(request: SimulationRunRequestV1) {
    const timeout = buildTimeoutSignal(this.submitTimeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/v1/runtime/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: timeout.signal,
      });

      const payload = (await response.json()) as { runtime_run_id?: string; error?: string };
      if (!response.ok || !payload.runtime_run_id) {
        throw new Error(payload.error ?? `simulation_runtime_submit_failed:${response.status}`);
      }
      return { runtime_run_id: payload.runtime_run_id };
    } finally {
      timeout.clear();
    }
  }

  async getRunStatus(runtimeRunId: string) {
    const timeout = buildTimeoutSignal(this.requestTimeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/v1/runtime/runs/${runtimeRunId}`, {
        signal: timeout.signal,
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`simulation_runtime_status_failed:${response.status}:${body}`);
      }
      const payload = (await response.json()) as unknown;
      const validation = validateSimulationRunStatusV1(payload);
      if (!validation.ok) {
        throw new Error(`invalid_simulation_runtime_status:${validation.errors.join(",")}`);
      }
      return validation.status;
    } finally {
      timeout.clear();
    }
  }

  async getRunResult(runtimeRunId: string) {
    const timeout = buildTimeoutSignal(this.requestTimeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/v1/runtime/runs/${runtimeRunId}/result`, {
        signal: timeout.signal,
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`simulation_runtime_result_failed:${response.status}:${body}`);
      }
      const payload = (await response.json()) as unknown;
      const validation = validateSimulationRunResultV1(payload);
      if (!validation.ok) {
        throw new Error(`invalid_simulation_runtime_result:${validation.errors.join(",")}`);
      }
      return validation.result;
    } finally {
      timeout.clear();
    }
  }
}

export function createSimulationRuntimeClient(options: {
  backend: SimulationRuntimeBackend;
  runtimeUrl: string;
  submitTimeoutMs: number;
  requestTimeoutMs: number;
}) {
  if (options.backend === "internal") {
    return null;
  }

  if (options.backend === "camel_oasis_http") {
    return new HttpSimulationRuntimeClient({
      baseUrl: options.runtimeUrl,
      submitTimeoutMs: options.submitTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
    });
  }

  throw new Error(`unsupported_simulation_runtime_backend:${String(options.backend)}`);
}
