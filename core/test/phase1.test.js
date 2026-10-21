import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { verify } from '../src/index.js';
import { demoScenario, FIXTURES } from './helpers.js';

/**
 * Phase One acceptance tests — each test here corresponds to a declared
 * acceptance condition:
 *
 *  1. Deliberate sabotage: the execution evidence is blocked ⇒ no "fix" verdict
 *     is ever issued.
 *  2. The workspace-deletion certificate is checked by existence on disk,
 *     never assumed.
 *  3. Network isolation is documented in the report — with an explicit reason
 *     when unavailable, never overclaimed.
 *  4. The environment-setup and test-failure logs are separate: neither stands
 *     in for the other.
 *  5. The gate really precedes subject execution — by timestamp, not by claim.
 *  6. The code never runs in the coordinator process nor in the agent's process.
 */

test('deliberate sabotage: a failed validity gate blocks the fix verdict — inconclusive, not patch_supported', async () => {
  // The real patch usually yields patch_supported. Here we sabotage the
  // resource: we require a proof marker it never returns, disabling the gate.
  // Expected: the verdict is blocked and classified inconclusive.
  const sabotaged = demoScenario({
    intervention_validity_checks: {
      min_probes: 1,
      expect_status: 200,
      expect_body_contains: 'AC-PROBE-OK-THAT-NEVER-EXISTS',
    },
  });

  const { ok, verdict, report } = await verify(sabotaged, {
    original: FIXTURES.original,
    patched: FIXTURES.patchReal,
  });

  assert.equal(ok, true);
  assert.notEqual(verdict, 'patch_supported', 'a failed gate must always block the fix verdict');
  assert.equal(verdict, 'inconclusive');
  assert.match(report.reason_code, /intervention_not_validated_/);

  // The setup failure is attributed to the environment-setup log alone.
  const setup = report.failure_attribution.environment_setup_failures;
  assert.ok(setup.length > 0, 'the setup failure must be recorded in the environment-setup log');
  const gateFailures = setup.filter((f) => f.detail.includes('proof marker') || f.detail.includes('gate') || f.detail.includes('resource'));
  assert.ok(gateFailures.length > 0, `the detail must mention the gate failure reason: ${JSON.stringify(setup)}`);
});

test('deliberate sabotage 2: a resource that does not exhibit the flaw ⇒ premise not established ⇒ inconclusive', async () => {
  // We change the resource body so it carries no template marker; the original
  // then does not show the event in B. The premise (the resource is what
  // enables the path) is not established ⇒ no fix verdict is possible.
  const noPremise = demoScenario({
    synthetic_resource_profile: { kind: 'loopback_http', path: '/template', status: 200, body: 'SOMETHING-ELSE' },
  });

  const { verdict, report } = await verify(noPremise, {
    original: FIXTURES.original,
    patched: FIXTURES.patchReal,
  });

  assert.equal(verdict, 'inconclusive');
  assert.equal(report.reason_code, 'premise_not_established');
});

test('workspace-deletion certificate: every workspace really was deleted — checked, never assumed', async () => {
  const { report } = await verify(demoScenario(), {
    original: FIXTURES.original,
    patched: FIXTURES.patchReal,
  });

  assert.ok(report.executor, 'the report carries the execution-trail summary');
  assert.equal(report.executor.all_workspaces_deleted, true, 'every workspace must have been deleted');

  for (const row of report.executor.conditions) {
    assert.ok(row.workspace_path, `condition ${row.condition}: workspace path is documented`);
    assert.equal(
      existsSync(row.workspace_path),
      false,
      `condition ${row.condition}: the workspace still exists on disk: ${row.workspace_path}`,
    );
  }
});

test('network isolation is documented: unshare when available, and an explicit reason when not — isolation is never overclaimed', async () => {
  // markdown is returned by verify separately from the report object — and this
  // branch really does run on environments without unshare (e.g. GitHub
  // runners), so the test must not depend on a field that may not exist.
  const { report, markdown } = await verify(demoScenario(), {
    original: FIXTURES.original,
    patched: FIXTURES.patchReal,
  });

  assert.ok(report.isolation, 'the report documents the network-isolation state');
  const ns = report.isolation.network_namespace;

  if (ns === 'none') {
    // The environment does not allow unshare: the report must carry an
    // explicit reason, not silence.
    assert.ok(
      typeof report.isolation.fallback_reason === 'string' && report.isolation.fallback_reason.length > 0,
      'when isolation is not active the reason must be documented',
    );
    assert.match(markdown, /not available in this environment/);
  } else {
    assert.match(ns, /^unshare -[nr]+$/, `unknown isolation pattern: ${ns}`);
    assert.equal(report.isolation.fallback_reason, null);
  }
});

