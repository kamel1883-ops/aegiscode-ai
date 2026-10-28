/**
 * AegisCode — container transport for the real execution path.
 *
 * Two entries, both fail-closed (no daemon ⇒ throw, never fall back):
 *
 *  - runContainerAgent: one four-condition agent run. Creates a per-run
 *    `--internal` network, starts the harness-owned sidecar on it, runs
 *    OUR runner.js in the candidate container (core + subject mounted
 *    read-only), pipes the job in on stdin, reads the result JSON on
 *    stdout, then removes sidecar + network. The candidate container
 *    reaches the resource at http://acr:8123 (container DNS on the
 *    isolated network); the host loopback is never involved.
 *  - runCandidateContainer: single candidate, `--network none`, used for
 *    resourceless functional probes and negative checks.
 *
 * The Docker socket, host directories (beyond the two explicit mounts),
 * META_API_KEY, and GitHub tokens never enter either container — see
 * container.js builders, asserted there.
 */

import { spawn, execFile } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  SANDBOX_IMAGE,
  SIDECAR_NAME,
  sidecarUrl,
  buildNetworkCreateArgs,
  buildSidecarArgs,
  buildAgentArgs,
  buildDockerRunArgs,
  dockerAvailable,
} from './container.js';

const execFileAsync = promisify(execFile);
const CORE_DIR = path.dirname(new URL('.', import.meta.url).pathname);

function containerUnavailable() {
  const err = new Error('Docker daemon unreachable — refusing untrusted execution (fail-closed).');
  err.code = 'container_unavailable';
  return err;
}

/**
 * In-flight sandbox containers/networks, for deterministic server-side kill.
 *
 * Client-side timeouts (execFile `timeout`, spawn timers) cannot be trusted
 * to end a container: the container lives on the daemon and can outlive a
 * dead CLI (observed: a `docker run` CLI orphaned for 25+ min while the
 * script waited). Every container/network we start is named and registered
 * here; normal completion unregisters it, and forceRemoveSandbox() rm -f's
 * anything still registered (watchdog expiry). Names only — never secrets.
 */
export const activeSandboxNames = { containers: new Set(), networks: new Set() };

/** Best-effort server-side termination of everything still registered. */
export async function forceRemoveSandbox(execFn = execFileAsync) {
  for (const name of [...activeSandboxNames.containers]) {
    try { await execFn('docker', ['rm', '-f', name], { timeout: 15000 }); } catch { /* best-effort */ }
    activeSandboxNames.containers.delete(name);
  }
  for (const name of [...activeSandboxNames.networks]) {
    try { await execFn('docker', ['network', 'rm', name], { timeout: 15000 }); } catch { /* best-effort */ }
    activeSandboxNames.networks.delete(name);
  }
}

let candidateSeq = 0;

async function dockerLogs(execFn, name, tail = 20) {
  try {
    const { stdout } = await execFn('docker', ['logs', '--tail', String(tail), name], { timeout: 10000 });
    return String(stdout ?? '');
  } catch {
    return '';
  }
}

/** Waits for AC-SIDECAR-READY in the sidecar logs (deadline, polling). */
async function waitSidecarReady(execFn, name, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const logs = await dockerLogs(execFn, name);
    if (logs.includes('AC-SIDECAR-READY')) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Mirrors runAgent's return shape ({result} | {agent_error, stderr}) so the
 * matrix can reuse trialFromAgent unchanged.
 */
export function runContainerAgent(
  { job, image = SANDBOX_IMAGE, coreDir = CORE_DIR, outerTimeoutMs, network, sidecarName = SIDECAR_NAME },
  spawnFn = spawn,
  execFn = execFileAsync,
) {
  return (async () => {
    if (!(await dockerAvailable(execFn))) throw containerUnavailable();
    const runId = job.runId;
    const net = (network ?? `acn-${runId}`).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 60);
    const sname = `${sidecarName}-${runId}`.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 60);
    // Named so a wedged run can be killed server-side (see forceRemoveSandbox).
    const agentName = `aca-${runId}`.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 60);
    activeSandboxNames.containers.add(agentName);
    activeSandboxNames.networks.add(net);
    // Baseline conditions (A, C) withhold the resource by design, so no
    // sidecar is started for them — only substituted conditions (B, D) carry
    // a resourceProfile. Passing the null baseline profile into the sidecar
    // builder crashed every baseline condition (container_refused: bad
    // sidecar profile). The isolated network itself is still created (the
    // daemon gives it no external route), so baseline candidates stay
    // contained with simply no resource to reach.
    const needSidecar = Boolean(job.substituted && job.resourceProfile);
    const cleanup = [];
    try {
      await execFn('docker', buildNetworkCreateArgs(net), { timeout: 15000 });
      cleanup.push(['docker', ['network', 'rm', net]]);
      let sidecarAddress = null;
      if (needSidecar) {
        await execFn(
          'docker',
          buildSidecarArgs({ image, network: net, name: sname, profile: job.resourceProfile, runId }),
          { timeout: 30000 },
        );
        cleanup.push(['docker', ['rm', '-f', sname]]);
        if (!(await waitSidecarReady(execFn, sname))) {
          return { agent_error: 'Sidecar did not become ready on the isolated network.', stderr: await dockerLogs(execFn, sname) };
        }
        sidecarAddress = sidecarUrl(sname);
      }
      if (needSidecar) activeSandboxNames.containers.add(sname);
      cleanup.push(['docker', ['rm', '-f', agentName]]);
      const containerJob = { ...job, subjectDir: '/subject', ...(sidecarAddress ? { externalResourceUrl: sidecarAddress } : {}) };
      const argv = buildAgentArgs({ image, network: net, coreDir, subjectDir: job.subjectDir, env: {}, name: agentName });
      return await new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer = null;
        let killTimer = null;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          child?.removeAllListeners();
          resolve(value);
        };
        let child;
        try {
          child = spawnFn('docker', argv, { stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (err) {
          resolve({ agent_error: `Could not start the container agent: ${err?.message ?? err}`, stderr });
          return;
        }
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          finish({ agent_error: `Container agent hung and exceeded the outer timeout of ${outerTimeoutMs} ms.`, stderr });
        }, outerTimeoutMs);
        // Deterministic server-side kill: `docker run` CLI kill alone does not
        // end a wedged container (observed: CLI orphaned while the daemon kept
        // the container). rm -f at the same deadline so the CLI can exit and
        // the promise settles instead of hanging to the phase budget.
        killTimer = setTimeout(() => {
          execFn('docker', ['rm', '-f', agentName], { timeout: 15000 }).catch(() => {});
          if (needSidecar) execFn('docker', ['rm', '-f', sname], { timeout: 15000 }).catch(() => {});
        }, outerTimeoutMs);
        child.on('error', (err) => finish({ agent_error: `Container agent error: ${err?.message ?? err}`, stderr }));
        child.on('close', () => {
          const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
          const last = lines[lines.length - 1];
          if (!last) {
            finish({ agent_error: 'The container agent exited without a readable result.', stderr });
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
            finish({ agent_error: `Could not parse the container agent result: ${err?.message ?? err}`, stderr });
          }
        });
        child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
        child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
        child.stdin.write(`${JSON.stringify(containerJob)}\n`);
        child.stdin.end();
      });
    } finally {
      for (const [cmd, args] of cleanup.reverse()) {
        try {
          await execFn(cmd, args, { timeout: 15000 });
        } catch { /* best-effort cleanup; the failure is already recorded */ }
      }
      activeSandboxNames.containers.delete(agentName);
      if (needSidecar) activeSandboxNames.containers.delete(sname);
      activeSandboxNames.networks.delete(net);
    }
  })();
}

