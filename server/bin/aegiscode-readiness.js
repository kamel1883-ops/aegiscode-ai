#!/usr/bin/env node
/**
 * AegisCode — local readiness check (demo ops, no live model calls).
 *
 * Probes a running server and prints a one-page readiness verdict:
 *   1. GET /api/health            (public liveness)
 *   2. GET /api/auth/me            (token accepted)
 *   3. GET /api/meta/status        (integration state, model, budget)
 *
 * Usage:
 *   AEGISCODE_API_TOKEN="<token>" node server/bin/aegiscode-readiness.js [--base http://127.0.0.1:8080]
 *
 * Exit 0 = ready for a mock/offline demo. Exit 1 = not ready (reason printed).
 * A `live_disabled` or `mock` meta state is READY — this script never enables,
 * requires, or performs a live model call.
 */

const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return args[i + 1] ?? fallback;
}

const base = String(flag('base', 'http://127.0.0.1:8080')).replace(/\/+$/, '');
const token = String(flag('token', process.env.AEGISCODE_API_TOKEN ?? '')).trim();

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function get(path, authed) {
  const headers = authed && token ? { authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

let failed = false;
try {
  // Note: this server gates every /api/* route (including /api/health) behind
  // authentication, so the token is attached when one is configured.
  const health = await get('/api/health', true);
  const healthOk = health.status === 200 && health.body?.ok === true;
  check('server liveness (/api/health)', healthOk, healthOk ? `phase ${health.body.phase}` : `HTTP ${health.status}`);
  if (!healthOk) failed = true;
} catch (err) {
  check('server liveness (/api/health)', false, `unreachable: ${err.message}`);
  failed = true;
}

if (!token) {
  check('auth token present', false, 'set AEGISCODE_API_TOKEN or pass --token');
  failed = true;
} else {
  try {
    const me = await get('/api/auth/me', true);
    const meOk = me.status === 200;
    check('auth token accepted (/api/auth/me)', meOk, meOk ? `scope=${me.body.scope}` : `HTTP ${me.status}`);
    if (!meOk) failed = true;
  } catch (err) {
    check('auth token accepted (/api/auth/me)', false, err.message);
    failed = true;
  }

  try {
    const meta = await get('/api/meta/status', true);
    if (meta.status !== 200) {
      check('meta status readable (/api/meta/status)', false, `HTTP ${meta.status}`);
      failed = true;
    } else {
      const s = meta.body;
      check('meta status readable (/api/meta/status)', true, `state=${s.state} model=${s.model}`);
      const spendable = s.state === 'mock' || s.state === 'live_disabled';
      check(
        'demo-safe state (mock or live_disabled — no spend possible)',
        spendable,
        spendable
          ? `powered_by_meta=${s.powered_by_meta} remaining=$${s.budget?.remaining_total_usd}`
          : `state=${s.state}: live mode needs explicit approval before any demo`,
      );
      if (!spendable) failed = true;
    }
  } catch (err) {
    check('meta status readable (/api/meta/status)', false, err.message);
    failed = true;
  }
}

console.log(failed ? '\nREADINESS: NOT READY' : '\nREADINESS: READY for mock/offline demo (no live spend)');
process.exit(failed ? 1 : 0);
