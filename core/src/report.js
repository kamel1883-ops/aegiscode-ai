/**
 * AegisCode — report builder (Phase Zero)
 *
 * A core requirement: the report must **separate** environment setup failures
 * from test failures, and must state the verdict's reason, evidence and
 * limitations. A report without limitations is a misleading report.
 */

import { CONDITIONS } from './classify.js';

/**
 * Builds two **separate** failure logs on purpose:
 *   - environment setup log: what failed before the subject ran or without reaching it.
 *   - test failure log: what failed in the subject itself during the experiment.
 * One is never counted in place of the other — both stay visible in the report.
 */
function classifyFailure(observations, conditions = {}) {
  const environment_setup_failures = [];
  const test_failures = [];

  for (const { key } of CONDITIONS) {
    const obs = observations[key];
    const cond = conditions[key];
    if (!obs) {
      test_failures.push({ condition: key, detail: 'never ran' });
      continue;
    }
    if (obs.status === 'error') {
      environment_setup_failures.push({ condition: key, detail: cond?.error || 'environment setup failed before the subject ran' });
    } else if (obs.status === 'timeout' || obs.status === 'crash') {
      test_failures.push({ condition: key, detail: obs.status === 'timeout' ? 'timed out' : 'crashed' });
    }
    if (obs.legitimate_ok === false && obs.status === 'completed') {
      test_failures.push({ condition: key, detail: 'legitimate-behavior checks did not pass' });
    }
    if (obs.intervention_valid === false) {
      environment_setup_failures.push({
        condition: key,
        detail: cond?.intervention?.reason || 'synthetic resource execution was not proven',
      });
    }
    // Workspace-deletion certificate: a deletion problem is a **setup** problem —
    // recorded and never swallowed.
    if (cond?.workspace && cond.workspace.deleted === false) {
      environment_setup_failures.push({ condition: key, detail: `could not confirm workspace deletion: ${cond.workspace.path}` });
    }
  }

  return { environment_setup_failures, test_failures };
}

/** Documents the execution trail: did the code run outside the coordinator process, and were workspaces deleted? */
function executorSummary(conditions) {
  const rows = CONDITIONS.map(({ key }) => {
    const c = conditions[key];
    return {
      condition: key,
      runner_pid: c?.executor?.runner_pid ?? null,
      subject_pid: c?.executor?.subject_pid ?? null,
      runner_is_separate_process: c?.executor?.runner_is_separate_process ?? false,
      subject_is_not_coordinator: c?.executor?.subject_is_not_coordinator ?? false,
      workspace_deleted: c?.workspace?.deleted ?? null,
      workspace_path: c?.workspace?.path ?? null,
    };
  });
  return {
    conditions: rows,
    all_runners_separate: rows.every((r) => r.runner_is_separate_process),
    all_workspaces_deleted: rows.every((r) => r.workspace_deleted === true),
  };
}

/**
 * Builds a structured report (reproducible JSON + human-readable Markdown).
 *
 * @param {object} params
 * @param {object} params.scenario
 * @param {object} params.classification output of classify()
 * @param {object} params.conditions     output of runMatrix()
 * @param {object} params.observations   output of runMatrix()
 */
export function buildReport({ scenario, classification, conditions, observations, isolation = null }) {
  const failures = classifyFailure(observations, conditions);

  const report = {
    schema: 'aegiscode.report/0.2',
    generated_at: new Date().toISOString(),
    scenario: {
      id: scenario.id,
      unsafe_event: scenario.unsafe_event,
      maximum_attempts: scenario.maximum_attempts,
      resource_limits: scenario.resource_limits,
    },
    isolation: isolation ?? {
      network_namespace: conditions.A?.isolation?.network_namespace ?? 'unknown',
      fallback_reason: conditions.A?.isolation?.fallback_reason ?? null,
    },
    executor: executorSummary(conditions),
    verdict: classification.verdict,
    security_verdict: classification.verdict,
    functional: classification.functional ?? { status: 'not_assessed', reason: 'No functional assessment.', detail: null },
    acceptance: classification.acceptance ?? { decision: 'needs_functional_review', reason: 'No acceptance decision.' },
    reason_code: classification.reason_code,
    reason: classification.reason,
    evidence: classification.evidence,
    limitations: classification.limitations,
    conventional_test: classification.conventional_test ?? null,
    failure_attribution: failures,
    conditions: CONDITIONS.map(({ key }) => ({
      condition: key,
      ...conditions[key],
      observation: observations[key],
    })),
    human_decision: {
      status: 'pending',
      note: 'The system emits the verdict and the evidence only; adoption is human, and there is no auto-merge or repository modification.',
    },
  };

  return { report, markdown: renderMarkdown(report) };
}

function verdictLabel(verdict) {
  return {
    patch_supported: 'Patch supported',
    environment_masked: 'Environment masked',
    interaction_dependent: 'Interaction dependent',
    inconclusive: 'Inconclusive',
  }[verdict] ?? verdict;
}

function conditionLabel(key) {
  return (
    {
      A: 'Original × baseline (resource withheld)',
      B: 'Original × substituted synthetic resource (guaranteed)',
      C: 'Patched × baseline (resource withheld)',
      D: 'Patched × substituted synthetic resource (guaranteed)',
    }[key] ?? key
  );
}

