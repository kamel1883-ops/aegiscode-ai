import test from 'node:test';
import assert from 'node:assert/strict';

import { classify, VERDICTS } from '../src/classify.js';

/**
 * Canonical observations under the corrected design: the experimental variable
 * is resource availability, so the original in the baseline (A) does not show
 * the event because the resource is withheld — and that is exactly what makes
 * a single test misleading.
 */
function observations(overrides = {}) {
  const base = {
    A: { status: 'completed', unsafe_event_recurred: false, legitimate_ok: true, intervention_valid: null, attempts: 1 },
    B: { status: 'completed', unsafe_event_recurred: true, legitimate_ok: true, intervention_valid: true, attempts: 1 },
    C: { status: 'completed', unsafe_event_recurred: false, legitimate_ok: true, intervention_valid: null, attempts: 1 },
    D: { status: 'completed', unsafe_event_recurred: false, legitimate_ok: true, intervention_valid: true, attempts: 1 },
  };
  for (const [key, patch] of Object.entries(overrides)) {
    base[key] = { ...base[key], ...patch };
  }
  return base;
}

test('the classifier emits exactly one of the four verdicts', () => {
  assert.deepEqual(VERDICTS, [
    'patch_supported',
    'environment_masked',
    'interaction_dependent',
    'inconclusive',
  ]);
});

test('(C=no, D=no) ⇒ patch_supported', () => {
  const r = classify(observations());
  assert.equal(r.verdict, 'patch_supported');
  assert.equal(r.reason_code, 'no_recurrence_with_resource_available');
  assert.ok(r.limitations.length > 0, 'a verdict must carry explicit limitations');
});

test('(C=no, D=yes) ⇒ environment_masked — the success came from the environment, not the patch', () => {
  const r = classify(observations({ D: { unsafe_event_recurred: true } }));
  assert.equal(r.verdict, 'environment_masked');
  assert.equal(r.reason_code, 'success_in_baseline_only');
});

test('(C=yes, D=no) ⇒ interaction_dependent — the result reverses with the resource', () => {
  const r = classify(observations({ C: { unsafe_event_recurred: true } }));
  assert.equal(r.verdict, 'interaction_dependent');
  assert.equal(r.reason_code, 'effect_reverses_with_environment');
});

test('(C=yes, D=yes) ⇒ the vulnerability persists in both conditions; the patch is ineffective', () => {
  const r = classify(observations({ C: { unsafe_event_recurred: true }, D: { unsafe_event_recurred: true } }));
  assert.equal(r.verdict, 'environment_masked');
  assert.equal(r.reason_code, 'vulnerability_persists_in_all_conditions');
});

test('recurrence in the baseline (A) does not invalidate the classification', () => {
  const r = classify(observations({ A: { unsafe_event_recurred: true } }));
  assert.equal(r.verdict, 'patch_supported');
  assert.equal(r.conventional_test.misleading, false);
  assert.equal(r.conventional_test.would_report, 'failure');
});

test('the conventional test in A would have produced a false result', () => {
  const r = classify(observations());
  assert.equal(r.conventional_test.would_report, 'success');
  assert.equal(r.conventional_test.misleading, true);
});

test('strict rule: timeout is classified as failure, not success', () => {
  for (const key of ['A', 'B', 'C', 'D']) {
    const r = classify(observations({ [key]: { status: 'timeout' } }));
    assert.equal(r.verdict, 'inconclusive', `condition ${key}: timeout must be inconclusive`);
    assert.match(r.reason_code, new RegExp(`incomplete_run_${key}`));
  }
});

test('strict rule: crash is classified as failure, not success', () => {
  assert.equal(classify(observations({ D: { status: 'crash' } })).verdict, 'inconclusive');
});

test('a missing condition ⇒ inconclusive', () => {
  const obs = observations();
  delete obs.C;
  const r = classify(obs);
  assert.equal(r.verdict, 'inconclusive');
  assert.equal(r.reason_code, 'condition_missing');
});

test('the validity gate blocks a verdict when the intervention is not proven', () => {
  for (const key of ['B', 'D']) {
    const r = classify(observations({ [key]: { intervention_valid: false } }));
    assert.equal(r.verdict, 'inconclusive', `condition ${key}: the validity gate must block the verdict`);
    assert.match(r.reason_code, new RegExp(`intervention_not_validated_${key}`));
  }
});

test('failed legitimate behavior blocks the verdict — event disappearance means nothing without a clean run', () => {
  const r = classify(observations({ C: { legitimate_ok: false } }));
  assert.equal(r.verdict, 'inconclusive');
  assert.match(r.reason_code, /legitimate_behavior_failed_C/);
});

test('the premise is not established if the resource did not enable the path in B', () => {
  const r = classify(observations({ B: { unsafe_event_recurred: false } }));
  assert.equal(r.verdict, 'inconclusive');
  assert.equal(r.reason_code, 'premise_not_established');
});

test('no observations ⇒ inconclusive', () => {
  assert.equal(classify({}).verdict, 'inconclusive');
  assert.equal(classify(null).verdict, 'inconclusive');
});

test('every machine verdict belongs to the four verdicts and carries a reason and limitations', () => {
  const scenarios = [
    observations(),
    observations({ D: { unsafe_event_recurred: true } }),
    observations({ C: { unsafe_event_recurred: true } }),
    observations({ C: { unsafe_event_recurred: true }, D: { unsafe_event_recurred: true } }),
    observations({ A: { unsafe_event_recurred: true } }),
    observations({ A: { status: 'timeout' } }),
    observations({ B: { intervention_valid: false } }),
    observations({ B: { unsafe_event_recurred: false } }),
  ];
  for (const obs of scenarios) {
    const r = classify(obs);
    assert.ok(VERDICTS.includes(r.verdict), `non-approved verdict: ${r.verdict}`);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'a verdict must carry a reason');
    assert.ok(Array.isArray(r.limitations) && r.limitations.length > 0, 'a verdict must carry limitations');
  }
});

test('the evidence records resource availability for every condition', () => {
  const r = classify(observations());
  assert.deepEqual(r.evidence.resource_availability, {
    A: 'withheld',
    B: 'guaranteed',
    C: 'withheld',
    D: 'guaranteed',
  });
  assert.deepEqual(r.evidence.recurrence, { A: false, B: true, C: false, D: false });
});
