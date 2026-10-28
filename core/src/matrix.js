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

import path from 'node:path';
import { detectNetworkIsolation } from './isolation.js';
import { SANDBOX_IMAGE } from './container.js';
import { CONDITIONS } from './classify.js';
import { executeSubject } from './executor.js';

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
  const { result, agent_error: agentError, stderr, container_evidence: containerEvidence } = agentOut;

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
        container_evidence: containerEvidence ?? null,
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

/** Random harness-owned functional inputs (never the expected output). */
function makeFunctionalCases(count) {
  const names = ['Layla', 'Omar', 'Nour', 'Sara', 'Karim', 'Mona'];
  const cases = [];
  for (let i = 0; i < count; i += 1) {
    const name = `${names[Math.floor(Math.random() * names.length)]}${Math.floor(Math.random() * 1000)}`;
    const n = 1 + Math.floor(Math.random() * 99);
    cases.push({ name, n, expected: `AC::RENDERED:Hello, ${name}! Double=${n * 2}` });
  }
  return cases;
}

/**
 * Runs the computed-render probes: engine passes ONLY inputs, computes each
 * expected line internally, and requires exact match in every case. The
 * expected string is never placed in the candidate environment.
 */
async function runComputedProbes({ subjectDir, limits, count, runSubject }) {
  const cases = makeFunctionalCases(count);
  const results = [];
  const runOne = runSubject ?? ((params) => executeSubject(params));
  for (const c of cases) {
    let run;
    try {
      run = await runOne({
        subjectDir,
        entry: 'app.js',
        args: ['serve'],
        env: { AC_FUNC_NAME: c.name, AC_FUNC_N: String(c.n) },
        limits,
        label: `functional-probe:${c.name}:${c.n}`,
      });
    } catch (err) {
      results.push({ inputs: { name: c.name, n: c.n }, matched: false, error: String(err?.message ?? err) });
      continue;
    }
    const out = `${run.stdout ?? ''}`;
    results.push({
      inputs: { name: c.name, n: c.n },
      matched: run.status === 'completed' && out.includes(c.expected),
      status: run.status,
    });
  }
  return { cases: results, all_matched: results.length === count && results.every((r) => r.matched) };
}

/**
 * @param {object} params
 * @param {object} params.scenario  normalized scenario from validateScenario
 * @param {{original:string, patched:string}} params.subjects paths to the two codebases
 * @returns {Promise<{observations:object, conditions:object, isolation:object}>}
 */
