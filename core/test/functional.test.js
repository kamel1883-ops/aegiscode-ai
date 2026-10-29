import test from 'node:test';
import assert from 'node:assert/strict';

import { verify } from '../src/index.js';
import { demoScenario, FIXTURES } from './helpers.js';

function scenarioWithFunctional() {
  return demoScenario({
    functional_checks: {
      require_markers: ['AC::TEMPLATE_RENDERED'],
      forbid_template_fetch_in_patch: true,
      require_dynamic_echo: false,
      require_computed_render: true,
    },
  });
}

test('stub candidate: security supported BUT functional fails → overall rejected, never a verified repair', async () => {
  const { ok, verdict, report } = await verify(scenarioWithFunctional(), {
    original: FIXTURES.original,
    patched: FIXTURES.patchStub,
  });
  assert.equal(ok, true);
  // Security alone still sees no recurrence with resource.
  assert.equal(verdict, 'patch_supported');
  assert.equal(report.security_verdict, 'patch_supported');
  // Functional must fail: no TEMPLATE_RENDERED in C/D.
  assert.equal(report.functional.status, 'fail');
  // Overall must NOT be accepted.
  assert.equal(report.acceptance.decision, 'rejected');
  assert.match(report.acceptance.reason, /NOT a verified repair/);
  // Evidence is externally observable: harness counted zero template fetches
  // but the rendered marker is missing.
  const d = report.conditions.find((x) => x.condition === 'D');
  assert.equal(d.functional.template_requests, 0);
  assert.deepEqual(d.functional.rendered_missing, ['AC::TEMPLATE_RENDERED']);
});

test('safe implementation: security supported AND functional passes → accepted', async () => {
  const { ok, verdict, report } = await verify(scenarioWithFunctional(), {
    original: FIXTURES.original,
    patched: FIXTURES.patchReal,
  });
  assert.equal(ok, true);
  assert.equal(verdict, 'patch_supported');
  assert.equal(report.functional.status, 'pass');
  assert.equal(report.acceptance.decision, 'accepted');
  const d = report.conditions.find((x) => x.condition === 'D');
  assert.equal(d.functional.template_requests, 0);
  assert.equal(d.functional.functional_ok, true);
});

test('sneaky candidate: prints every static marker yet renders nothing harness-owned → rejected', async () => {
  const { ok, verdict, report } = await verify(scenarioWithFunctional(), {
    original: FIXTURES.original,
    patched: FIXTURES.patchSneaky,
  });
  assert.equal(ok, true);
  // Security alone sees no recurrence (no fetch), so the old marker-only
  // logic would have called this patch_supported.
  assert.equal(verdict, 'patch_supported');
  // But the harness-owned dynamic echo is missing: static printing is not
  // functionality, so overall acceptance is rejected.
  assert.equal(report.functional.status, 'fail');
  assert.equal(report.acceptance.decision, 'rejected');
  assert.match(report.acceptance.reason, /NOT a verified repair/);
  const d = report.conditions.find((x) => x.condition === 'D');
  assert.equal(d.functional.template_requests, 0);
  assert.equal(d.functional.computed_render_required, true);
  assert.equal(d.functional.computed_ok, false);
});

test('echo cheat: reads every harness input and prints it verbatim without computing → rejected', async () => {
  const { ok, verdict, report } = await verify(scenarioWithFunctional(), {
    original: FIXTURES.original,
    patched: FIXTURES.patchEcho,
  });
  assert.equal(ok, true);
  assert.equal(verdict, 'patch_supported');
  assert.equal(report.functional.status, 'fail');
  assert.equal(report.acceptance.decision, 'rejected');
  assert.match(report.acceptance.reason, /NOT a verified repair/);
  const d = report.conditions.find((x) => x.condition === 'D');
  assert.equal(d.functional.template_requests, 0);
  assert.equal(d.functional.computed_render_required, true);
  assert.equal(d.functional.computed_ok, false);
  assert.equal(d.functional.computed_cases.length, 2);
  assert.ok(d.functional.computed_cases.every((c) => c.matched === false));
});

test('live-model exit-only candidate fails the UI demo contract → rejected (mirrors the live run)', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  // Exact candidate proposed by the live model run: prints LEGITIMATE_OK
  // and exits — no rendering, no fetch. (Pasted-text sha256 2641d11f…;
  // compare with the advisory record's candidate.code before reuse.)
  const candidate = `'use strict';\nif (process.argv[2] !== 'serve') { process.exit(2); }\nconsole.log('AC::LEGITIMATE_OK');\nprocess.exit(0);\n`;
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-model-cand-'));
  await writeFile(path.join(dir, 'app.js'), candidate, 'utf8');
  try {
    const { ok, verdict, report } = await verify(demoScenario({
      functional_checks: {
        require_markers: ['AC::TEMPLATE_RENDERED'],
        forbid_template_fetch_in_patch: true,
        require_dynamic_echo: false,
        require_computed_render: false,
      },
    }), { original: FIXTURES.original, patched: dir });
    assert.equal(ok, true);
    // Causally supported (genuinely no recurrence) — but functionally void.
    assert.equal(verdict, 'patch_supported');
    assert.equal(report.functional.status, 'fail');
    assert.equal(report.acceptance.decision, 'rejected');
    const d = report.conditions.find((x) => x.condition === 'D');
    assert.equal(d.functional.template_requests, 0);
    assert.deepEqual(d.functional.rendered_missing, ['AC::TEMPLATE_RENDERED']);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('UI contract boundary: static-marker spoof passes it, full contract rejects it', async () => {
  // The UI demo contract has no computed proof (the demo patch does not
  // implement it), so static printing of the marker passes — a known,
  // documented limitation. The canonical contract closes it.
  const uiOnly = await verify(demoScenario({
    functional_checks: {
      require_markers: ['AC::TEMPLATE_RENDERED'],
      forbid_template_fetch_in_patch: true,
      require_dynamic_echo: false,
      require_computed_render: false,
    },
  }), { original: FIXTURES.original, patched: FIXTURES.patchSneaky });
  assert.equal(uiOnly.report.functional.status, 'pass');
  const full = await verify(scenarioWithFunctional(), { original: FIXTURES.original, patched: FIXTURES.patchSneaky });
  assert.equal(full.report.functional.status, 'fail');
  assert.equal(full.report.acceptance.decision, 'rejected');
});

test('vulnerable implementation: fails the security check', async () => {
  const { ok, verdict, report } = await verify(scenarioWithFunctional(), {
    original: FIXTURES.original,
    patched: FIXTURES.patchFake,
  });
  assert.equal(ok, true);
  // Fake patch still fetches → environment_masked, never accepted.
  assert.equal(verdict, 'environment_masked');
  assert.equal(report.acceptance.decision, 'rejected');
  const d = report.conditions.find((x) => x.condition === 'D');
  assert.ok(d.functional.template_requests > 0, 'fake patch must have fetched the template');
});
