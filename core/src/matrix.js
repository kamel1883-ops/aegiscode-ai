/**
 * AegisCode — four-condition matrix runner (Phase One)
 *
 * The essential change from Phase Zero: every attempt now runs through a
 * **separate execution agent** (runner.js) in a process fully independent of
 * the coordinator — and the subject code is a child of that agent. Subject code
 * is therefore never executed inside the coordinator process, nor inside the
 * web server process.
 *
 * Network isolation: the agent wraps itself with `unshare` when available, so
 * the resource and the subject run inside a single isolated network namespace.
 * When it is unavailable, that is recorded explicitly in the report — no
 * isolation is ever claimed that does not exist.
 *
 * The validity gate: the readiness request is sent by **the coordinator's
 * agent** (which hosts the resource) before the subject runs and independently
 * of its behavior — the essential documented distinction: the evidence is not
 * taken from the code under test; where the request runs physically is
 * incidental.
 *
 * Conditional environment separation is enforced here: the synthetic resource
 * is never started at all in a baseline condition, so it cannot "leak" into
 * (A) or (C).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { detectNetworkIsolation } from './isolation.js';
import { CONDITIONS } from './classify.js';

const RUNNER_PATH = fileURLToPath(new URL('./runner.js', import.meta.url));

/**
 * Reads the subject output and decides whether the unsafe event recurred.
 * The proof of recurrence is an **explicit marker** the code prints, not a
 * textual guess. Missing output (a setup failure) counts as "recurrence not
 * established", never as recurrence.
 */
function readObservation(stdoutExcerpt, unsafeEvent) {
  return typeof stdoutExcerpt === 'string' && stdoutExcerpt.includes(unsafeEvent);
}

/**
 * Runs one execution agent for one job and returns its result.
 * The coordinator also enforces an outer deadline: if the agent itself hangs,
 * its task is killed and recorded as a setup error — a hang here is never
 * classified as success.
 */
function runAgent({ job, prefix, outerTimeoutMs }) {
  return new Promise((resolve) => {
    const command = prefix ? prefix[0] : process.execPath;
    const args = prefix ? [...prefix.slice(1), process.execPath, RUNNER_PATH] : [RUNNER_PATH];

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.removeAllListeners();
      resolve(value);
    };

    let child;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, LANG: process.env.LANG },
      });
    } catch (err) {
      resolve({ agent_error: `Could not start the execution agent: ${err?.message ?? err}`, stderr: '' });
      return;
    }

    // Outer deadline: the task enforces timeout_ms internally; this is a last
    // line of defense in case the agent itself hangs before emitting a result.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ agent_error: `Execution agent hung and exceeded the outer timeout of ${outerTimeoutMs} ms.`, stderr });
    }, outerTimeoutMs);

    child.on('error', (err) => finish({ agent_error: `Execution agent error: ${err?.message ?? err}`, stderr }));
    child.on('close', () => {
      const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last) {
        finish({ agent_error: 'The execution agent exited without a readable result.', stderr });
        return;
      }
      try {
        const parsed = JSON.parse(last);
        if (parsed.ok === false) {
          finish({ agent_error: parsed.protocol_error ?? 'Invalid job.', stderr });
          return;
        }
        finish({ result: parsed, stderr });
      } catch (err) {
        finish({ agent_error: `Could not parse the agent result: ${err?.message ?? err}`, stderr });
      }
    });

    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });

    child.stdin.write(`${JSON.stringify(job)}\n`);
    child.stdin.end();
  });
}

