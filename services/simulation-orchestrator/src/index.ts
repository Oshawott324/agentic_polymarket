import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  createDatabasePool,
  ensureCoreSchema,
  parseJsonField,
  toIsoTimestamp,
} from "@automakit/persistence";
import {
  SIM_RUNTIME_CONTRACT_VERSION_V1,
  type SimulationRunRequestV1,
  validateSimulationRunRequestV1,
} from "@automakit/sim-runtime-contracts";
import {
  buildDedupeKey,
  type BeliefHypothesisProposal,
  type ScenarioPathProposal,
  type SimulationRunStatus,
  type SynthesizedBelief,
  type WorldSignal,
  type WorldStateProposal,
  validateBeliefHypothesisProposal,
  validateScenarioPathProposal,
  validateSynthesizedBelief,
  validateWorldStateProposal,
} from "@automakit/world-sim";
import {
  createSimulationRuntimeClient,
  type SimulationRuntimeBackend,
} from "./runtime-client.js";

type SignalSummaryRow = {
  id: string;
  dedupe_key: string;
  created_at: unknown;
};

type WorldSignalRow = {
  id: string;
  source_type: WorldSignal["source_type"];
  source_adapter: WorldSignal["source_adapter"];
  source_id: string;
  source_url: string;
  trust_tier: WorldSignal["trust_tier"];
  title: string;
  summary: string;
  payload: unknown;
  entity_refs: unknown;
  dedupe_key: string;
  fetched_at: unknown;
  effective_at: unknown;
  created_at: unknown;
};

type SimulationRunRow = {
  id: string;
  run_type: string;
  trigger_signal_ids: unknown;
  trigger_dedupe_key: string;
  status: SimulationRunStatus;
  started_at: unknown;
  completed_at: unknown;
  failure_reason: string | null;
  last_updated_at: unknown;
};

type SimulationRuntimeRunRow = {
  run_id: string;
  backend: string;
  contract_version: string;
  runtime_run_id: string;
  status: string;
  last_error: string | null;
  last_checked_at: unknown;
  created_at: unknown;
  updated_at: unknown;
  completed_at: unknown;
};

const port = Number(process.env.SIMULATION_ORCHESTRATOR_PORT ?? 4013);
const intervalMs = Number(process.env.SIMULATION_ORCHESTRATOR_INTERVAL_MS ?? 1000);
const signalWindow = Number(process.env.SIMULATION_ORCHESTRATOR_SIGNAL_WINDOW ?? 8);
const worldModelRequiredCount = Number(process.env.SIMULATION_WORLD_MODEL_REQUIRED ?? 1);
const scenarioRequiredCount = Number(process.env.SIMULATION_SCENARIO_REQUIRED ?? 1);
const synthesisRequiredCount = Number(process.env.SIMULATION_SYNTHESIS_REQUIRED ?? 1);
const runtimeBackend = (process.env.SIMULATION_RUNTIME_BACKEND ?? "internal") as SimulationRuntimeBackend;
const runtimeUrl = process.env.SIMULATION_RUNTIME_URL ?? "http://localhost:4016";
const runtimeSubmitTimeoutMs = Number(process.env.SIMULATION_RUNTIME_SUBMIT_TIMEOUT_MS ?? 15_000);
const runtimeRequestTimeoutMs = Number(process.env.SIMULATION_RUNTIME_REQUEST_TIMEOUT_MS ?? 15_000);
const simulationRunTimeoutMs = Number(process.env.SIMULATION_RUNTIME_RUN_TIMEOUT_MS ?? 120_000);
const simulationPollIntervalMs = Number(process.env.SIMULATION_RUNTIME_POLL_INTERVAL_MS ?? 1_000);
const simulationTracePrefix = process.env.SIMULATION_TRACE_PREFIX ?? "sim-orchestrator";
const runtimeContractVersion = SIM_RUNTIME_CONTRACT_VERSION_V1;
const runtimeRolesWorldModel = (process.env.SIMULATION_RUNTIME_WORLD_MODEL_ROLES ?? "world-model-alpha,world-model-beta")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const runtimeRolesScenario = (process.env.SIMULATION_RUNTIME_SCENARIO_ROLES ?? "scenario-base,scenario-bear")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const runtimeRolesSynthesis = (process.env.SIMULATION_RUNTIME_SYNTHESIS_ROLES ?? "synthesis-core")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