/**
 * Single candidate under `--network none` (no resource, no sidecar).
 * Returns an executeSubject-like {status, stdout, ...} for probes/checks.
 * Host-side copy first (mirrors executor: never run the original in place).
 */
export async function runCandidateContainer(
  { image = SANDBOX_IMAGE, subjectDir, entry = 'app.js', args = ['serve'], env = {}, limits },
  execFn = execFileAsync,
) {
  if (!(await dockerAvailable(execFn))) throw containerUnavailable();
  const workspace = await mkdtemp(path.join(tmpdir(), 'ac-cws-'));
  try {
    await cp(subjectDir, workspace, { recursive: true, force: true });
    // mkdtemp creates 0700 dirs; the candidate runs as unprivileged 65532,
    // so without this the container cannot even read its own workspace
    // (observed on the runner as status=crash on every mounted probe).
    // The workspace holds only a copy of the candidate code — never secrets.
    await execFileAsync('chmod', ['-R', 'a+rwX', workspace], { timeout: 10000 });
    // Named so a wedged run can be killed server-side even if the exec
    // timeout path itself fails (observed: orphaned `docker run` CLI).
    const cname = `ac-c-${Date.now().toString(36)}-${(candidateSeq++).toString(36)}`;
    activeSandboxNames.containers.add(cname);
    const { argv, timeoutSec } = buildDockerRunArgs({ image, workspaceHostPath: workspace, entry, args, env, limits, name: cname });
    // Deterministic server-side kill scheduled BEFORE awaiting the CLI: the
    // exec timeout kills the CLI, but a wedged container keeps the CLI from
    // exiting (observed: hang took 90s to the phase budget). rm -f at the
    // container deadline lets the CLI exit so the promise settles as timeout.
    const killTimer = setTimeout(() => {
      execFn('docker', ['rm', '-f', cname], { timeout: 15000 }).catch(() => {});
    }, timeoutSec * 1000);
    let result;
    try {
      const { stdout, stderr } = await execFn('docker', argv, {
        timeout: timeoutSec * 1000 + 5000,
        maxBuffer: 1024 * 1024,
      });
      result = { status: 'completed', exit_code: 0, signal: null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: null, workspace: { path: workspace, deleted: false } };
    } catch (err) {
      const killed = err?.killed || /timed out|timeout/i.test(String(err?.message ?? ''));
      result = {
        status: killed ? 'timeout' : 'crash',
        exit_code: typeof err?.code === 'number' ? err.code : null,
        signal: err?.signal ?? null,
        stdout: String(err?.stdout ?? ''),
        stderr: String(err?.stderr ?? ''),
        error: String(err?.message ?? err),
        workspace: { path: workspace, deleted: false },
      };
    }
    clearTimeout(killTimer);
    // Deterministic server-side kill: --rm usually already removed it; if the
    // exec timeout path failed, this is what actually ends the container.
    try { await execFn('docker', ['rm', '-f', cname], { timeout: 15000 }); } catch { /* already gone */ }
    activeSandboxNames.containers.delete(cname);
    return result;
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}