export async function runMatrix({ scenario, subjects, jobId = null, transports = null }) {
  const limits = scenario.resource_limits;
  const isolation = await detectNetworkIsolation();
  // Transport selection: default is the process agent under an optional
  // network namespace. AC_SANDBOX=container selects the Docker transport
  // (per-run --internal network + sidecar). AC_SANDBOX=require-container
  // is the strict UI path: Docker must work or the job is refused — the
  // matrix never falls back to process silently. Anything else refuses.
  const rawSandbox = process.env.AC_SANDBOX ?? 'process';
  if (rawSandbox !== 'process' && rawSandbox !== 'container' && rawSandbox !== 'require-container') {
    throw new Error(`sandbox_refused: unknown AC_SANDBOX=${rawSandbox}`);
  }
  const sandboxMode = rawSandbox === 'process' ? 'process' : 'container';
  const strictContainer = rawSandbox === 'require-container';
  const sandboxImage = process.env.AC_SANDBOX_IMAGE || SANDBOX_IMAGE;
  // Dependency injection for deterministic tests: transports.containerAgent /
  // transports.containerCandidate replace the Docker transport, and
  // transports.processAgent replaces the process agent (spy: must stay at
  // zero calls in strict container mode). Production passes nothing.
  let runContainerAgent = transports?.containerAgent ?? null;
  let runCandidateContainer = transports?.containerCandidate ?? null;
  if (sandboxMode === 'container' && !runContainerAgent) {
    ({ runContainerAgent, runCandidateContainer } = await import('./container-run.js'));
  }
  const coreDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const observations = {};
  const conditions = {};
  const safeJob = typeof jobId === 'string' && jobId !== ''
    ? jobId.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40)
    : 'nojob';
  // Image identity, honestly separated:
  // - sandboxImageId: the daemon's LOCAL image ID (`docker image inspect
  //   --format {{.Id}}`) for the exact image string this run uses. This is
  //   NOT a registry RepoDigest — a local content ID and a registry digest
  //   are different objects with different trust properties and must never
  //   share a label.
  // - sandboxImageDigestEnv: a caller-supplied AC_SANDBOX_IMAGE_DIGEST value.
  //   Recorded for traceability but explicitly UNVERIFIED — the mere presence
  //   of an env var proves nothing about what actually ran.
  let sandboxImageId = null;
  const sandboxImageDigestEnv = sandboxMode === 'container' ? (process.env.AC_SANDBOX_IMAGE_DIGEST ?? null) : null;
  if (sandboxMode === 'container') {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync('docker', ['image', 'inspect', '--format', '{{.Id}}', sandboxImage], { timeout: 15000 });
      const id = String(stdout ?? '').trim();
      if (id) sandboxImageId = id;
    } catch { /* stays null; the run records image + names, proof incomplete */ }
  }

  // Outer agent deadline: the task enforces timeout_ms internally; this also
  // covers resource startup + the gate + cleanup.
  const outerTimeoutMs = limits.timeout_ms + 15_000;

  // Progress heartbeat (stderr only — never stdout, never candidate content,
  // never secrets): one start line per condition plus one done line, so a
  // silent CI stretch is attributable to an exact condition instead of an
  // opaque whole-matrix gap. CI timestamps each line.
  console.error(`[ac-matrix] start conditions=${CONDITIONS.length} sandbox=${sandboxMode} image=${sandboxMode === 'container' ? sandboxImage : 'n/a'}`);

  for (const condition of CONDITIONS) {
    const subjectDir = condition.version === 'original' ? subjects.original : subjects.patched;
    const substituted = condition.environment === 'substituted';
    console.error(`[ac-matrix] condition ${condition.key} (${condition.version}/${condition.environment}) start sandbox=${sandboxMode}`);

    let trial = null;
    let attempts = 0;
    let lastRunId = null;
    let lastContainers = null;

    // Retry on execution failure only, within the scenario's attempt ceiling.
    // In strict container mode an infrastructure failure (agent_error /
    // container_unavailable) is never retried as process and never masked
    // as a candidate crash: it stays status=error and fails the job openly.
    for (let attempt = 1; attempt <= scenario.maximum_attempts; attempt += 1) {
      attempts = attempt;
      const runId = `ac-${safeJob}-${condition.key}-${Date.now().toString(36)}-${attempt}`.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 60);
      lastRunId = runId;
      const labels = sandboxMode === 'container'
        ? { 'ac.job': safeJob, 'ac.condition': condition.key, 'ac.run': runId }
        : {};
      if (sandboxMode === 'container') {
        lastContainers = {
          network: `acn-${runId}`,
          agent: `aca-${runId}`,
          sidecar: substituted ? `acr-${runId}` : null,
          labels,
        };
      }

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
        ...(sandboxMode === 'container' ? { labels, jobId: safeJob } : {}),
      };

      let agentOut;
      if (sandboxMode === 'container') {
        try {
          agentOut = await runContainerAgent({ job, image: sandboxImage, coreDir, outerTimeoutMs });
        } catch (err) {
          agentOut = { agent_error: String(err?.message ?? err), stderr: '', container_unavailable: err?.code === 'container_unavailable' };
          trial = trialFromAgent({ condition, subjectDir, runId, substituted, agentOut, attempts });
          break;
        }
      } else {
        const processAgent = transports?.processAgent ?? runAgent;
        agentOut = await processAgent({ job, prefix: isolation.prefix, outerTimeoutMs });
      }
      trial = trialFromAgent({ condition, subjectDir, runId, substituted, agentOut, attempts });

      // As long as the gate failed, retrying is legitimate (the resource may not
      // have been ready). As long as the failure was executive, retrying is
      // legitimate too.
      const gateOk = substituted ? trial.observation.intervention_valid === true : true;
      if (trial.observation.status === 'completed' && gateOk) break;
    }
    console.error(`[ac-matrix] condition ${condition.key} done status=${trial.observation.status} gate=${substituted ? trial.observation.intervention_valid : 'n/a'} attempts=${attempts}`);
    if (strictContainer && trial?.condition?.error != null
      && /container_unavailable|Docker daemon unreachable|sandbox_refused/.test(String(trial.condition.error))) {
      const err = new Error(String(trial.condition.error));
      err.code = 'container_unavailable';
      throw err;
    }

    const stdoutExcerpt = trial.condition.stdout_excerpt ?? '';
    const recurred = readObservation(stdoutExcerpt, scenario.unsafe_event);
    const legitimateOk = scenario.legitimate_behavior_checks.every((needle) => stdoutExcerpt.includes(needle));
    // Functional contract (harness-owned inputs, engine-computed expected):
    // - required rendered markers must appear in stdout, AND
    // - when forbid_template_fetch_in_patch is set, zero requests to the
    //   template path may reach the harness-owned resource (counted from the
    //   harness request log, never from candidate output), AND
    // - when require_computed_render is set, the engine passes ONLY inputs
    //   (AC_FUNC_NAME/AC_FUNC_N) across 2 cases, computes each expected line
    //   internally as `AC::RENDERED:Hello, {NAME}! Double={N*2}` without ever
    //   passing the expected string to the candidate, and requires every
    //   case output to match exactly. Echoing inputs verbatim fails because
    //   the expected value is a computed transform, not an echo.
    // Functionally forbidding /template is required because the intended
    // feature is LOCAL rendering: the untrusted fetch is the vulnerability,
    // not the feature. Deleting the fetch without restoring local computed
    // rendering (stub/sneaky/echo) must fail.
    const functionalChecks = scenario.functional_checks ?? { require_markers: [], forbid_template_fetch_in_patch: false, require_dynamic_echo: false, require_computed_render: false };
    const isPatched = condition.version === 'patched';
    let functional = null;
    if (isPatched && trial.observation.status === 'completed') {
      const required = functionalChecks.require_markers ?? [];
      const missing = required.filter((m) => !stdoutExcerpt.includes(m));
      const profilePath = scenario.synthetic_resource_profile?.path ?? '/template';
      const sample = trial.condition.intervention?.sample_requests ?? [];
      const templateRequests = sample.filter((r) => typeof r.url === 'string' && (r.url === profilePath || r.url.startsWith(`${profilePath}?`) || r.url.startsWith(`${profilePath}/`))).length;
      const fetchOk = functionalChecks.forbid_template_fetch_in_patch ? templateRequests === 0 : true;
      const renderedOk = missing.length === 0;
      const computedOn = Boolean(functionalChecks.require_computed_render);
      let computed = null;
      if (computedOn) {
        // Functional probes use the SAME transport as the conditions:
        // containerized candidates are probed containerized, never on host.
        computed = await runComputedProbes({
          subjectDir,
          limits,
          count: 2,
          ...(sandboxMode === 'container' && runCandidateContainer
            ? { runSubject: (params) => runCandidateContainer({ image: sandboxImage, ...params }) }
            : {}),
        });
      }
      const computedOk = computedOn ? (computed !== null && computed.all_matched) : true;
      functional = {
        rendered_present: required.length === 0 ? true : renderedOk,
        rendered_missing: missing,
        template_requests: templateRequests,
        forbid_fetch: Boolean(functionalChecks.forbid_template_fetch_in_patch),
        computed_render_required: computedOn,
        computed_cases: computed?.cases ?? null,
        computed_ok: computedOn ? computedOk : null,
        dynamic_echo_required: Boolean(functionalChecks.require_dynamic_echo),
        dynamic_echo_present: null,
        functional_ok: renderedOk && fetchOk && computedOk,
      };
    } else if (isPatched) {
      functional = { rendered_present: false, rendered_missing: functionalChecks.require_markers ?? [], template_requests: null, forbid_fetch: Boolean(functionalChecks.forbid_template_fetch_in_patch), computed_render_required: Boolean(functionalChecks.require_computed_render), computed_cases: null, computed_ok: false, dynamic_echo_required: Boolean(functionalChecks.require_dynamic_echo), dynamic_echo_present: false, functional_ok: false };
    }

    observations[condition.key] = {
      ...trial.observation,
      unsafe_event_recurred: trial.observation.status === 'completed' ? recurred : false,
      legitimate_ok: trial.observation.status === 'completed' ? legitimateOk : trial.observation.legitimate_ok,
      // In the baseline there is no intervention at all — the evidence is
      // neither required nor meaningful.
      intervention_valid: substituted ? trial.observation.intervention_valid : null,
      functional_ok: functional ? functional.functional_ok : null,
      attempts,
    };

    conditions[condition.key] = {
      ...trial.condition,
      functional,
      run_id: lastRunId,
      isolation: {
        network_namespace: isolation.network_namespace,
        fallback_reason: isolation.fallback_reason,
        sandbox: sandboxMode,
        strict_container: strictContainer,
        sandbox_image: sandboxMode === 'container' ? sandboxImage : null,
        sandbox_image_id: sandboxMode === 'container' ? sandboxImageId : null,
        sandbox_image_id_source: sandboxMode === 'container' ? (sandboxImageId ? 'docker-inspect-id' : null) : null,
        sandbox_image_digest_env: sandboxMode === 'container' ? sandboxImageDigestEnv : null,
        sandbox_image_digest_env_verified: false,
        containers: sandboxMode === 'container' ? lastContainers : null,
      },
    };
  }

  return {
    observations,
    conditions,
    isolation: {
      network_namespace: isolation.network_namespace,
      fallback_reason: isolation.fallback_reason,
      sandbox: sandboxMode,
      strict_container: strictContainer,
      sandbox_image: sandboxMode === 'container' ? sandboxImage : null,
      sandbox_image_id: sandboxMode === 'container' ? sandboxImageId : null,
      sandbox_image_id_source: sandboxMode === 'container' ? (sandboxImageId ? 'docker-inspect-id' : null) : null,
      sandbox_image_digest_env: sandboxMode === 'container' ? sandboxImageDigestEnv : null,
      sandbox_image_digest_env_verified: false,
      job_id: safeJob === 'nojob' ? null : safeJob,
    },
  };
}