const app = Fastify({ logger: true });
const pool = createDatabasePool();

const runtimeClient = createSimulationRuntimeClient({
  backend: runtimeBackend,
  runtimeUrl,
  submitTimeoutMs: runtimeSubmitTimeoutMs,
  requestTimeoutMs: runtimeRequestTimeoutMs,
});

let tickInFlight = false;
let lastTickAt: string | null = null;
let lastTickError: string | null = null;

function mapRunRow(row: SimulationRunRow) {
  return {
    id: row.id,
    run_type: row.run_type,
    trigger_signal_ids: parseJsonField<string[]>(row.trigger_signal_ids),
    trigger_dedupe_key: row.trigger_dedupe_key,
    status: row.status,
    started_at: toIsoTimestamp(row.started_at),
    completed_at: row.completed_at ? toIsoTimestamp(row.completed_at) : null,
    failure_reason: row.failure_reason,
    last_updated_at: toIsoTimestamp(row.last_updated_at),
  };
}

function mapRuntimeRunRow(row: SimulationRuntimeRunRow) {
  return {
    run_id: row.run_id,
    backend: row.backend,
    contract_version: row.contract_version,
    runtime_run_id: row.runtime_run_id,
    status: row.status,
    last_error: row.last_error,
    last_checked_at: toIsoTimestamp(row.last_checked_at),
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
    completed_at: row.completed_at ? toIsoTimestamp(row.completed_at) : null,
  };
}

function mapSignalRow(row: WorldSignalRow): WorldSignal {
  return {
    id: row.id,
    source_type: row.source_type,
    source_adapter: row.source_adapter,
    source_id: row.source_id,
    source_url: row.source_url,
    trust_tier: row.trust_tier,
    title: row.title,
    summary: row.summary,
    payload: parseJsonField<Record<string, unknown>>(row.payload),
    entity_refs: parseJsonField(row.entity_refs) as WorldSignal["entity_refs"],
    dedupe_key: row.dedupe_key,
    fetched_at: toIsoTimestamp(row.fetched_at),
    effective_at: row.effective_at ? toIsoTimestamp(row.effective_at) : null,
    created_at: toIsoTimestamp(row.created_at),
  };
}

async function fetchLatestSignals(limit: number) {
  const result = await pool.query<SignalSummaryRow>(
    `
      SELECT id, dedupe_key, created_at
      FROM world_signals
      WHERE NOT (
        source_type = 'price_feed'
        AND COALESCE(payload->>'kind', '') = 'price_threshold'
      )
      ORDER BY created_at DESC, id DESC
      LIMIT $1
    `,
    [limit],
  );

  return result.rows.reverse();
}

async function fetchSignalsByIds(signalIds: string[]) {
  if (signalIds.length === 0) {
    return [];
  }

  const result = await pool.query<WorldSignalRow>(
    `
      SELECT *
      FROM world_signals
      WHERE id = ANY($1::text[])
        AND NOT (
          source_type = 'price_feed'
          AND COALESCE(payload->>'kind', '') = 'price_threshold'
        )
      ORDER BY created_at ASC, id ASC
    `,
    [signalIds],
  );

  return result.rows.map(mapSignalRow);
}

