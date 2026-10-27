/**
 * AegisCode — scenario schema (Phase Zero)
 *
 * The eight mandatory fields define a complete experiment contract.
 *
 * Validation is deliberately strict: a broken or incomplete scenario must never
 * reach the matrix runner, because a broken scenario can produce a **false
 * verdict** — which is worse than rejecting the scenario outright.
 */

export const SCENARIO_FIELDS = Object.freeze([
  'unsafe_event',
  'legitimate_behavior_checks',
  'baseline_environment',
  'permitted_interventions',
  'synthetic_resource_profile',
  'intervention_validity_checks',
  'resource_limits',
  'maximum_attempts',
]);

export const RESOURCE_LIMIT_DEFAULTS = Object.freeze({
  timeout_ms: 10_000,
  max_memory_mb: 256,
  max_output_bytes: 65_536,
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * Validates and normalizes a scenario.
 * @returns {{ok: boolean, errors: string[], scenario: object|null}}
 */
export function validateScenario(raw) {
  const errors = [];

  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['Scenario must be an object'], scenario: null };
  }

  for (const field of SCENARIO_FIELDS) {
    if (raw[field] === undefined || raw[field] === null) {
      errors.push(`Missing mandatory field: ${field}`);
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors, scenario: null };
  }

  // 1. unsafe_event
  if (typeof raw.unsafe_event !== 'string' || raw.unsafe_event.trim() === '') {
    errors.push('unsafe_event must be a non-empty string');
  }

  // 2. legitimate_behavior_checks
  if (!Array.isArray(raw.legitimate_behavior_checks) || raw.legitimate_behavior_checks.length === 0) {
    errors.push('legitimate_behavior_checks must be a non-empty array');
  } else if (!raw.legitimate_behavior_checks.every((c) => typeof c === 'string' && c.trim() !== '')) {
    errors.push('legitimate_behavior_checks entries must be non-empty strings');
  }

  // 3. baseline_environment
  if (!isPlainObject(raw.baseline_environment)) {
    errors.push('baseline_environment must be an object describing the baseline');
  }

  // 4. permitted_interventions
  if (!Array.isArray(raw.permitted_interventions) || raw.permitted_interventions.length === 0) {
    errors.push('permitted_interventions must be a non-empty array');
  } else {
    raw.permitted_interventions.forEach((item, i) => {
      if (!isPlainObject(item) || typeof item.kind !== 'string') {
        errors.push(`permitted_interventions[${i}] must contain a string "kind"`);
      } else if (item.kind !== 'synthetic_resource') {
        errors.push(`permitted_interventions[${i}]: intervention kind "${item.kind}" is not supported`);
      }
    });
  }

  // 5. synthetic_resource_profile
  const profile = raw.synthetic_resource_profile;
  if (!isPlainObject(profile)) {
    errors.push('synthetic_resource_profile must be an object');
  } else {
    if (profile.kind !== 'loopback_http') {
      errors.push('synthetic_resource_profile.kind must be loopback_http (external network access is blocked)');
    }
    if (typeof profile.path !== 'string' || !profile.path.startsWith('/')) {
      errors.push('synthetic_resource_profile.path must start with "/"');
    }
    if (typeof profile.body !== 'string') {
      errors.push('synthetic_resource_profile.body must be a string');
    }
    if (profile.status !== undefined && !isPositiveInteger(profile.status)) {
      errors.push('synthetic_resource_profile.status must be a positive integer');
    }
  }

  // 6. intervention_validity_checks
  const validity = raw.intervention_validity_checks;
  if (!isPlainObject(validity)) {
    errors.push('intervention_validity_checks must be an object');
  } else {
    if (!isPositiveInteger(validity.min_probes)) {
      errors.push('intervention_validity_checks.min_probes must be a positive integer');
    }
    if (validity.expect_status !== undefined && !isPositiveInteger(validity.expect_status)) {
      errors.push('intervention_validity_checks.expect_status must be a positive integer');
    }
    if (validity.expect_body_contains !== undefined && typeof validity.expect_body_contains !== 'string') {
      errors.push('intervention_validity_checks.expect_body_contains must be a string');
    }
  }

  // 7. resource_limits
  const limits = raw.resource_limits;
  if (!isPlainObject(limits)) {
    errors.push('resource_limits must be an object');
  } else {
    if (!isPositiveInteger(limits.timeout_ms)) {
      errors.push('resource_limits.timeout_ms must be a positive integer');
    }
    if (!isPositiveInteger(limits.max_memory_mb)) {
      errors.push('resource_limits.max_memory_mb must be a positive integer');
    }
    if (!isPositiveInteger(limits.max_output_bytes)) {
      errors.push('resource_limits.max_output_bytes must be a positive integer');
    }
  }

  // 8. maximum_attempts
  if (!isPositiveInteger(raw.maximum_attempts)) {
    errors.push('maximum_attempts must be a positive integer');
  }

  // 9. functional_checks (optional): externally-observable functional contract.
  const functional = raw.functional_checks ?? {};
  if (!isPlainObject(functional)) {
    errors.push('functional_checks must be an object when present');
  } else {
    if (functional.require_markers !== undefined && (!Array.isArray(functional.require_markers) || !functional.require_markers.every((c) => typeof c === 'string' && c.trim() !== ''))) {
      errors.push('functional_checks.require_markers must be an array of non-empty strings when present');
    }
    if (functional.forbid_template_fetch_in_patch !== undefined && typeof functional.forbid_template_fetch_in_patch !== 'boolean') {
      errors.push('functional_checks.forbid_template_fetch_in_patch must be a boolean when present');
    }
    if (functional.require_dynamic_echo !== undefined && typeof functional.require_dynamic_echo !== 'boolean') {
      errors.push('functional_checks.require_dynamic_echo must be a boolean when present');
    }
    if (functional.require_computed_render !== undefined && typeof functional.require_computed_render !== 'boolean') {
      errors.push('functional_checks.require_computed_render must be a boolean when present');
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, scenario: null };
  }

  return {
    ok: true,
    errors: [],
    scenario: {
      id: typeof raw.id === 'string' ? raw.id : 'scenario',
      unsafe_event: raw.unsafe_event.trim(),
      legitimate_behavior_checks: raw.legitimate_behavior_checks.map((c) => c.trim()),
      baseline_environment: { ...raw.baseline_environment },
      permitted_interventions: raw.permitted_interventions.map((i) => ({ ...i })),
      synthetic_resource_profile: {
        kind: profile.kind,
        path: profile.path,
        status: profile.status ?? 200,
        body: profile.body,
      },
      intervention_validity_checks: {
        min_probes: validity.min_probes,
        expect_status: validity.expect_status ?? 200,
        expect_body_contains: validity.expect_body_contains ?? '',
      },
      resource_limits: {
        timeout_ms: limits.timeout_ms ?? RESOURCE_LIMIT_DEFAULTS.timeout_ms,
        max_memory_mb: limits.max_memory_mb ?? RESOURCE_LIMIT_DEFAULTS.max_memory_mb,
        max_output_bytes: limits.max_output_bytes ?? RESOURCE_LIMIT_DEFAULTS.max_output_bytes,
      },
      maximum_attempts: raw.maximum_attempts,
      functional_checks: {
        require_markers: Array.isArray(functional.require_markers) ? functional.require_markers.map((c) => c.trim()) : [],
        forbid_template_fetch_in_patch: functional.forbid_template_fetch_in_patch ?? false,
        require_dynamic_echo: functional.require_dynamic_echo ?? false,
        require_computed_render: functional.require_computed_render ?? false,
      },
    },
  };
}
