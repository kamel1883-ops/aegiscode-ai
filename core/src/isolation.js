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

import { spawn } from 'node:child_process';

/** Resolved once per coordinator process: which isolation pattern is available, if any. */
let cachedProbe = null;

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
