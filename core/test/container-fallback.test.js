import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAgentArgs, buildDockerRunArgs, buildNetworkCreateArgs } from '../src/container.js';
import { verify } from '../src/index.js';
import { demoScenario, FIXTURES } from './helpers.js';

/**
 * require-container wiring: fail-closed, never silent fallback.
 * Environment-independent: Docker absence AND post-daemon init failure are
 * both injected — no real daemon is touched, started, or stopped, so these
 * pass identically whether or not Docker is installed.
 */

function withSandbox(value, fn) {
  const prev = process.env.AC_SANDBOX;
  process.env.AC_SANDBOX = value;
  return (async () => {
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.AC_SANDBOX;
      else process.env.AC_SANDBOX = prev;
    }
  })();
}

/** Process-agent spy: counts calls and refuses to run (must stay at zero). */
function processSpy(calls) {
  return async () => {
    calls.count += 1;
    throw new Error('process transport must not run in require-container mode');
  };
}

function daemonAbsent() {
  const err = new Error('simulated: Docker daemon unreachable (injected, no real daemon touched)');
  err.code = 'container_unavailable';
  throw err;
}

test('unknown AC_SANDBOX is refused instead of defaulting to process', async () => {
  const out = await withSandbox('bogus-sandbox', () =>
    verify(demoScenario(), { original: FIXTURES.original, patched: FIXTURES.patchReal }));
  assert.equal(out.ok, false);
  assert.ok(out.infra_refused === true, 'must be marked as infra refusal, not a verdict');
  assert.match(out.errors.join(' '), /sandbox_refused/);
});

test('require-container with an injected absent daemon rejects with zero process calls', async () => {
  const calls = { count: 0 };
  const out = await withSandbox('require-container', () =>
    verify(
      demoScenario(),
      { original: FIXTURES.original, patched: FIXTURES.patchReal },
      {
        transports: {
          containerAgent: daemonAbsent,
          processAgent: processSpy(calls),
        },
      },
    ));
  assert.equal(out.ok, false);
  assert.ok(out.infra_refused === true, 'must be marked as infra refusal, not a verdict');
  assert.match(out.errors.join(' '), /container_unavailable|Docker daemon unreachable/);
  assert.equal(calls.count, 0, 'process transport must never run as fallback');
});

test('container init failure after a reachable daemon still rejects without fallback', async () => {
  const calls = { count: 0 };
  const out = await withSandbox('require-container', () =>
    verify(
      demoScenario(),
      { original: FIXTURES.original, patched: FIXTURES.patchReal },
      {
        transports: {
          // Daemon "reachable" (no throw here) but the agent reports an
          // infrastructure error — init failure, not a candidate result.
          containerAgent: async () => ({
            agent_error: 'simulated: Docker daemon unreachable during container create (injected)',
            stderr: '',
          }),
          processAgent: processSpy(calls),
        },
      },
    ));
  assert.equal(out.ok, false);
  assert.ok(out.infra_refused === true, 'init failure must refuse, not fall back');
  assert.equal(calls.count, 0, 'process transport must never run as fallback');
});

test('candidate crash/timeout stays an ordinary verification outcome, not infra refusal', async () => {
  const prev = process.env.AC_SANDBOX;
  delete process.env.AC_SANDBOX;
  try {
    const out = await verify(demoScenario(), { original: FIXTURES.original, patched: FIXTURES.patchReal });
    assert.equal(out.ok, true, 'a candidate outcome must verify normally');
    assert.ok(out.infra_refused !== true, 'must not be marked as infra refusal');
    assert.ok(['patch_supported', 'environment_masked', 'interaction_dependent', 'inconclusive'].includes(out.verdict));
    // Regression guard: the success branch must carry the evidence key
    // (even when null in process mode) — its absence once hid container
    // evidence for completed conditions.
    for (const c of out.report.conditions) {
      assert.ok('container_evidence' in c, `condition ${c.condition} must carry container_evidence`);
    }
  } finally {
    if (prev !== undefined) process.env.AC_SANDBOX = prev;
  }
});

test('container builders carry job/condition labels for real Docker identity', () => {
  const labels = { 'ac.job': 'job-123', 'ac.condition': 'B', 'ac.run': 'ac-job-123-B-1' };
  const agent = buildAgentArgs({ network: 'acn-test', coreDir: '/app-core', subjectDir: '/subject', name: 'aca-test', labels });
  assert.ok(agent.includes('--label'), 'agent must carry labels');
  assert.ok(agent.includes('ac.job=job-123'), 'job label must be present');
  const net = buildNetworkCreateArgs('acn-test', labels);
  assert.ok(net.includes('--label'), 'network must carry labels');
  const single = buildDockerRunArgs({ workspaceHostPath: '/tmp/ac-work-123', name: 'ac-c-1', labels });
  assert.ok(single.argv.includes('--label'), 'single-shot run must carry labels');
});