test('the two failure logs are separate: a test failure never shows in the setup log and vice versa', async () => {
  // (a) A hanging patch ⇒ a test failure (timeout) — it must not be recorded
  // as a setup failure.
  const hang = await verify(demoScenario({ maximum_attempts: 1 }), {
    original: FIXTURES.original,
    patched: FIXTURES.hang,
  });
  const hangFailures = hang.report.failure_attribution;
  assert.ok(hangFailures.test_failures.length > 0, 'a hang = a test failure');
  assert.ok(
    hangFailures.test_failures.every((f) => f.detail.includes('timed out') || f.detail.includes('crashed')),
    'the test-failure details describe the executive failure',
  );

  // (b) A sabotaged gate ⇒ a setup failure — it must not be recorded as a
  // test failure.
  const sabotaged = demoScenario({
    intervention_validity_checks: { min_probes: 1, expect_status: 200, expect_body_contains: 'NEVER' },
  });
  const gate = await verify(sabotaged, {
    original: FIXTURES.original,
    patched: FIXTURES.patchReal,
  });
  const gateFailures = gate.report.failure_attribution;
  assert.ok(gateFailures.environment_setup_failures.length > 0, 'a failed gate = a setup failure');
  assert.ok(
    gateFailures.environment_setup_failures.every((f) => !f.detail.includes('timed out') && !f.detail.includes('crashed')),
    'the setup log contains no executive-failure descriptions',
  );
});

test('the validity gate really preceded subject execution — by timestamp, not by claim', async () => {
  const { report } = await verify(demoScenario(), {
    original: FIXTURES.original,
    patched: FIXTURES.patchReal,
  });

  for (const key of ['B', 'D']) {
    const c = report.conditions.find((x) => x.condition === key);
    assert.ok(c.intervention.certificate, `condition ${key}: readiness certificate documented`);
    assert.ok(c.intervention.certificate.run_id.includes(`-${key}-`), 'the certificate carries the condition run id');
    assert.ok(c.intervention.certificate.probed_at, 'the certificate carries its issue time');
    assert.equal(c.intervention.gate_before_subject, true, `condition ${key}: the gate preceded the subject by time`);
    assert.ok(
      typeof c.intervention.certificate.body_excerpt === 'string' && c.intervention.certificate.body_excerpt.includes('AC-PROBE-OK'),
      `condition ${key}: the proof body is preserved in the certificate`,
    );
  }
});

test('the code never runs in the coordinator process — every condition runs through a separate agent', async () => {
  const { report } = await verify(demoScenario(), {
    original: FIXTURES.original,
    patched: FIXTURES.patchReal,
  });

  assert.equal(report.executor.all_runners_separate, true, 'every execution attempt goes through a separate agent');

  for (const row of report.executor.conditions) {
    assert.ok(row.runner_pid, `condition ${row.condition}: agent pid documented`);
    assert.notEqual(row.runner_pid, process.pid, `condition ${row.condition}: the agent is not the test process itself`);
    assert.ok(row.subject_pid, `condition ${row.condition}: subject pid documented`);
    assert.notEqual(row.subject_pid, row.runner_pid, `condition ${row.condition}: the subject is a child, not the agent itself`);
  }

  // The agent harness log documents its steps for auditability.
  const d = report.conditions.find((x) => x.condition === 'D');
  assert.ok(Array.isArray(d.harness_log) && d.harness_log.length > 0, 'the agent log is not empty');
});

test('the readiness certificate carries the run id, body and time — material evidence, not a description', async () => {
  const { report } = await verify(demoScenario(), {
    original: FIXTURES.original,
    patched: FIXTURES.patchFake,
  });

  const b = report.conditions.find((x) => x.condition === 'B');
  const cert = b.intervention.certificate;
  assert.equal(cert.run_id, b.run_id, 'the certificate id matches the condition run id');
  assert.match(cert.body_excerpt, /^AC-PROBE-OK:/, 'the proof body carries the real response string');
  assert.equal(cert.status, 200, 'the response status is documented');
});
