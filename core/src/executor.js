/**
 * AegisCode — isolated execution worker (Phase Zero, hardened in Phase One)
 *
 * The constraints enforced here in practice, not as slogans:
 *  - Every run gets a fresh clean workspace; the subject code is copied into it
 *    before execution.
 *  - The environment is inherited via an explicit **allowlist**: no secrets and
 *    no host environment variables leak through.
 *  - A strict deadline: on timeout the process is killed and recorded as
 *    timeout = failure, never success.
 *  - Memory cap and output-size cap.
 *  - Execution happens in a **separate child process** — uploaded code never
 *    runs inside the coordinator process.
 *  - Workspace deletion is verified after execution and an auditable
 *    **deletion certificate** is returned (`workspace.deleted`), never assumed.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Host environment variables allowed to be inherited. Anything else never reaches the subject. */
const ENV_ALLOWLIST = Object.freeze(['PATH', 'LANG']);

/** Deletes the workspace and returns a deletion certificate verified against the disk. */
async function cleanupWorkspace(workspace) {
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
  return !existsSync(workspace);
}

/**
 * Runs the "subject under test" in an isolated child process.
 *
 * @param {object} params
 * @param {string} params.subjectDir   original subject directory (copied, never run in place)
 * @param {string} [params.entry]      entry file name inside subjectDir
 * @param {string[]} [params.args]     run arguments
 * @param {Record<string,string>} [params.env] explicitly injected AC_* variables
 * @param {{timeout_ms:number,max_memory_mb:number,max_output_bytes:number}} params.limits
 * @param {string} [params.label]      label printed to stderr for easier auditing
 * @returns {Promise<{status:'completed'|'timeout'|'crash'|'error', exit_code:number|null,
 *   signal:string|null, duration_ms:number, started_at:string, pid:number|null,
 *   stdout:string, stderr:string, stdout_truncated:boolean, stderr_truncated:boolean,
 *   error:string|null, workspace:{path:string, deleted:boolean}|null}>}
 */
export async function executeSubject({ subjectDir, entry = 'app.js', args = [], env = {}, limits, label = 'subject' }) {
  const started = Date.now();
  let workspace = null;
  let result = null;

  try {
    // (1) Clean workspace: the code is copied, so a run is unaffected by prior
    // files and shares no trace with any other condition.
    workspace = await mkdtemp(path.join(tmpdir(), 'ac-run-'));
    await cp(subjectDir, workspace, { recursive: true, force: true });

    // (2) Small explicit environment: PATH + explicitly inherited vars + the injected AC_* chain.
    const childEnv = {};
    for (const key of ENV_ALLOWLIST) {
      if (process.env[key] !== undefined) childEnv[key] = process.env[key];
    }
    Object.assign(childEnv, env);
    childEnv.AC_WORKSPACE = workspace;

    // (3) A run marker written to stderr so subject output stays separable from coordinator logs.
    await writeFile(path.join(workspace, '.ac-run-label'), label, 'utf8');

    const entryPath = path.join(workspace, entry);
    const child = spawn(process.execPath, [`--max-old-space-size=${limits.max_memory_mb}`, entryPath, ...args], {
      cwd: workspace,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const cap = (chunk, which) => {
      const text = chunk.toString('utf8');
      if (which === 'out') {
        if (stdout.length + text.length > limits.max_output_bytes) {
          stdout += text.slice(0, Math.max(0, limits.max_output_bytes - stdout.length));
          stdoutTruncated = true;
        } else {
          stdout += text;
        }
      } else if (stderr.length + text.length > limits.max_output_bytes) {
        stderr += text.slice(0, Math.max(0, limits.max_output_bytes - stderr.length));
        stderrTruncated = true;
      } else {
        stderr += text;
      }
    };

    child.stdout.on('data', (c) => cap(c, 'out'));
    child.stderr.on('data', (c) => cap(c, 'err'));

    // (4) Deadline: killed forcibly, recorded as timeout — a **failure** in the classifier.
    const outcome = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ timedOut: true });
      }, limits.timeout_ms);

      child.on('error', (err) => finish({ errored: true, error: err }));
      child.on('close', (code, signal) => finish({ code, signal }));
    });

    const base = {
      duration_ms: Date.now() - started,
      started_at: new Date(started).toISOString(),
      pid: child.pid ?? null,
      stdout,
      stderr,
      stdout_truncated: stdoutTruncated,
      stderr_truncated: stderrTruncated,
      workspace: null, // attached after cleanup at the unified exit point
    };

    if (outcome.errored) {
      result = { ...base, status: 'error', exit_code: null, signal: null, error: String(outcome.error?.message ?? outcome.error) };
    } else if (outcome.timedOut) {
      result = { ...base, status: 'timeout', exit_code: null, signal: 'SIGKILL', error: `Timed out after ${limits.timeout_ms} ms` };
    } else if (outcome.signal !== null) {
      result = { ...base, status: 'crash', exit_code: outcome.code, signal: outcome.signal, error: `Terminated by signal ${outcome.signal}` };
    } else if (outcome.code !== 0) {
      result = { ...base, status: 'crash', exit_code: outcome.code, signal: null, error: `Exited with non-zero code ${outcome.code}` };
    } else {
      result = { ...base, status: 'completed', exit_code: 0, signal: null, error: null };
    }
  } catch (err) {
    result = {
      status: 'error',
      exit_code: null,
      signal: null,
      duration_ms: Date.now() - started,
      started_at: new Date(started).toISOString(),
      pid: null,
      stdout: '',
      stderr: '',
      stdout_truncated: false,
      stderr_truncated: false,
      error: String(err?.message ?? err),
      workspace: null,
    };
  }

  // (5) The workspace is deleted after every attempt, and deletion is **verified**,
  // never assumed.
  if (workspace) {
    result.workspace = { path: workspace, deleted: await cleanupWorkspace(workspace) };
  }

  return result;
}
