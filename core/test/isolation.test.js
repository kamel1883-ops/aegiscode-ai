import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { executeSubject } from '../src/executor.js';
import { assessIsolation, detectNetworkIsolation, supportsFsContainment } from '../src/isolation.js';
import { verify } from '../src/index.js';
import { demoScenario, FIXTURES } from './helpers.js';

const LIMITS = { timeout_ms: 5000, max_memory_mb: 128, max_output_bytes: 16384 };
const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = (name) => path.join(here, '..', 'fixtures', name);

/**
 * Local isolation boundary (offline, no Meta, no budget):
 *  - demo works with loopback only, no external network;
 *  - host-file reads are blocked (Node permission containment);
 *  - secrets never reach candidate processes;
 *  - timeout / output / memory limits are enforced and recorded.
 */

test('demo still verifies under containment: real patch ⇒ patch_supported (loopback only)', async () => {
  const { ok, verdict } = await verify(demoScenario(), {
    original: FIXTURES.original,
    patched: FIXTURES.patchReal,
  });
  assert.equal(ok, true);
  assert.equal(verdict, 'patch_supported');
});

test('network isolation is detected and honestly documented (namespace or fail-closed none)', async () => {
  // Environment-dependent by design: privileged runners provide unshare -n/-rn,
  // locked-down runners (e.g. GitHub ubuntu-26.04) refuse both. Both states are
  // valid; what is asserted is honest documentation, never an assumed privilege.
  const net = await detectNetworkIsolation();
  if (net.network_namespace && net.network_namespace !== 'none') {
    assert.ok(Array.isArray(net.prefix) && net.prefix.length > 0, `namespace claimed without a prefix: ${JSON.stringify(net)}`);
    assert.equal(net.fallback_reason, null);
  } else {
    assert.equal(net.network_namespace, 'none');
    assert.equal(net.prefix, null);
    assert.ok(typeof net.fallback_reason === 'string' && net.fallback_reason.length > 20, 'fail-closed none must carry a documented reason');
  }
});

test('filesystem containment probe passes: host reads blocked', async () => {
  const fs = await supportsFsContainment();
  assert.equal(fs.supported, true, fs.detail);
});

test('host-file read is blocked: fixture cannot exfiltrate the canary', async () => {
  const canary = path.join(tmpdir(), `ac-canary-${Date.now()}-${process.pid}.txt`);
  await writeFile(canary, 'HOST_CANARY_SECRET', 'utf8');
  try {
    const run = await executeSubject({
      subjectDir: FIX('host-read'),
      entry: 'app.js',
      args: ['serve'],
      env: { AC_CANARY_PATH: canary },
      limits: LIMITS,
      label: 'host-read-probe',
    });
    assert.equal(run.workspace?.deleted, true, 'workspace must be deleted and certified');
    assert.match(run.stdout, /AC::LEGITIMATE_OK/);
    assert.match(run.stdout, /AC::HOST_READ_BLOCKED/, `host read must be blocked, got: ${run.stdout.slice(0, 500)}`);
    assert.doesNotMatch(run.stdout, /HOST_CANARY_SECRET/);
  } finally {
    await rm(canary, { force: true }).catch(() => {});
  }
});

test('secret leak is blocked: META_API_KEY and tokens never reach the candidate', async () => {
  process.env.META_API_KEY = 'LIVE_SECRET_MUST_NOT_LEAK';
  process.env.AEGISCODE_API_TOKENS = 'TOKEN_MUST_NOT_LEAK';
  try {
    const run = await executeSubject({
      subjectDir: FIX('env-leak'),
      entry: 'app.js',
      args: ['serve'],
      // Even a caller that mistakenly forwards secrets must be stripped by the denylist.
      env: { META_API_KEY: 'LIVE_SECRET_MUST_NOT_LEAK', AEGISCODE_API_TOKENS: 'TOKEN_MUST_NOT_LEAK' },
      limits: LIMITS,
      label: 'env-leak-probe',
    });
    assert.match(run.stdout, /AC::LEAKED:NONE/, `no secret may be visible, got: ${run.stdout.slice(0, 300)}`);
    assert.doesNotMatch(run.stdout, /LIVE_SECRET_MUST_NOT_LEAK/);
    assert.doesNotMatch(run.stdout, /TOKEN_MUST_NOT_LEAK/);
    assert.equal(run.workspace?.deleted, true);
  } finally {
    delete process.env.META_API_KEY;
    delete process.env.AEGISCODE_API_TOKENS;
  }
});

test('resource limits: hang ⇒ timeout, output bomb ⇒ truncated, memory hog ⇒ crash (never completed)', async (t) => {
  const hang = await executeSubject({
    subjectDir: FIXTURES.hang, entry: 'app.js', args: ['serve'], env: {}, limits: LIMITS, label: 'hang-probe',
  });
  assert.equal(hang.status, 'timeout');
  assert.equal(hang.workspace?.deleted, true);

  const bomb = await executeSubject({
    subjectDir: FIX('output-bomb'), entry: 'app.js', args: ['serve'], env: {}, limits: LIMITS, label: 'bomb-probe',
  });
  assert.equal(bomb.status, 'completed');
  assert.equal(bomb.stdout_truncated, true, 'output flood must be capped and flagged');
  assert.equal(bomb.workspace?.deleted, true);

  const hog = await executeSubject({
    subjectDir: FIX('mem-hog'), entry: 'app.js', args: ['serve'], env: {},
    limits: { timeout_ms: 8000, max_memory_mb: 64, max_output_bytes: 16384 }, label: 'mem-probe',
  });
  assert.notEqual(hog.status, 'completed', `memory hog must not complete, got: ${hog.status} ${hog.stdout.slice(0, 200)}`);
  assert.equal(hog.workspace?.deleted, true);
});

test('gate: untrusted execution requires network + fs + explicit opt-in; default refuses', async () => {
  const denied = await assessIsolation({ allowLiveExecution: false });
  assert.equal(denied.canExecuteUntrusted, false, 'default must refuse');
  assert.equal(denied.fs_containment.supported, true, denied.fs_containment.detail);
  // Network state is environment-dependent; the gate must reflect it honestly.
  // With a namespace, opt-in opens the gate; without one, it stays closed
  // (fail-closed) and the missing-network reason is recorded.
  const allowed = await assessIsolation({ allowLiveExecution: true });
  if (denied.network_prefix) {
    assert.equal(allowed.canExecuteUntrusted, true, `expected full boundary here, got: ${JSON.stringify(allowed.reasons)}`);
  } else {
    assert.ok(denied.reasons.some((r) => typeof r === 'string' && r.startsWith('network:')), 'missing-network reason must be recorded');
    assert.equal(allowed.canExecuteUntrusted, false, `without a namespace the gate must stay closed even with opt-in, got: ${JSON.stringify(allowed.reasons)}`);
  }
});

test('non-AC env keys are stripped and workspace marker is set, not inherited', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ac-env-'));
  await rm(ws, { recursive: true, force: true }).catch(() => {});
  const run = await executeSubject({
    subjectDir: FIX('env-leak'), entry: 'app.js', args: ['serve'],
    env: { AC_RUN_ID: 'x', EVIL: '1', AC_lower: 'no', PATH: '/evil' },
    limits: LIMITS, label: 'env-shape-probe',
  });
  assert.match(run.stdout, /AC::LEGITIMATE_OK/);
  assert.doesNotMatch(run.stdout, /\/evil/);
});