async function ensureCurrentRun() {
  const signals = await fetchLatestSignals(signalWindow);
  if (signals.length === 0) {
    return null;
  }

  const triggerSignalIds = signals.map((signal) => signal.id);
  const triggerDedupeKey = buildDedupeKey({
    trigger_signal_ids: triggerSignalIds,
    signal_dedupe_keys: signals.map((signal) => signal.dedupe_key),
  });

  const existing = await pool.query<Pick<SimulationRunRow, "id">>(
    `
      SELECT id
      FROM simulation_runs
      WHERE trigger_dedupe_key = $1
      LIMIT 1
    `,
    [triggerDedupeKey],
  );

  if (existing.rowCount) {
    return existing.rows[0].id;
  }

  const now = new Date().toISOString();
  const runId = randomUUID();
  await pool.query(
    `
      INSERT INTO simulation_runs (
        id,
        run_type,
        trigger_signal_ids,
        trigger_dedupe_key,
        status,
        started_at,
        last_updated_at
      )
      VALUES ($1, $2, $3::jsonb, $4, $5, $6::timestamptz, $7::timestamptz)
      ON CONFLICT (trigger_dedupe_key) DO NOTHING
    `,
    [runId, "belief_refresh", JSON.stringify(triggerSignalIds), triggerDedupeKey, "world_model_pending", now, now],
  );

  return runId;
}

async function countDistinct(query: string, params: unknown[]) {
  const result = await pool.query<{ count: string }>(query, params);
  return Number(result.rows[0]?.count ?? 0);
}

async function transitionRuns() {
  const result = await pool.query<SimulationRunRow>(
    `
      SELECT *
      FROM simulation_runs
      WHERE status IN ('world_model_pending', 'scenario_pending', 'synthesis_pending', 'ready_for_proposal')
      ORDER BY started_at ASC, id ASC
    `,
  );

  for (const row of result.rows) {
    const run = mapRunRow(row);

    if (run.status === "world_model_pending") {
      const worldStateCount = await countDistinct(
        `
          SELECT COUNT(DISTINCT agent_id)::text AS count
          FROM world_state_proposals
          WHERE run_id = $1
        `,
        [run.id],
      );
      const directHypothesisCount = await countDistinct(
        `
          SELECT COUNT(*)::text AS count
          FROM belief_hypothesis_proposals
          WHERE run_id = $1
        `,
        [run.id],
      );

      if (worldStateCount >= worldModelRequiredCount && directHypothesisCount > 0) {
        await pool.query(
          `
            UPDATE simulation_runs
            SET status = 'scenario_pending', last_updated_at = NOW()
            WHERE id = $1
          `,
          [run.id],
        );
      }
      continue;
    }

    if (run.status === "scenario_pending") {
      const scenarioCount = await countDistinct(
        `
          SELECT COUNT(DISTINCT agent_id)::text AS count
          FROM scenario_path_proposals
          WHERE run_id = $1
        `,
        [run.id],
      );
      if (scenarioCount >= scenarioRequiredCount) {
        await pool.query(
          `
            UPDATE simulation_runs
            SET status = 'synthesis_pending', last_updated_at = NOW()
            WHERE id = $1
          `,
          [run.id],
        );
      }
      continue;
    }

    if (run.status === "synthesis_pending") {
      const synthesisCount = await countDistinct(
        `
          SELECT COUNT(DISTINCT agent_id)::text AS count
          FROM synthesized_beliefs
          WHERE run_id = $1
        `,
        [run.id],
      );
      if (synthesisCount >= synthesisRequiredCount) {
        await pool.query(
          `
            UPDATE simulation_runs
            SET status = 'ready_for_proposal', last_updated_at = NOW()
            WHERE id = $1
          `,
          [run.id],
        );
      }
      continue;
    }

    if (run.status === "ready_for_proposal") {
      const pendingBeliefs = await countDistinct(
        `
          SELECT COUNT(*)::text AS count
          FROM synthesized_beliefs
          WHERE run_id = $1
            AND status = 'new'
        `,
        [run.id],
      );
      const totalBeliefs = await countDistinct(
        `
          SELECT COUNT(*)::text AS count
          FROM synthesized_beliefs
          WHERE run_id = $1
        `,
        [run.id],
      );

      if (totalBeliefs > 0 && pendingBeliefs === 0) {
        await pool.query(
          `
            UPDATE simulation_runs
            SET
              status = 'completed',
              completed_at = NOW(),
              last_updated_at = NOW()
            WHERE id = $1
          `,
          [run.id],
        );
      }
    }
  }
}

