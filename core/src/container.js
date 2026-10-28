/**
 * AegisCode — container sandbox profile.
 *
 * Two transport shapes share one boundary definition:
 *
 *  (a) candidate-only (`--network none`): a single container runs one
 *      candidate with no network at all. Used for functional probes and
 *      negative checks that need no resource.
 *  (b) condition run (isolated `--internal` network): the candidate runs in
 *      one container and the harness-owned synthetic resource runs as a
 *      sidecar in a second container on the SAME per-run internal network.
 *      A container's 127.0.0.1 is NOT the host loopback, so the resource is
 *      addressed by container name (`http://acr:8123`). The `--internal`
 *      flag means the daemon gives the network NO external route: egress is
 *      blocked by the daemon, not by candidate cooperation. Expected results
 *      and verdict authority stay on the host coordinator; the sidecar only
 *      serves the harness-owned profile body, the readiness probe, and a
 *      read-only request log the runner pulls for evidence.
 *
 * Common boundary (both shapes):
 *  - `--pids-limit 64`, `--memory/--memory-swap`, `--cpus 1.0`
 *    (covers the Buffer.alloc gap of --max-old-space-size).
 *  - `--read-only` rootfs + only explicit mounts + noexec tmpfs /tmp.
 *  - `--cap-drop ALL --security-opt no-new-privileges --user 65532:65532`.
 *  - Environment: PATH/LANG + validated AC_* only. META_API_KEY, GitHub
 *    tokens and every other secret are NEVER passed (denylist enforced and
 *    asserted). The Docker socket is NEVER mounted.
 *
 * Fail-closed: when no daemon is reachable, execution refuses with
 * `container_unavailable` — it never silently falls back to unsandboxed
 * execution.
 *
 * Image pinning: SANDBOX_IMAGE names the compatible runtime (Node 20,
 * matching engines >=20). A tag is mutable, so the validation workflow
 * pulls, records the observed RepoDigest into its report, and passes an
 * explicit `image@digest` back for the audited run; the builder accepts any
 * explicit image string so the digest — never an assumption — is what runs.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Pinned candidate runtime: no project build required to run untrusted code. */
export const SANDBOX_IMAGE = 'node:20-alpine';

/** Secrets that must NEVER enter a candidate container. */
export const CONTAINER_SECRET_DENYLIST = Object.freeze([
  'META_API_KEY',
  'AEGISCODE_API_TOKENS',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'AZURE_API_KEY',
]);

const AC_KEY_RE = /^AC_[A-Z0-9_]+$/;
const HOST_PATH_RE = /^[A-Za-z0-9_./:+-]+$/;
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;

/** Sidecar: harness-owned resource address inside the isolated network. */
export const SIDECAR_PORT = 8123;
export const SIDECAR_NAME = 'acr';
export const sidecarUrl = (name = SIDECAR_NAME) => `http://${name}:${SIDECAR_PORT}`;

/** Shared confinement flags — one definition, both transport shapes. */
export function containerBaseFlags({ memory = '256m', cpus = '1.0', pidsLimit = '64' } = {}) {
  return [
    '--pids-limit', pidsLimit,
    '--memory', memory,
    '--memory-swap', memory,
    '--cpus', cpus,
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', '65532:65532',
  ];
}

