/**
 * AegisCode — causal classifier (Phase Zero)
 *
 * A **pure** function with no I/O: it takes the four condition observations and
 * emits one of four verdicts. Keeping it separate from any execution is a
 * condition of auditability: the verdict must be reproducible from the
 * observations alone.
 *
 * The experimental variable is **resource availability** — this is the core of
 * the invention: instead of assuming the resource exists, it is made a
 * controlled variable between a baseline condition and a substituted synthetic
 * resource, while the security policy and the code version are held fixed
 * across both.
 *
 *          | a: baseline (resource withheld)      | b: substituted synthetic resource (guaranteed)
 *  --------+--------------------------------------+---------------------------------------------
 *  orig S  |  A                                   |  B
 *  patch P |  C                                   |  D
 *
 * A key experimental observation: in the baseline the unsafe event does **not**
 * appear for the original (A), because the resource is withheld — and that is
 * precisely what makes a single test misleading: it reports "safe" while the
 * vulnerability remains. The discrimination comes from comparing B with D, not
 * from A alone.
 */

export const VERDICTS = Object.freeze([
  'patch_supported',
  'environment_masked',
  'interaction_dependent',
  'inconclusive',
]);

export const CONDITIONS = Object.freeze([
  Object.freeze({ key: 'A', version: 'original', environment: 'baseline', resource: 'withheld' }),
  Object.freeze({ key: 'B', version: 'original', environment: 'substituted', resource: 'guaranteed' }),
  Object.freeze({ key: 'C', version: 'patched', environment: 'baseline', resource: 'withheld' }),
  Object.freeze({ key: 'D', version: 'patched', environment: 'substituted', resource: 'guaranteed' }),
]);

/** Conditions where proving intervention validity (resource availability) is mandatory. */
export const CONDITIONS_REQUIRING_INTERVENTION_PROOF = Object.freeze(['B', 'D']);

/**
 * "What a single conventional test would have reported" — i.e. running the
 * original in the baseline and declaring success if the event does not recur.
 * Including it in the report is what demonstrates the value of the approach:
 * it compares the conventional verdict with the causal one and shows where the
 * conventional one was misleading.
 */
function conventionalTest(a) {
  if (a !== true) {
    return {
      method: 'Single test: original code in the baseline environment',
      recurrence_observed: false,
      would_report: 'success',
      misleading: true,
      note: 'The conventional test declares success because the resource is withheld — the vulnerability was never actually exercised.',
    };
  }
  return {
    method: 'Single test: original code in the baseline environment',
    recurrence_observed: true,
    would_report: 'failure',
    misleading: false,
    note: 'The conventional test would have caught the vulnerability; no false result in this case.',
  };
}

function inconclusive(reasonCode, reason, evidence, limitation) {
  return {
    verdict: 'inconclusive',
    reason_code: reasonCode,
    reason,
    evidence,
    limitations: [limitation],
  };
}

function statusEvidence(observations) {
  return {
    statuses: Object.fromEntries(
      CONDITIONS.map(({ key }) => [key, observations[key]?.status ?? 'missing']),
    ),
  };
}

/**
 * Classifies the result of the four-condition experiment.
 *
 * @param {Record<string, {
 *   status: 'completed'|'timeout'|'crash'|'error'|'missing',
 *   unsafe_event_recurred?: boolean,
 *   legitimate_ok?: boolean,
 *   intervention_valid?: boolean|null,
 *   attempts?: number
 * }>} observations
 */
