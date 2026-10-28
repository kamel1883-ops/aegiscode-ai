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
    const net = network ?? `acn-${runId}`.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 60);
    const sname = `${sidecarName}-${runId}`.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 60);
    const cleanup = [];
    try {
      await execFn('docker', buildNetworkCreateArgs(net), { timeout: 15000 });
      cleanup.push(['docker', ['network', 'rm', net]]);
      await execFn(
        'docker',
        buildSidecarArgs({ image, network: net, name: sname, profile: job.resourceProfile, runId }),
        { timeout: 30000 },
      );
      cleanup.push(['docker', ['rm', '-f', sname]]);
      if (!(await waitSidecarReady(execFn, sname))) {
        return { agent_error: 'Sidecar did not become ready on the isolated network.', stderr: await dockerLogs(execFn, sname) };
      }
      const containerJob = { ...job, subjectDir: '/subject', externalResourceUrl: sidecarUrl(sname) };
      const argv = buildAgentArgs({ image, network: net, coreDir, subjectDir: job.subjectDir, env: {} });
      return await new Promise((resolve) => {
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
          child = spawnFn('docker', argv, { stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (err) {
          resolve({ agent_error: `Could not start the container agent: ${err?.message ?? err}`, stderr });
          return;
        }
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          finish({ agent_error: `Container agent hung and exceeded the outer timeout of ${outerTimeoutMs} ms.`, stderr });
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
    const { argv, timeoutSec } = buildDockerRunArgs({ image, workspaceHostPath: workspace, entry, args, env, limits });
    try {
      const { stdout, stderr } = await execFn('docker', argv, {
        timeout: timeoutSec * 1000 + 5000,
        maxBuffer: 1024 * 1024,
      });
      return { status: 'completed', exit_code: 0, signal: null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: null, workspace: { path: workspace, deleted: false } };
    } catch (err) {
      const killed = err?.killed || /timed out|timeout/i.test(String(err?.message ?? ''));
      return {
        status: killed ? 'timeout' : 'crash',
        exit_code: typeof err?.code === 'number' ? err.code : null,
        signal: err?.signal ?? null,
        stdout: String(err?.stdout ?? ''),
        stderr: String(err?.stderr ?? ''),
        error: String(err?.message ?? err),
        workspace: { path: workspace, deleted: false },
      };
    }
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}