/** Shared environment args: PATH/LANG + validated AC_*; secrets stripped + asserted. */
export function containerEnvArgs(env = {}) {
  const args = ['-e', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'];
  if (process.env.LANG) args.push('-e', `LANG=${process.env.LANG}`);
  for (const [key, value] of Object.entries(env)) {
    if (CONTAINER_SECRET_DENYLIST.includes(key)) continue;
    if (!AC_KEY_RE.test(key) || typeof value !== 'string') continue;
    args.push('-e', `${key}=${value}`);
  }
  const serialized = args.join('\n');
  for (const secret of CONTAINER_SECRET_DENYLIST) {
    if (serialized.includes(secret)) {
      throw new Error('container_refused: secret name present in container env');
    }
  }
  return args;
}

/**
 * Builds a `docker run --rm ...` argv for one candidate execution.
 * Pure function — fully testable offline with no daemon.
 */
export function buildDockerRunArgs({
  image = SANDBOX_IMAGE,
  workspaceHostPath,
  entry = 'app.js',
  args = ['serve'],
  env = {},
  limits = {},
  name = null,
} = {}) {
  if (!workspaceHostPath || !HOST_PATH_RE.test(workspaceHostPath)) {
    throw new Error('container_refused: workspace host path is missing or unsafe');
  }
  if (name !== null && name !== undefined && !NAME_RE.test(name)) {
    throw new Error('container_refused: unsafe container name');
  }
  const timeoutSec = Math.max(1, Math.ceil((limits.timeout_ms ?? 5000) / 1000));
  const argv = [
    'run', '--rm',
    ...(name ? ['--name', name] : []),
    '--network', 'none',
    ...containerBaseFlags(),
    '-v', `${workspaceHostPath}:/work:rw`,
    '-w', '/work',
    ...containerEnvArgs(env),
  ];
  argv.push(image, 'node', `/work/${entry}`, ...args);
  return { argv, timeoutSec, image };
}

/** `docker network create --internal <name>`: no external route, by the daemon. */
export function buildNetworkCreateArgs(name) {
  if (!name || !NAME_RE.test(name)) throw new Error('container_refused: unsafe network name');
  return ['network', 'create', '--internal', name];
}

/**
 * Sidecar script (passed as `node -e`, never via shell): serves the
 * harness-owned profile, the readiness probe, and a read-only request log.
 * The log endpoint itself is not logged. Profile/runId are JSON-embedded.
 */
export function buildSidecarScript(profile, runId) {
  if (!profile || typeof profile.path !== 'string') throw new Error('container_refused: bad sidecar profile');
  return `const http=require('http');const PROFILE=${JSON.stringify({ path: profile.path, status: profile.status, body: profile.body })};const RUNID=${JSON.stringify(String(runId))};const log=[];const server=http.createServer((req,res)=>{if(req.url==='/__ac_log'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(log));return;}log.push({ts:new Date().toISOString(),run_id:RUNID,method:req.method,url:req.url,remote_address:req.socket.remoteAddress});if(req.url==='/__ac_probe'){res.writeHead(200,{'content-type':'text/plain'});res.end('AC-PROBE-OK:'+RUNID);return;}const u=String(req.url||'/');const m=u===PROFILE.path||u.startsWith(PROFILE.path+'?');res.writeHead(m?PROFILE.status:404,{'content-type':'text/plain'});res.end(m?PROFILE.body:'not found');});server.listen(${SIDECAR_PORT},'0.0.0.0',()=>console.log('AC-SIDECAR-READY'));`; 
}

/** Detached sidecar on the isolated network. Pure builder (offline-testable). */
export function buildSidecarArgs({ image = SANDBOX_IMAGE, network, name = SIDECAR_NAME, profile, runId }) {
  if (!network || !NAME_RE.test(network)) throw new Error('container_refused: unsafe network name');
  if (!name || !NAME_RE.test(name)) throw new Error('container_refused: unsafe sidecar name');
  const argv = [
    'run', '-d', '--rm',
    '--network', network,
    '--name', name,
    ...containerBaseFlags({ memory: '128m', cpus: '0.5', pidsLimit: '32' }),
  ];
  argv.push(image, 'node', '-e', buildSidecarScript(profile, runId));
  return argv;
}

/** Candidate container on the isolated network mounting core + subject read-only. */
export function buildAgentArgs({ image = SANDBOX_IMAGE, network, coreDir, subjectDir, env = {}, name = null }) {
  if (!network || !NAME_RE.test(network)) throw new Error('container_refused: unsafe network name');
  if (!coreDir || !HOST_PATH_RE.test(coreDir)) throw new Error('container_refused: unsafe core mount');
  if (!subjectDir || !HOST_PATH_RE.test(subjectDir)) throw new Error('container_refused: unsafe subject mount');
  if (name !== null && name !== undefined && !NAME_RE.test(name)) {
    throw new Error('container_refused: unsafe container name');
  }
  const argv = [
    'run', '--rm', '-i',
    ...(name ? ['--name', name] : []),
    '--network', network,
    ...containerBaseFlags(),
    '-v', `${coreDir}:/app-core:ro`,
    '-v', `${subjectDir}:/subject:ro`,
    ...containerEnvArgs(env),
  ];
  argv.push(image, 'node', '/app-core/src/runner.js');
  return argv;
}

/**
 * One-shot probe container attached to the SAME per-run --internal network
 * as the sidecar (no mounts, no secrets, no shell). Used to prove, on the
 * scenario network itself: sidecar reachable + external egress blocked.
 * Pure builder — fully testable offline with no daemon.
 */
export function buildIsolatedProbeArgs({ image = SANDBOX_IMAGE, network, script }) {
  if (!network || !NAME_RE.test(network)) throw new Error('container_refused: unsafe network name');
  if (typeof script !== 'string' || script.length === 0 || script.length > 8000) throw new Error('container_refused: bad probe script');
  return [
    'run', '--rm',
    '--network', network,
    ...containerBaseFlags({ memory: '128m', cpus: '0.5', pidsLimit: '32' }),
    image, 'node', '-e', script,
  ];
}

/** True when a Docker daemon answers. Never throws. */
export async function dockerAvailable(execFn = execFileAsync) {
  try {
    await execFn('docker', ['info'], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs one candidate inside the container profile. Fail-closed:
 * throws {code:'container_unavailable'} when no daemon answers.
 * The caller (matrix/advisory) does NOT fall back to plain execution.
 */
export async function runInContainer(job, execFn = execFileAsync) {
  if (!(await dockerAvailable(execFn))) {
    const err = new Error('Docker daemon unreachable — refusing untrusted execution (fail-closed).');
    err.code = 'container_unavailable';
    throw err;
  }
  const { argv, timeoutSec } = buildDockerRunArgs(job);
  const proc = await execFn('docker', argv, { timeout: timeoutSec * 1000 + 5000, maxBuffer: 1024 * 1024 });
  return proc;
}