/** Projects an agent result into a trial with observation + condition records. */
function trialFromAgent({ condition, subjectDir, runId, substituted, agentOut, attempts }) {
  const { result, agent_error: agentError, stderr } = agentOut;

  if (!result) {
    // An agent failure is an environment setup error — not a test failure and not a success.
    return {
      observation: {
        status: 'error',
        unsafe_event_recurred: false,
        legitimate_ok: false,
        intervention_valid: substituted ? false : null,
        attempts,
      },
      condition: {
        version: condition.version,
        environment: condition.environment,
        subject_dir: subjectDir,
        run_id: runId,
        exit_code: null,
        signal: null,
        duration_ms: 0,
        started_at: null,
        stdout_excerpt: '',
        stderr_excerpt: stderr.slice(0, 1000),
        output_truncated: false,
        error: agentError,
        workspace: null,
        executor: null,
        intervention: null,
      },
    };
  }

  const run = result.run;
  const intervention = result.intervention ?? null;

  return {
    observation: {
      status: run.status,
      // Recurrence is computed by the coordinator from the documented output
      // excerpt — not here.
      unsafe_event_recurred: false,
      legitimate_ok: false,
      intervention_valid: substituted ? intervention?.valid === true : null,
      attempts,
    },
    condition: {
      version: condition.version,
      environment: condition.environment,
      subject_dir: subjectDir,
      run_id: runId,
      exit_code: run.exit_code,
      signal: run.signal,
      duration_ms: run.duration_ms,
      started_at: run.started_at,
      stdout_excerpt: run.stdout.slice(0, 2000),
      stderr_excerpt: run.stderr.slice(0, 1000),
      output_truncated: run.stdout_truncated || run.stderr_truncated,
      error: run.error,
      // Workspace-deletion certificate — verified, never assumed.
      workspace: run.workspace ?? null,
      // Execution-trail evidence: agent separate from the coordinator, subject not the coordinator.
      executor: {
        coordinator_pid: process.pid,
        runner_pid: result.runner_pid ?? null,
        subject_pid: run.pid ?? null,
        runner_is_separate_process: result.runner_pid != null && result.runner_pid !== process.pid,
        subject_is_not_coordinator: run.pid != null && run.pid !== process.pid,
      },
      loopback_up: result.loopback_up ?? null,
      harness_log: result.harness_log ?? [],
      intervention: intervention
        ? {
            valid: intervention.valid,
            probes: intervention.probes,
            expected_status: intervention.expected_status,
            actual_status: intervention.actual_status,
            reason: intervention.reason,
            requests_seen: intervention.requests_seen ?? 0,
            sample_requests: intervention.sample_requests ?? [],
            // Readiness certificate: proof issued before the subject runs —
            // ordering is checked by timestamp.
            certificate: intervention.certificate ?? null,
            gate_before_subject:
              intervention.certificate?.probed_at != null
              && run.started_at != null
              && intervention.certificate.probed_at <= run.started_at,
          }
        : null,
    },
  };
}

/**
 * @param {object} params
 * @param {object} params.scenario  normalized scenario from validateScenario
 * @param {{original:string, patched:string}} params.subjects paths to the two codebases
 * @returns {Promise<{observations:object, conditions:object, isolation:object}>}
 */
export async function runMatrix({ scenario, subjects }) {
  const limits = scenario.resource_limits;
  const isolation = await detectNetworkIsolation();
  const observations = {};
  const conditions = {};

  // Outer agent deadline: the task enforces timeout_ms internally; this also
  // covers resource startup + the gate + cleanup.
  const outerTimeoutMs = limits.timeout_ms + 15_000;

  for (const condition of CONDITIONS) {
    const subjectDir = condition.version === 'original' ? subjects.original : subjects.patched;
    const substituted = condition.environment === 'substituted';

    let trial = null;
    let attempts = 0;
    let lastRunId = null;

    // Retry on execution failure only, within the scenario's attempt ceiling.
    for (let attempt = 1; attempt <= scenario.maximum_attempts; attempt += 1) {
      attempts = attempt;
      const runId = `ac-${condition.key}-${Date.now()}-${attempt}`;
      lastRunId = runId;

      const job = {
        runId,
        condition: condition.key,
        substituted,
        subjectDir,
        entry: 'app.js',
        args: ['serve'],
        limits,
        label: `${scenario.id}:${condition.key}`,
        resourceProfile: substituted ? scenario.synthetic_resource_profile : null,
        validityChecks: substituted ? scenario.intervention_validity_checks : null,
      };

      const agentOut = await runAgent({ job, prefix: isolation.prefix, outerTimeoutMs });
      trial = trialFromAgent({ condition, subjectDir, runId, substituted, agentOut, attempts });

      // As long as the gate failed, retrying is legitimate (the resource may not
      // have been ready). As long as the failure was executive, retrying is
      // legitimate too.
      const gateOk = substituted ? trial.observation.intervention_valid === true : true;
      if (trial.observation.status === 'completed' && gateOk) break;
    }

    const stdoutExcerpt = trial.condition.stdout_excerpt ?? '';
    const recurred = readObservation(stdoutExcerpt, scenario.unsafe_event);
    const legitimateOk = scenario.legitimate_behavior_checks.every((needle) => stdoutExcerpt.includes(needle));

    observations[condition.key] = {
      ...trial.observation,
      unsafe_event_recurred: trial.observation.status === 'completed' ? recurred : false,
      legitimate_ok: trial.observation.status === 'completed' ? legitimateOk : trial.observation.legitimate_ok,
      // In the baseline there is no intervention at all — the evidence is
      // neither required nor meaningful.
      intervention_valid: substituted ? trial.observation.intervention_valid : null,
      attempts,
    };

    conditions[condition.key] = {
      ...trial.condition,
      run_id: lastRunId,
      isolation: {
        network_namespace: isolation.network_namespace,
        fallback_reason: isolation.fallback_reason,
      },
    };
  }

  return {
    observations,
    conditions,
    isolation: {
      network_namespace: isolation.network_namespace,
      fallback_reason: isolation.fallback_reason,
    },
  };
}