async function fetchRunsPendingRuntimeDispatch(limit: number) {
  const result = await pool.query<SimulationRunRow>(
    `
      SELECT runs.*
      FROM simulation_runs runs
      LEFT JOIN simulation_runtime_runs runtime_runs
        ON runtime_runs.run_id = runs.id
      WHERE runs.status = 'world_model_pending'
        AND runtime_runs.run_id IS NULL
      ORDER BY runs.started_at ASC, runs.id ASC
      LIMIT $1
    `,
    [limit],
  );

  return result.rows.map(mapRunRow);
}

async function fetchActiveRuntimeRuns(limit: number) {
  const result = await pool.query<SimulationRuntimeRunRow>(
    `
      SELECT *
      FROM simulation_runtime_runs
      WHERE status IN ('queued', 'running')
      ORDER BY created_at ASC, run_id ASC
      LIMIT $1
    `,
    [limit],
  );

  return result.rows.map(mapRuntimeRunRow);
}

function buildRuntimeRequest(run: ReturnType<typeof mapRunRow>, signals: WorldSignal[]): SimulationRunRequestV1 {
  return {
    contract_version: runtimeContractVersion,
    run_id: run.id,
    trace_id: `${simulationTracePrefix}-${run.id}`,
    submitted_at: new Date().toISOString(),
    signals,
    agent_roles: {
      world_model: runtimeRolesWorldModel,
      scenario: runtimeRolesScenario,
      synthesis: runtimeRolesSynthesis,
    },
    timeouts: {
      submit_timeout_ms: runtimeSubmitTimeoutMs,
      run_timeout_ms: simulationRunTimeoutMs,
      status_poll_interval_ms: simulationPollIntervalMs,
    },
  };
}

async function persistWorldStateProposals(proposals: WorldStateProposal[]) {
  for (const proposal of proposals) {
    const validation = validateWorldStateProposal(proposal);
    if (!validation.ok) {
      throw new Error(`invalid_world_state_proposal:${validation.errors.join(",")}`);
    }
    await pool.query(
      `
        INSERT INTO world_state_proposals (
          id,
          run_id,
          agent_id,
          source_signal_ids,
          as_of,
          entities,
          active_events,
          factors,
          regime_labels,
          reasoning_summary,
          created_at
        )
        VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::timestamptz)
        ON CONFLICT (run_id, agent_id) DO UPDATE SET
          source_signal_ids = EXCLUDED.source_signal_ids,
          as_of = EXCLUDED.as_of,
          entities = EXCLUDED.entities,
          active_events = EXCLUDED.active_events,
          factors = EXCLUDED.factors,
          regime_labels = EXCLUDED.regime_labels,
          reasoning_summary = EXCLUDED.reasoning_summary,
          created_at = EXCLUDED.created_at
      `,
      [
        proposal.id,
        proposal.run_id,
        proposal.agent_id,
        JSON.stringify(proposal.source_signal_ids),
        proposal.as_of,
        JSON.stringify(proposal.entities),
        JSON.stringify(proposal.active_events),
        JSON.stringify(proposal.factors),
        JSON.stringify(proposal.regime_labels),
        proposal.reasoning_summary,
        proposal.created_at,
      ],
    );
  }
}

