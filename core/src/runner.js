/**
 * AegisCode — separate execution agent (Phase One)
 *
 * This is a **process fully independent** of the coordinator: the coordinator
 * writes one job as a single JSON line to stdin, this agent runs it in the
 * current process, emits one JSON result line on stdout, and exits. The subject
 * code under test runs here as a child process — it is **never** inside the
 * coordinator process, nor inside the web server process.
 *
 * What the agent manages in one attempt:
 *  1. The synthetic loopback resource (only in the two substituted conditions).
 *  2. The intervention-validity gate — execution evidence is captured here
 *     **before** the subject code runs, independently of its behavior, and
 *     returned to the coordinator inside the result.
 *  3. Subject execution via executeSubject (clean workspace + limits + allowlist).
 *  4. Resource shutdown and verified workspace deletion.
 *
 * stdin/stdout protocol:
 *   - stdin: one JSON line with the job, then EOF.
 *   - stdout: one JSON line with the result. Anything else is a protocol breach.
 *   - stderr: agent diagnostics (never mixed with subject output).
 */

import { execFileSync } from 'node:child_process';
import { executeSubject } from './executor.js';
import { startSyntheticResource, verifyIntervention } from './resource.js';

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function log(harnessLog, message) {
  harnessLog.push(`${new Date().toISOString()} ${message}`);
  console.error(`[ac-runner] ${message}`);
}

async function main() {
  const raw = await readStdin();
  let job;
  try {
    job = JSON.parse(raw);
  } catch (err) {
    // Broken protocol: emit an explicit setup-error result, never silence.
    process.stdout.write(`${JSON.stringify({
      ok: false,
      protocol_error: `Unparseable job: ${err?.message ?? err}`,
    })}\n`);
    process.exit(0);
  }

  const harnessLog = [];

  // (1) Bring up loopback inside the isolated namespace if one exists — if not,
  //     the resource fails later and the result is classified inconclusive.
  //     This failure mode is safe by construction and cannot produce a false verdict.
  let loopbackUp = null;
  try {
    execFileSync('ip', ['link', 'set', 'lo', 'up'], { stdio: 'ignore' });
    loopbackUp = true;
    log(harnessLog, 'loopback interface is up');
  } catch (err) {
    loopbackUp = false;
    log(harnessLog, `could not bring up lo: ${err?.message ?? err}`);
  }

  // (2) Synthetic resource + validity gate — before any subject execution.
  // External-resource mode (container transport): the harness-owned sidecar
  // already listens on the isolated network at job.externalResourceUrl.
  // The gate still runs HERE, before the subject, from the same validity
  // checks — placement changed, authority did not. Request evidence comes
  // from the sidecar's read-only log (fetched, never trusted from output).
  let resource = null;
  let intervention = null;
  if (job.substituted && job.externalResourceUrl) {
    const adapter = { url: job.externalResourceUrl, requests: [] };
    const refreshLog = async () => {
      try {
        const res = await fetch(`${adapter.url}/__ac_log`);
        if (res.ok) adapter.requests = await res.json();
      } catch { /* gate below fails closed on missing evidence */ }
    };
    intervention = await verifyIntervention(adapter, job.validityChecks);
    await refreshLog();
    const minProbes = job.validityChecks?.min_probes ?? 1;
    intervention.probes = adapter.requests.filter((r) => r && r.url === '/__ac_probe').length;
    intervention.valid = intervention.actual_status === job.validityChecks?.expect_status
      && intervention.body_matched === true
      && intervention.probes >= minProbes;
    if (!intervention.valid && intervention.probes < minProbes) {
      intervention.reason = `Readiness probes (${intervention.probes}) below the required minimum (${minProbes}).`;
    }
    intervention.certificate = {
      run_id: job.runId,
      probed_at: new Date().toISOString(),
      status: intervention.actual_status,
      body_excerpt: intervention.body_excerpt ?? null,
    };
    log(harnessLog, `validity gate (external sidecar): ${intervention.valid ? 'passed' : 'failed'} — ${intervention.reason}`);
    resource = { url: adapter.url, requests: adapter.requests, external: true, stop: async () => {} };
  }
  if (job.substituted && !resource) {
    try {
      resource = await startSyntheticResource({ profile: job.resourceProfile, runId: job.runId });
      log(harnessLog, `synthetic resource listening on ${resource.url}`);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        runner_pid: process.pid,
        harness_log: harnessLog,
        loopback_up: loopbackUp,
        intervention: {
          valid: false,
          probes: 0,
          expected_status: job.validityChecks?.expect_status ?? null,
          actual_status: null,
          body_matched: null,
          reason: `Could not start the synthetic resource: ${err?.message ?? err}`,
          certificate: null,
          requests_seen: 0,
          sample_requests: [],
        },
        run: {
          status: 'error', exit_code: null, signal: null, duration_ms: 0,
          stdout: '', stderr: '', stdout_truncated: false, stderr_truncated: false,
          error: 'Environment setup failure: could not start the synthetic resource.',
          workspace: null,
        },
      })}\n`);
      process.exit(0);
    }

    intervention = await verifyIntervention(resource, job.validityChecks);
    intervention.certificate = {
      run_id: job.runId,
      probed_at: new Date().toISOString(),
      status: intervention.actual_status,
      body_excerpt: intervention.body_excerpt ?? null,
    };
    log(harnessLog, `validity gate: ${intervention.valid ? 'passed' : 'failed'} — ${intervention.reason}`);
  }

  // (3) Subject under test — child process, clean workspace, strict limits.
  const env = {
    AC_RUN_ID: job.runId,
    AC_CONDITION: job.condition,
  };
  if (resource) env.AC_RESOURCE_URL = resource.url;
  // Harness-owned functional input: forwarded verbatim, never interpreted.
  if (job.functionalEnv && typeof job.functionalEnv === 'object') {
    for (const [k, v] of Object.entries(job.functionalEnv)) {
      if (typeof v === 'string') env[k] = v;
    }
  }

  const run = await executeSubject({
    subjectDir: job.subjectDir,
    entry: job.entry ?? 'app.js',
    args: job.args ?? ['serve'],
    env,
    limits: job.limits,
    label: job.label ?? job.runId,
  });

  // (4) Stop the resource and record the final state. In external mode the
  // sidecar is owned by the coordinator transport; refresh its request log
  // once more so subject fetches are counted from harness evidence.
  if (resource) {
    await resource.stop().catch(() => {});
    if (resource.external) {
      try {
        const res = await fetch(`${resource.url}/__ac_log`);
        if (res.ok) resource.requests = await res.json();
      } catch { /* keep the pre-run snapshot; gate already decided */ }
    }
    intervention.requests_seen = resource.requests.length;
    intervention.sample_requests = resource.requests.slice(0, 20);
    log(harnessLog, `resource stopped after ${intervention.requests_seen} request(s)`);
  }

  if (run.workspace) {
    log(harnessLog, `workspace ${run.workspace.path}: deleted=${run.workspace.deleted}`);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    runner_pid: process.pid,
    harness_log: harnessLog,
    loopback_up: loopbackUp,
    intervention,
    run,
  })}\n`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(`[ac-runner] agent crash: ${err?.stack ?? err}`);
  process.exit(0);
});