export function classify(observations) {
  if (typeof observations !== 'object' || observations === null) {
    const r = inconclusive(
      'no_observations',
      'No observations were provided for the four conditions.',
      {},
      'No verdict can be issued without a documented run of all four conditions.',
    );
    return { ...r, conventional_test: null };
  }

  // ---- Strict rule (1): timeout / crash / setup error = failure, never success ----
  for (const { key } of CONDITIONS) {
    const obs = observations[key];
    if (!obs) {
      const r = inconclusive(
        'condition_missing',
        `Condition ${key} never ran, so no verdict may be issued.`,
        statusEvidence(observations),
        'The condition matrix is incomplete.',
      );
      return { ...r, conventional_test: null };
    }
    if (obs.status !== 'completed') {
      const label =
        { timeout: 'timed out', crash: 'terminated by signal or non-zero exit', error: 'environment setup error' }[
          obs.status
        ] ?? obs.status;
      const r = inconclusive(
        `incomplete_run_${key}`,
        `Condition ${key}: ${label} — this is a failure, not a success.`,
        statusEvidence(observations),
        `Condition ${key} could not complete after ${obs.attempts ?? 1} attempt(s); no verdict may rest on an incomplete run.`,
      );
      return { ...r, conventional_test: null };
    }
  }

  // ---- Strict rule (2): failed legitimate behavior means the run proves nothing ----
  for (const { key } of CONDITIONS) {
    if (observations[key].legitimate_ok !== true) {
      const r = inconclusive(
        `legitimate_behavior_failed_${key}`,
        `Condition ${key}: legitimate-behavior checks did not pass, so the run does not prove the system worked correctly at all.`,
        statusEvidence(observations),
        'Disappearance of the unsafe event means nothing if the system is not proven to have run correctly.',
      );
      return { ...r, conventional_test: null };
    }
  }

  // ---- Intervention-validity gate: mandatory before any "real fix" verdict ----
  for (const key of CONDITIONS_REQUIRING_INTERVENTION_PROOF) {
    if (observations[key].intervention_valid !== true) {
      const r = inconclusive(
        `intervention_not_validated_${key}`,
        `Condition ${key}: no execution evidence proves the synthetic resource actually ran.`,
        statusEvidence(observations),
        'The validity gate prevented a false verdict: environment setup failures are recorded separately from test failures.',
      );
      return { ...r, conventional_test: conventionalTest(observations.A.unsafe_event_recurred) };
    }
  }

  // ---- Experimental premise: the resource is what enables reaching the exploit path ----
  // It is established in (B) alone: the original version with the resource
  // available exhibits the vulnerability.
  if (observations.B.unsafe_event_recurred !== true) {
    const r = inconclusive(
      'premise_not_established',
      'Condition B did not exhibit the event despite the resource being guaranteed, so it is not proven that the resource is what enables the exploit path.',
      statusEvidence(observations),
      'The experiment cannot distinguish a real fix from masking unless the resource is first shown to change the outcome.',
    );
    return { ...r, conventional_test: conventionalTest(observations.A.unsafe_event_recurred) };
  }

  // ---- Causal classification over (C, D) ----
  const a = observations.A.unsafe_event_recurred === true;
  const b = true; // established above
  const c = observations.C.unsafe_event_recurred === true;
  const d = observations.D.unsafe_event_recurred === true;

  const sharedEvidence = {
    statuses: Object.fromEntries(CONDITIONS.map(({ key }) => [key, observations[key].status])),
    recurrence: { A: a, B: b, C: c, D: d },
    resource_availability: { A: 'withheld', B: 'guaranteed', C: 'withheld', D: 'guaranteed' },
    intervention_valid: { A: null, B: true, C: null, D: true },
  };

  let result;

  if (!c && !d) {
    result = {
      verdict: 'patch_supported',
      reason_code: 'no_recurrence_with_resource_available',
      reason: 'The vulnerability recurred when the resource was available (B), and did not recur after the patch even with the resource available (D).',
      evidence: sharedEvidence,
      limitations: [
        'The verdict is scoped to the tested scenario and resource only; it does not generalize to other paths or privileges.',
        'This is evidence of the patch being effective in this scenario, not proof of full-system security.',
      ],
    };
  } else if (!c && d) {
    result = {
      verdict: 'environment_masked',
      reason_code: 'success_in_baseline_only',
      reason: 'The successful result appeared in the baseline (C) only; with the resource guaranteed the vulnerability recurred (D) — so the success came from the environment, not from the patch.',
      evidence: sharedEvidence,
      limitations: [
        'The patch did not fix the defect; the vulnerability remains, and declaring it safe creates false confidence in production.',
      ],
    };
  } else if (c && !d) {
    result = {
      verdict: 'interaction_dependent',
      reason_code: 'effect_reverses_with_environment',
      reason: 'The result reverses with resource availability: the vulnerability recurred in the baseline (C) but not with the resource guaranteed (D).',
      evidence: sharedEvidence,
      limitations: [
        'The patch effect is not uniform across environments, so neither result may be generalized to production.',
      ],
    };
  } else {
    result = {
      verdict: 'environment_masked',
      reason_code: 'vulnerability_persists_in_all_conditions',
      reason: 'The vulnerability recurred after the patch in both environments (C and D) — the patch is not effective and the vulnerability remains in full.',
      evidence: sharedEvidence,
      limitations: ['The patch proved effective in no environment; shipping it only creates false confidence.'],
    };
  }

  return { ...result, conventional_test: conventionalTest(a) };
}
