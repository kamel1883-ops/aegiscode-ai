import test from 'node:test';
import assert from 'node:assert/strict';

import { verify } from '../src/index.js';
import { demoScenario, FIXTURES } from './helpers.js';

/**
 * This file is the core of the approach made concrete: one experiment run on a
 * "real patch" and on a "fake patch" that produce the **same conventional test
 * result** ("the event did not recur"), and the system must emit a different
 * verdict for each.
 */

test('real patch ⇒ patch_supported', async () => {
  const { ok, verdict, report, markdown } = await verify(demoScenario(), {
    original: FIXTURES.original,
    patched: FIXTURES.patchReal,
  });

  assert.equal(ok, true);
  assert.equal(verdict, 'patch_supported', `the verdict was: ${report?.reason}`);

  // All four conditions must have really completed — completion is never assumed.
  for (const c of report.conditions) {
    assert.equal(c.observation.status, 'completed', `condition ${c.condition}: ${c.error}`);
  }

  // The expected causal pattern: B recurs, nothing else does.
  assert.deepEqual(report.evidence.recurrence, { A: false, B: true, C: false, D: false });

  // The validity gate is proven in the two substituted conditions.
  for (const key of ['B', 'D']) {
    const c = report.conditions.find((x) => x.condition === key);
    assert.equal(c.intervention.valid, true, `condition ${key}: validity gate`);
  }

  // The report carries a reason, limitations, explicit failure attribution,
  // and never auto-merges.
  assert.ok(report.reason.length > 0);
  assert.ok(report.limitations.length > 0);
  assert.ok(Array.isArray(report.failure_attribution.environment_setup_failures));
  assert.ok(Array.isArray(report.failure_attribution.test_failures));
  assert.equal(report.human_decision.status, 'pending', 'no auto-merge');
  assert.match(markdown, /Verdict/);
});

test('fake patch ⇒ environment_masked — and the conventional test declares a false success', async () => {
  const { ok, verdict, report } = await verify(demoScenario(), {
    original: FIXTURES.original,
    patched: FIXTURES.patchFake,
  });

  assert.equal(ok, true);
  assert.equal(verdict, 'environment_masked', `the verdict was: ${report?.reason}`);
  assert.equal(report.reason_code, 'success_in_baseline_only');

  // Ordinary human intuition says "success" — and condition C confirms it.
  const c = report.conditions.find((x) => x.condition === 'C');
  assert.equal(c.observation.unsafe_event_recurred, false, 'C must not recur — and that is the false success');

  // The matrix exposes that the vulnerability is fully alive when the resource
  // is available.
  const d = report.conditions.find((x) => x.condition === 'D');
  assert.equal(d.observation.unsafe_event_recurred, true, 'D must recur — the vulnerability remains');

  // And the conventional test was misleading — which is what demonstrates the
  // value of the approach.
  assert.equal(report.conventional_test.would_report, 'success');
  assert.equal(report.conventional_test.misleading, true);
});

test('both patches produce the same conventional test result — and the system distinguishes them', async () => {
  const real = await verify(demoScenario(), { original: FIXTURES.original, patched: FIXTURES.patchReal });
  const fake = await verify(demoScenario(), { original: FIXTURES.original, patched: FIXTURES.patchFake });

  // The conventional test on the patched version in the baseline declares
  // success in both cases.
  const cReal = real.report.conditions.find((x) => x.condition === 'C');
  const cFake = fake.report.conditions.find((x) => x.condition === 'C');
  assert.equal(cReal.observation.unsafe_event_recurred, false);
  assert.equal(cFake.observation.unsafe_event_recurred, false);

  // But the causal verdict differs in essence.
  assert.notEqual(real.verdict, fake.verdict);
  assert.equal(real.verdict, 'patch_supported');
  assert.equal(fake.verdict, 'environment_masked');
});

test('strict rule: a hanging run ⇒ timeout = inconclusive, never a fix', async () => {
  const { ok, verdict, report } = await verify(demoScenario({ maximum_attempts: 1 }), {
    original: FIXTURES.original,
    patched: FIXTURES.hang,
  });

  assert.equal(ok, true);
  assert.equal(verdict, 'inconclusive');
  assert.match(report.reason_code, /incomplete_run_[CD]/);

  const hung = report.conditions.find((x) => x.observation.status === 'timeout');
  assert.ok(hung, 'a timeout state must be explicitly recorded');
  assert.ok(hung.error.includes('Timed out'));

  // A setup or executive failure is explicitly attributed and never swallowed.
  const attribution = report.failure_attribution.test_failures;
  assert.ok(attribution.length > 0, 'the test failure must be attributed');
});

test('conditions C and D run the same code in two different environments only', async () => {
  const { report } = await verify(demoScenario(), {
    original: FIXTURES.original,
    patched: FIXTURES.patchReal,
  });

  const c = report.conditions.find((x) => x.condition === 'C');
  const d = report.conditions.find((x) => x.condition === 'D');

  assert.equal(c.subject_dir, d.subject_dir, 'the same patched version in C and D');
  assert.equal(c.environment, 'baseline');
  assert.equal(d.environment, 'substituted');
  assert.equal(c.intervention, null, 'no synthetic resource in the baseline at all');
  assert.ok(d.intervention, 'the synthetic resource exists in the substituted condition');

  // And the actual run context must be auditable.
  assert.ok(d.run_id && d.run_id.includes('-D-'), `condition D run id: ${d.run_id}`);
  assert.equal(c.intervention, null);
});

test('the synthetic resource stays on loopback — no external internet', async () => {
  const { report } = await verify(demoScenario(), {
    original: FIXTURES.original,
    patched: FIXTURES.patchReal,
  });

  for (const c of report.conditions) {
    if (!c.intervention) continue;
    for (const req of c.intervention.sample_requests) {
      assert.ok(
        req.remote_address === null || req.remote_address.startsWith('127.'),
        `request from a non-local address: ${req.remote_address}`,
      );
    }
  }
});

test('a broken scenario is rejected before anything runs', async () => {
  const { ok, errors } = await verify(demoScenario({ unsafe_event: '' }), {
    original: FIXTURES.original,
    patched: FIXTURES.patchReal,
  });
  assert.equal(ok, false);
  assert.ok(errors.length > 0);
});

test('missing code paths are rejected', async () => {
  const { ok, errors } = await verify(demoScenario(), { original: FIXTURES.original });
  assert.equal(ok, false);
});