async function persistDirectHypotheses(proposals: BeliefHypothesisProposal[]) {
  for (const proposal of proposals) {
    const validation = validateBeliefHypothesisProposal(proposal);
    if (!validation.ok) {
      throw new Error(`invalid_belief_hypothesis_proposal:${validation.errors.join(",")}`);
    }
    await pool.query(
      `
        INSERT INTO belief_hypothesis_proposals (
          id,
          run_id,
          agent_id,
          parent_ids,
          hypothesis_kind,
          category,
          subject,
          predicate,
          target_time,
          confidence_score,
          reasoning_summary,
          source_signal_ids,
          machine_resolvable,
          suggested_resolution_spec,
          dedupe_key,
          created_at
        )
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::timestamptz, $10, $11, $12::jsonb, $13, $14::jsonb, $15, $16::timestamptz)
        ON CONFLICT (run_id, agent_id, dedupe_key) DO UPDATE SET
          confidence_score = EXCLUDED.confidence_score,
          reasoning_summary = EXCLUDED.reasoning_summary,
          source_signal_ids = EXCLUDED.source_signal_ids,
          machine_resolvable = EXCLUDED.machine_resolvable,
          suggested_resolution_spec = EXCLUDED.suggested_resolution_spec,
          created_at = EXCLUDED.created_at
      `,
      [
        proposal.id,
        proposal.run_id,
        proposal.agent_id,
        JSON.stringify(proposal.parent_ids),
        proposal.hypothesis_kind,
        proposal.category,
        proposal.subject,
        proposal.predicate,
        proposal.target_time,
        proposal.confidence_score,
        proposal.reasoning_summary,
        JSON.stringify(proposal.source_signal_ids),
        proposal.machine_resolvable,
        proposal.suggested_resolution_spec ? JSON.stringify(proposal.suggested_resolution_spec) : null,
        proposal.dedupe_key,
        proposal.created_at,
      ],
    );
  }
}

async function persistScenarioPathProposals(proposals: ScenarioPathProposal[]) {
  for (const proposal of proposals) {
    const validation = validateScenarioPathProposal(proposal);
    if (!validation.ok) {
      throw new Error(`invalid_scenario_path_proposal:${validation.errors.join(",")}`);
    }
    await pool.query(
      `
        INSERT INTO scenario_path_proposals (
          id,
          run_id,
          agent_id,
          label,
          probability,
          narrative,
          factor_deltas,
          path_events,
          path_hypotheses,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::timestamptz)
        ON CONFLICT (run_id, agent_id) DO UPDATE SET
          label = EXCLUDED.label,
          probability = EXCLUDED.probability,
          narrative = EXCLUDED.narrative,
          factor_deltas = EXCLUDED.factor_deltas,
          path_events = EXCLUDED.path_events,
          path_hypotheses = EXCLUDED.path_hypotheses,
          created_at = EXCLUDED.created_at
      `,
      [
        proposal.id,
        proposal.run_id,
        proposal.agent_id,
        proposal.label,
        proposal.probability,
        proposal.narrative,
        JSON.stringify(proposal.factor_deltas),
        JSON.stringify(proposal.path_events),
        JSON.stringify(proposal.path_hypotheses),
        proposal.created_at,
      ],
    );
  }
}

async function persistSynthesizedBeliefs(beliefs: SynthesizedBelief[]) {
  for (const belief of beliefs) {
    const validation = validateSynthesizedBelief(belief);
    if (!validation.ok) {
      throw new Error(`invalid_synthesized_belief:${validation.errors.join(",")}`);
    }
    await pool.query(
      `
        INSERT INTO synthesized_beliefs (
          id,
          run_id,
          agent_id,
          belief_dedupe_key,
          parent_hypothesis_ids,
          agreement_score,
          disagreement_score,
          confidence_score,
          conflict_notes,
          hypothesis,
          status,
          suppression_reason,
          linked_proposal_id,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14::timestamptz, $15::timestamptz)
        ON CONFLICT (run_id, agent_id, belief_dedupe_key) DO UPDATE SET
          parent_hypothesis_ids = EXCLUDED.parent_hypothesis_ids,
          agreement_score = EXCLUDED.agreement_score,
          disagreement_score = EXCLUDED.disagreement_score,
          confidence_score = EXCLUDED.confidence_score,
          conflict_notes = EXCLUDED.conflict_notes,
          hypothesis = EXCLUDED.hypothesis,
          status = EXCLUDED.status,
          suppression_reason = EXCLUDED.suppression_reason,
          linked_proposal_id = EXCLUDED.linked_proposal_id,
          updated_at = EXCLUDED.updated_at
      `,
      [
        belief.id,
        belief.run_id,
        belief.agent_id,
        belief.hypothesis.dedupe_key,
        JSON.stringify(belief.parent_hypothesis_ids),
        belief.agreement_score,
        belief.disagreement_score,
        belief.confidence_score,
        belief.conflict_notes ?? null,
        JSON.stringify(belief.hypothesis),
        belief.status,
        belief.suppression_reason ?? null,
        belief.linked_proposal_id ?? null,
        belief.created_at,
        belief.updated_at,
      ],
    );
  }
}

