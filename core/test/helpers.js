import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURES = {
  original: path.join(here, '..', 'fixtures', 'original'),
  patchReal: path.join(here, '..', 'fixtures', 'patch-real'),
  patchFake: path.join(here, '..', 'fixtures', 'patch-fake'),
  patchStub: path.join(here, '..', 'fixtures', 'patch-stub'),
  patchSneaky: path.join(here, '..', 'fixtures', 'patch-sneaky'),
  patchEcho: path.join(here, '..', 'fixtures', 'patch-echo'),
  hang: path.join(here, '..', 'fixtures', 'hang'),
};

/** A demo scenario matching the eight mandatory document fields. */
export function demoScenario(overrides = {}) {
  return {
    id: 'demo-template-fetch',
    unsafe_event: 'AC::UNSAFE_EVENT',
    legitimate_behavior_checks: ['AC::LEGITIMATE_OK'],
    baseline_environment: { description: 'No network resource available', network: 'none' },
    permitted_interventions: [{ kind: 'synthetic_resource', name: 'template-endpoint' }],
    synthetic_resource_profile: {
      kind: 'loopback_http',
      path: '/template',
      status: 200,
      body: 'AC-RESOURCE-MARKER',
    },
    intervention_validity_checks: {
      min_probes: 1,
      expect_status: 200,
      expect_body_contains: 'AC-PROBE-OK',
    },
    resource_limits: { timeout_ms: 5000, max_memory_mb: 128, max_output_bytes: 16384 },
    maximum_attempts: 2,
    ...overrides,
  };
}
