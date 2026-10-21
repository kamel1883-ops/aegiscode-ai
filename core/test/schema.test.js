import test from 'node:test';
import assert from 'node:assert/strict';

import { validateScenario, SCENARIO_FIELDS } from '../src/schema.js';
import { demoScenario } from './helpers.js';

test('a complete, valid scenario is accepted and normalized', () => {
  const { ok, errors, scenario } = validateScenario(demoScenario());
  assert.equal(ok, true, `the scenario was rejected: ${errors.join(' | ')}`);
  assert.deepEqual(errors, []);
  assert.equal(scenario.unsafe_event, 'AC::UNSAFE_EVENT');
  assert.equal(scenario.synthetic_resource_profile.status, 200);
  assert.equal(scenario.intervention_validity_checks.min_probes, 1);
});

test('all eight fields are mandatory in both the documentation and the code', () => {
  assert.deepEqual(SCENARIO_FIELDS, [
    'unsafe_event',
    'legitimate_behavior_checks',
    'baseline_environment',
    'permitted_interventions',
    'synthetic_resource_profile',
    'intervention_validity_checks',
    'resource_limits',
    'maximum_attempts',
  ]);
});

test('every missing mandatory field fails validation', () => {
  for (const field of SCENARIO_FIELDS) {
    const raw = demoScenario();
    delete raw[field];
    const { ok, errors } = validateScenario(raw);
    assert.equal(ok, false, `the scenario must be rejected when ${field} is missing`);
    assert.ok(
      errors.some((e) => e.includes(field)),
      `the message must mention the missing field ${field}: ${errors.join(' | ')}`,
    );
  }
});

test('wrong data types are rejected', () => {
  const cases = [
    [demoScenario({ unsafe_event: '' }), 'empty unsafe_event'],
    [demoScenario({ legitimate_behavior_checks: [] }), 'empty checks array'],
    [demoScenario({ maximum_attempts: 0 }), 'maximum_attempts = 0'],
    [demoScenario({ maximum_attempts: 1.5 }), 'fractional maximum_attempts'],
    [
      demoScenario({ synthetic_resource_profile: { kind: 'loopback_http', path: 'no-slash', body: 'x' } }),
      'path without a leading slash',
    ],
    [
      demoScenario({ resource_limits: { timeout_ms: -1, max_memory_mb: 128, max_output_bytes: 1024 } }),
      'negative timeout',
    ],
    [
      demoScenario({ permitted_interventions: [{ kind: 'root_shell' }] }),
      'unsupported intervention kind',
    ],
  ];

  for (const [raw, label] of cases) {
    const { ok } = validateScenario(raw);
    assert.equal(ok, false, `must be rejected: ${label}`);
  }
});

test('a non-loopback resource is rejected — no external internet in the experiment', () => {
  const raw = demoScenario({
    synthetic_resource_profile: { kind: 'public_http', path: '/template', body: 'x' },
  });
  const { ok, errors } = validateScenario(raw);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('loopback_http')));
});

test('something that is not an object is rejected', () => {
  assert.equal(validateScenario(null).ok, false);
  assert.equal(validateScenario('scenario').ok, false);
  assert.equal(validateScenario([]).ok, false);
});