async function dispatchRuntimeRuns() {
  if (!runtimeClient) {
    return;
  }

  const runs = await fetchRunsPendingRuntimeDispatch(10);
  for (const run of runs) {
    const signals = await fetchSignalsByIds(run.trigger_signal_ids);
    if (signals.length === 0) {
      await pool.query(
        `
          UPDATE simulation_runs
          SET status = 'failed', failure_reason = $2, completed_at = NOW(), last_updated_at = NOW()
          WHERE id = $1
        `,
        [run.id, "simulation_runtime_no_signals"],
      );
      continue;
    }

    const request = buildRuntimeRequest(run, signals);
    const validation = validateSimulationRunRequestV1(request);
    if (!validation.ok) {
      await pool.query(
        `
          UPDATE simulation_runs
          SET status = 'failed', failure_reason = $2, completed_at = NOW(), last_updated_at = NOW()
          WHERE id = $1
        `,
        [run.id, `invalid_simulation_run_request:${validation.errors.join(",")}`],
      );
      continue;
    }

    try {
      const submitted = await runtimeClient.submitRun(validation.request);
      const now = new Date().toISOString();
      await pool.query(
        `
          INSERT INTO simulation_runtime_runs (
            run_id,
            backend,
            contract_version,
            runtime_run_id,
            status,
            last_error,
            last_checked_at,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, $7::timestamptz, $8::timestamptz)
          ON CONFLICT (run_id) DO UPDATE SET
            runtime_run_id = EXCLUDED.runtime_run_id,
            status = EXCLUDED.status,
            last_error = NULL,
            last_checked_at = EXCLUDED.last_checked_at,
            updated_at = EXCLUDED.updated_at
        `,
        [
          run.id,
          runtimeBackend,
          validation.request.contract_version,
          submitted.runtime_run_id,
          "queued",
          now,
          now,
          now,
        ],
      );
    } catch (error) {
      app.log.error(error);
      await pool.query(
        `
          UPDATE simulation_runs
          SET failure_reason = $2, last_updated_at = NOW()
          WHERE id = $1
        `,
        [run.id, `simulation_runtime_submit_failed:${String(error)}`],
      );
    }
  }
}