function renderMarkdown(report) {
  const lines = [];

  lines.push(`# Causal verification report — ${report.scenario.id}`);
  lines.push('');
  lines.push(`**Monitored unsafe event:** \`${report.scenario.unsafe_event}\``);
  lines.push(`**Run timeout:** ${report.scenario.resource_limits.timeout_ms} ms · **Maximum attempts:** ${report.scenario.maximum_attempts}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Verdict');
  lines.push('');
  lines.push(`| Verdict | Code |`);
  lines.push(`|---|---|`);
  lines.push(`| **${verdictLabel(report.verdict)}** | \`${report.verdict}\` |`);
  lines.push('');
  lines.push(`**Reason:** ${report.reason}`);
  lines.push('');
  lines.push(`**Reason code:** \`${report.reason_code}\``);
  lines.push('');
  lines.push(`**Security outcome:** \`${report.security_verdict ?? report.verdict}\``);
  lines.push('');
  lines.push(`**Functional regression:** \`${report.functional?.status ?? 'not_assessed'}\` — ${report.functional?.reason ?? ''}`);
  lines.push('');
  lines.push(`**Overall acceptance:** \`${report.acceptance?.decision ?? 'needs_functional_review'}\` — ${report.acceptance?.reason ?? ''}`);
  lines.push('');
  if (report.acceptance?.decision === 'rejected' && (report.security_verdict ?? report.verdict) === 'patch_supported') {
    lines.push('> Security supported BUT functionality was removed or cannot be established. This is NOT a verified repair.');
    lines.push('');
  }

  lines.push('## Condition matrix');
  lines.push('');
  lines.push('| Condition | Configuration | Run status | Event recurred | Intervention valid | Attempts |');
  lines.push('|---|---|---|---|---|---|');
  for (const c of report.conditions) {
    const o = c.observation;
    const recur = o.status === 'completed' ? (o.unsafe_event_recurred ? 'yes' : 'no') : '—';
    const valid = c.intervention ? (c.intervention.valid ? 'proven' : 'not proven') : 'n/a';
    lines.push(`| ${c.condition} | ${conditionLabel(c.condition)} | \`${o.status}\` | ${recur} | ${valid} | ${o.attempts} |`);
  }
  lines.push('');

  lines.push('## Failure attribution');
  lines.push('');
  if (report.failure_attribution.environment_setup_failures.length === 0 && report.failure_attribution.test_failures.length === 0) {
    lines.push('No attributed failures: all four conditions completed.');
  } else {
    if (report.failure_attribution.environment_setup_failures.length > 0) {
      lines.push('**Environment setup failures** (separate from test failures):');
      for (const f of report.failure_attribution.environment_setup_failures) {
        lines.push(`- Condition ${f.condition}: ${f.detail}`);
      }
    }
    if (report.failure_attribution.test_failures.length > 0) {
      lines.push('');
      lines.push('**Test failures:**');
      for (const f of report.failure_attribution.test_failures) {
        lines.push(`- Condition ${f.condition}: ${f.detail}`);
      }
    }
  }
  lines.push('');

  lines.push('## Intervention-validity evidence');
  lines.push('');
  for (const c of report.conditions) {
    if (!c.intervention) continue;
    lines.push(`- **Condition ${c.condition}:** ${c.intervention.reason}`);
    lines.push(`  - Readiness probes: ${c.intervention.probes} · Expected status: ${c.intervention.expected_status} · Observed: ${c.intervention.actual_status}`);
    if (c.intervention.certificate) {
      lines.push(`  - Readiness certificate issued at: ${c.intervention.certificate.probed_at} (run id \`${c.intervention.certificate.run_id}\`)`);
      lines.push(`  - Gate preceded subject execution: ${c.intervention.gate_before_subject ? 'yes' : 'no — evidence invalid'}`);
    }
    lines.push(`  - Requests reaching the resource: ${c.intervention.requests_seen}`);
  }
  lines.push('');

  lines.push('## Execution isolation and workspaces');
  lines.push('');
  lines.push(`**Network isolation:** ${report.isolation.network_namespace === 'none' ? 'not available in this environment' : report.isolation.network_namespace}`);
  if (report.isolation.fallback_reason) {
    lines.push('');
    lines.push(`*Reason it is not active:* ${report.isolation.fallback_reason}`);
  }
  lines.push('');
  lines.push('| Condition | Agent PID | Subject PID | Workspace deleted |');
  lines.push('|---|---|---|---|');
  for (const r of report.executor.conditions) {
    lines.push(`| ${r.condition} | ${r.runner_pid ?? '—'} | ${r.subject_pid ?? '—'} | ${r.workspace_deleted === true ? 'yes' : r.workspace_deleted === null ? '—' : '**no**'} |`);
  }
  lines.push('');

  if (report.conventional_test) {
    lines.push('## Conventional-test comparison');
    lines.push('');
    lines.push(`**Conventional method:** ${report.conventional_test.method}`);
    lines.push('');
    lines.push(`**What it would have reported:** ${report.conventional_test.would_report === 'success' ? 'success / safe' : 'failure / unsafe'}`);
    lines.push('');
    lines.push(`**Was it misleading:** ${report.conventional_test.misleading ? '**yes** — false result' : 'no'}`);
    lines.push('');
    lines.push(report.conventional_test.note);
    lines.push('');
  }

  lines.push('## Verdict limitations');
  lines.push('');
  for (const l of report.limitations) lines.push(`- ${l}`);
  lines.push('');

  lines.push('## Human adoption');
  lines.push('');
  lines.push(report.human_decision.note);
  lines.push('');

  return lines.join('\n');
}
