/**
 * AegisCode — container sandbox profile (NOT YET WIRED into execution).
 *
 * Status: this module is a standalone, offline-tested command builder. The
 * matrix and advisory paths do NOT call it yet; live untrusted execution
 * stays disabled (allowLiveExecution=false) until the container route is
 * approved, built, and negatively tested where a Docker daemon exists.
 *
 * Why this exists: the Node `--permission` workspace scoping in executor.js
 * is a defense-in-depth control only. Node's own documentation does not
 * guarantee it as a security boundary against untrusted code, so it must
 * never be presented as a complete sandbox. The complete boundary is this
 * container profile:
 *
 *  - `--network none`: no external network at all (loopback resource is
 *    provided by the coordinator outside the candidate container).
 *  - `--pids-limit 64`: fork-bomb containment.
 *  - `--memory 256m --memory-swap 256m --cpus 1.0`: heap AND native memory
 *    (covers the Buffer.alloc gap of --max-old-space-size) plus CPU.
 *  - `--read-only` rootfs + only the job workspace mounted (`/work`), plus
 *    a small noexec tmpfs for /tmp: the candidate cannot see host files.
 *  - `--cap-drop ALL --security-opt no-new-privileges --user 65532:65532`.
 *  - Environment: PATH/LANG + validated AC_* only. META_API_KEY and every
 *    other secret are NEVER passed (denylist enforced and asserted).
 *
 * Fail-closed: when no daemon is reachable, runInContainer() throws
 * `container_unavailable` — it never silently falls back to unsandboxed
 * execution.
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
} = {}) {
  if (!workspaceHostPath || !HOST_PATH_RE.test(workspaceHostPath)) {
    throw new Error('container_refused: workspace host path is missing or unsafe');
  }
  const timeoutSec = Math.max(1, Math.ceil((limits.timeout_ms ?? 5000) / 1000));
  const argv = [
    'run', '--rm',
    '--network', 'none',
    '--pids-limit', '64',
    '--memory', '256m',
    '--memory-swap', '256m',
    '--cpus', '1.0',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', '65532:65532',
    '-v', `${workspaceHostPath}:/work:rw`,
    '-w', '/work',
  ];
  argv.push('-e', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
  if (process.env.LANG) argv.push('-e', `LANG=${process.env.LANG}`);
  for (const [key, value] of Object.entries(env)) {
    if (CONTAINER_SECRET_DENYLIST.includes(key)) continue;
    if (!AC_KEY_RE.test(key) || typeof value !== 'string') continue;
    argv.push('-e', `${key}=${value}`);
  }
  const serialized = argv.join('\n');
  for (const secret of CONTAINER_SECRET_DENYLIST) {
    if (serialized.includes(secret)) {
      throw new Error('container_refused: secret name present in container argv');
    }
  }
  argv.push(image, 'node', `/work/${entry}`, ...args);
  return { argv, timeoutSec, image };
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