async function pollRuntimeRuns() {
  if (!runtimeClient) {
    return;
  }

  const runtimeRuns = await fetchActiveRuntimeRuns(20);
  for (const runtimeRun of runtimeRuns) {
    try {
      const status = await runtimeClient.getRunStatus(runtimeRun.runtime_run_id);
      if (status.run_id !== runtimeRun.run_id) {
        throw new Error("simulation_runtime_status_run_id_mismatch");
      }

      await pool.query(
        `
          UPDATE simulation_runtime_runs
          SET
            status = $2,
            last_error = $3,
            last_checked_at = NOW(),
            updated_at = NOW(),
            completed_at = CASE WHEN $2 IN ('succeeded', 'failed') THEN NOW() ELSE completed_at END
          WHERE run_id = $1
        `,
        [runtimeRun.run_id, status.state, status.error ?? null],
      );

      if (status.state === "failed") {
        await pool.query(
          `
            UPDATE simulation_runs
            SET
              status = 'failed',
              failure_reason = $2,
              completed_at = NOW(),
              last_updated_at = NOW()
            WHERE id = $1
          `,
          [runtimeRun.run_id, status.error ?? "simulation_runtime_failed"],
        );
        continue;
      }

      if (status.state !== "succeeded") {
        continue;
      }

      const result = await runtimeClient.getRunResult(runtimeRun.runtime_run_id);
      if (result.run_id !== runtimeRun.run_id) {
        throw new Error("simulation_runtime_result_run_id_mismatch");
      }

      await persistWorldStateProposals(result.outputs.world_state_proposals);
      await persistDirectHypotheses(result.outputs.direct_hypotheses);
      await persistScenarioPathProposals(result.outputs.scenario_path_proposals);
      await persistSynthesizedBeliefs(result.outputs.synthesized_beliefs);

      await pool.query(
        `
          UPDATE simulation_runs
          SET
            status = 'ready_for_proposal',
            failure_reason = NULL,
            last_updated_at = NOW()
          WHERE id = $1
        `,
        [runtimeRun.run_id],
      );

      await pool.query(
        `
          UPDATE simulation_runtime_runs
          SET
            status = 'succeeded',
            last_error = NULL,
            last_checked_at = NOW(),
            updated_at = NOW(),
            completed_at = NOW()
          WHERE run_id = $1
        `,
        [runtimeRun.run_id],
      );
    } catch (error) {
      app.log.error(error);
      await pool.query(
        `
          UPDATE simulation_runtime_runs
          SET
            status = 'failed',
            last_error = $2,
            last_checked_at = NOW(),
            updated_at = NOW(),
            completed_at = NOW()
          WHERE run_id = $1
        `,
        [runtimeRun.run_id, String(error)],
      );
      await pool.query(
        `
          UPDATE simulation_runs
          SET
            status = 'failed',
            failure_reason = $2,
            completed_at = NOW(),
            last_updated_at = NOW()
          WHERE id = $1
        `,
        [runtimeRun.run_id, `simulation_runtime_poll_failed:${String(error)}`],
      );
    }
  }
}

async function tick() {
  if (tickInFlight) {
    return;
  }

  tickInFlight = true;
  try {
    await ensureCurrentRun();
    if (runtimeClient) {
      await dispatchRuntimeRuns();
      await pollRuntimeRuns();
    }
    await transitionRuns();
    lastTickAt = new Date().toISOString();
    lastTickError = null;
  } catch (error) {
    lastTickAt = new Date().toISOString();
    lastTickError = String(error);
    app.log.error(error);
  } finally {
    tickInFlight = false;
  }
}

app.get("/health", async () => ({
  service: "simulation-orchestrator",
  status: "ok",
  runtime_backend: runtimeBackend,
  runtime_contract_version: runtimeContractVersion,
  last_tick_at: lastTickAt,
  last_tick_error: lastTickError,
}));

app.get("/v1/internal/simulation-runs", async () => {
  const result = await pool.query<SimulationRunRow>(
    `
      SELECT *
      FROM simulation_runs
      ORDER BY started_at DESC, id DESC
    `,
  );

  return {
    items: result.rows.map(mapRunRow),
  };
});

app.get("/v1/internal/simulation-runtime-runs", async () => {
  const result = await pool.query<SimulationRuntimeRunRow>(
    `
      SELECT *
      FROM simulation_runtime_runs
      ORDER BY created_at DESC, run_id DESC
    `,
  );

  return {
    items: result.rows.map(mapRuntimeRunRow),
  };
});

app.post("/v1/internal/simulation-orchestrator/run-once", async () => {
  await tick();
  return { status: "ok", last_tick_at: lastTickAt, last_tick_error: lastTickError };
});

async function start() {
  await ensureCoreSchema(pool);
  await app.listen({ port, host: "0.0.0.0" });
  void tick();
  setInterval(() => {
    void tick();
  }, intervalMs);
}

void start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
