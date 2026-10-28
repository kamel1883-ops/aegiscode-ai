/**
 * AegisCode — network isolation (Phase One)
 *
 * Goal: prevent the subject code under test from reaching any external network
 * by placing it in its own network namespace.
 *
 * Implementation reality: `unshare -n` requires a privilege that may be
 * unavailable; `unshare -rn` (with a user namespace) works on most
 * unprivileged environments. We try both in order, and if both fail we record
 * it explicitly:
 *   `network_namespace: "none"` with a documented **reason** in the report.
 * An isolation that does not exist is never claimed.
 *
 * In the fallback case the design itself provides the protection: the synthetic
 * resource binds to loopback only, the scenario contains no external
 * destination at all, and schema.js rejects any kind other than `loopback_http`.
 *
 * Note: when isolation is active the loopback interface is down inside the new
 * namespace, and runner.js brings it up before each attempt; if it cannot be
 * brought up, the loopback resource fails and the result is classified
 * "inconclusive" — the failure mode here is safe by construction: it can only
 * produce a rejection, never a false verdict.
 */

import { spawn, execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Resolved once per coordinator process: which isolation pattern is available, if any. */
let cachedProbe = null;
let cachedFs = null;

/** Candidate patterns in order: the conventional one, then the unprivileged-capable one. */
const CANDIDATES = Object.freeze([
  { args: ['-n', '--'], label: 'unshare -n' },
  { args: ['-rn', '--'], label: 'unshare -rn' },
]);

function probeOnce(args) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, detail) => {
      if (!settled) {
        settled = true;
        resolve({ ok, detail });
      }
    };

    let child;
    try {
      child = spawn('unshare', [...args, 'true'], { stdio: 'ignore' });
    } catch (err) {
      done(false, err?.message ?? String(err));
      return;
    }

    child.on('error', (err) => done(false, err?.message ?? String(err)));
    child.on('close', (code) => done(code === 0, `unshare ${args.join(' ')}: exit ${code}`));
  });
}

/**
 * Detects available network isolation.
 *
 * @returns {Promise<{network_namespace:string|null, prefix:string[]|null, fallback_reason:string|null}>}
 */
export function detectNetworkIsolation() {
  if (cachedProbe) return cachedProbe;

  cachedProbe = (async () => {
    for (const candidate of CANDIDATES) {
      const { ok } = await probeOnce(candidate.args);
      if (ok) {
        return { network_namespace: candidate.label, prefix: ['unshare', ...candidate.args], fallback_reason: null };
      }
    }

    return {
      network_namespace: 'none',
      prefix: null,
      fallback_reason:
        'The environment refused unshare (both -n and -rn) — the privilege is unavailable. '
        + 'Protection then rests on the design: loopback-only resource, no external destination in the '
        + 'scenario at all, and schema.js rejects any kind other than loopback_http.',
    };
  })();

  return cachedProbe;
}

/**
 * Probes Node filesystem containment: a scratch workspace may read itself but
 * must NOT read a host canary outside it. Cached per process. Offline-safe:
 * no network, no secrets, small temp files only.
 *
 * @returns {Promise<{supported:boolean, detail:string}>}
 */
export function supportsFsContainment() {
  if (cachedFs) return cachedFs;
  cachedFs = (async () => {
    let ws = null;
    let canary = null;
    try {
      ws = await mkdtemp(path.join(tmpdir(), 'ac-fs-probe-'));
      canary = path.join(tmpdir(), `ac-host-canary-${Date.now()}-${process.pid}.txt`);
      await writeFile(canary, 'HOST_CANARY', 'utf8');
      await writeFile(path.join(ws, 'probe.js'), "'use strict';const fs=require('fs');try{fs.readFileSync(process.env.AC_CANARY,'utf8');console.log('READ_OK');}catch(e){console.log('BLOCKED:'+(e.code||'ERR'));}", 'utf8');
      const { stdout } = await execFileAsync(process.execPath, [
        '--permission',
        `--allow-fs-read=${ws}`,
        `--allow-fs-write=${ws}`,
        path.join(ws, 'probe.js'),
      ], { env: { PATH: process.env.PATH, AC_CANARY: canary }, timeout: 10000 });
      const blocked = String(stdout ?? '').includes('BLOCKED');
      return blocked
        ? { supported: true, detail: `Node permission containment verified: host read blocked (${ws} only).` }
        : { supported: false, detail: 'Node permission probe unexpectedly read the host canary.' };
    } catch (err) {
      return { supported: false, detail: `Filesystem-containment probe failed: ${err?.message ?? err}` };
    } finally {
      if (ws) await rm(ws, { recursive: true, force: true }).catch(() => {});
      if (canary) await rm(canary, { force: true }).catch(() => {});
    }
  })();
  return cachedFs;
}

/**
 * Full local assessment: network namespace + filesystem containment.
 * Untrusted execution is allowed ONLY when every boundary holds AND the
 * caller explicitly opts in with allowLiveExecution=true (production default
 * is false). A Docker container (network=none, pids-limit, memory, read-only
 * FS, no key mount) remains the recommended production target; this
 * process-level boundary is the offline-tested local baseline, not a claim
 * that containers are unnecessary.
 */
export async function assessIsolation({ allowLiveExecution = false } = {}) {
  const [network, fs] = await Promise.all([detectNetworkIsolation(), supportsFsContainment()]);
  const reasons = [];
  if (!network.prefix) reasons.push(`network: ${network.fallback_reason}`);
  if (!fs.supported) reasons.push(`filesystem: ${fs.detail}`);
  if (!allowLiveExecution) reasons.push('policy: allowLiveExecution=false (live untrusted execution stays disabled by default).');
  return {
    network_namespace: network.network_namespace,
    network_prefix: network.prefix,
    network_fallback_reason: network.fallback_reason,
    fs_containment: fs,
    allowLiveExecution: Boolean(allowLiveExecution),
    canExecuteUntrusted: Boolean(network.prefix && fs.supported && allowLiveExecution),
    reasons,
  };
}
