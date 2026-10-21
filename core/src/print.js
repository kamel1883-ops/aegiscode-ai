/**
 * AegisCode — printable report page (Phase Five)
 *
 * Why printable HTML and not PDF directly? Generating a correct PDF requires a
 * font library and external dependencies — and this system commits to zero
 * dependencies. Therefore:
 *  - The signed source is `report.json` (data),
 *  - This page is generated from it, LTR, with print-ready styles,
 *  - Opening it in any browser and using "Print → Save as PDF" produces a clean
 *    document that follows the bundle signature: the signature covers
 *    report.json, from which this page was produced.
 *
 * The page is self-carrying: the key fingerprint, the bundle name, and the
 * command that verifies it.
 */

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
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
  return {
    A: 'Original × baseline (resource withheld)',
    B: 'Original × substituted synthetic resource (guaranteed)',
    C: 'Patched × baseline (resource withheld)',
    D: 'Patched × substituted synthetic resource (guaranteed)',
  }[key] ?? key;
}

const VERDICT_TONE = {
  patch_supported: '#0b7a3b',
  environment_masked: '#a8360a',
  interaction_dependent: '#8a6d00',
  inconclusive: '#555555',
};

/**
 * Builds a complete printable HTML page from a JSON report.
 *
 * @param {object} report core report (aegiscode.report/0.2)
 * @param {{keyId?:string, created?:string, bundleName?:string}} [meta]
 * @returns {string} fully HTML-escaped markup
 */
export function renderPrintHtml(report, { keyId = null, created = null, bundleName = null } = {}) {
  const tone = VERDICT_TONE[report.verdict] ?? '#333333';
  const lines = [];

  lines.push('<!doctype html>');
  lines.push('<html lang="en" dir="ltr">');
  lines.push('<head>');
  lines.push('<meta charset="utf-8">');
  lines.push(`<meta name="viewport" content="width=device-width, initial-scale=1">`);
  lines.push(`<title>Causal verification report — ${esc(report.scenario?.id ?? '')}</title>`);
  lines.push(`<style>
  :root { --tone: ${tone}; }
  * { box-sizing: border-box; }
  body {
    font-family: "Segoe UI", Tahoma, Arial, sans-serif;
    margin: 2rem auto; max-width: 60rem; padding: 0 1rem; color: #1a1a1a;
    line-height: 1.6; background: #ffffff;
  }
  h1 { font-size: 1.6rem; margin-bottom: .2rem; }
  h2 { font-size: 1.15rem; margin-top: 2rem; border-bottom: 2px solid #e5e5e5; padding-bottom: .3rem; }
  .meta { color: #666; font-size: .9rem; }
  .verdict {
    border: 3px solid var(--tone); border-radius: 10px; padding: 1rem 1.2rem;
    margin: 1.2rem 0; page-break-inside: avoid;
  }
  .verdict .label { font-size: 1.5rem; font-weight: 700; color: var(--tone); }
  table { border-collapse: collapse; width: 100%; margin: .8rem 0; font-size: .95rem; }
  th, td { border: 1px solid #d9d9d9; padding: .45rem .6rem; text-align: left; vertical-align: top; }
  th { background: #f5f5f5; }
  tr { page-break-inside: avoid; }
  ul { padding-left: 1.3rem; }
  code { background: #f2f2f2; padding: .05rem .3rem; border-radius: 4px; }
  .sign {
    border: 1px dashed #999; border-radius: 8px; padding: .8rem 1rem;
    margin-top: 2rem; font-size: .9rem; background: #fbfbfb; page-break-inside: avoid;
  }
  .sig-value { word-break: break-all; display: block; margin-top: .3rem; }
  footer { margin-top: 2.5rem; color: #777; font-size: .85rem; border-top: 1px solid #eee; padding-top: .6rem; }
  @media print {
    body { margin: 0; max-width: none; }
    h2 { page-break-after: avoid; }
    .sign { page-break-inside: avoid; }
    a[href]::after { content: ""; }
  }
</style>`);
  lines.push('</head>');
  lines.push('<body>');

  // ---- Header ----
  lines.push('<h1>Causal patch-efficacy verification report</h1>');
  lines.push(`<div class="meta">Scenario: <strong>${esc(report.scenario?.id ?? '—')}</strong> · Generated: ${esc(report.generated_at ?? '—')}</div>`);
  if (report.isolation) {
    lines.push(
      `<div class="meta">Network isolation: ${esc(report.isolation.network_namespace)}` +
        (report.isolation.fallback_reason ? ' — not active (reason documented in the report)' : '') +
        '</div>',
    );
  }
  lines.push('');

  // ---- Verdict ----
  lines.push('<div class="verdict">');
  lines.push(`<div class="label">${esc(verdictLabel(report.verdict))} <code>${esc(report.verdict)}</code></div>`);
  lines.push(`<p><strong>Reason:</strong> ${esc(report.reason)}</p>`);
  lines.push(`<p><strong>Reason code:</strong> <code>${esc(report.reason_code)}</code></p>`);
  lines.push('</div>');

  // ---- Matrix ----
  lines.push('<h2>Four-condition matrix</h2>');
  lines.push('<table><thead><tr><th>Condition</th><th>Configuration</th><th>Run status</th><th>Event recurred</th><th>Intervention valid</th><th>Attempts</th></tr></thead><tbody>');
  for (const c of report.conditions ?? []) {
    const o = c.observation ?? {};
    const recur = o.status === 'completed' ? (o.unsafe_event_recurred ? 'yes' : 'no') : '—';
    const valid = c.intervention ? (c.intervention.valid ? 'proven' : 'not proven') : 'n/a';
    lines.push(
      `<tr><td><strong>${esc(c.condition)}</strong></td><td>${esc(conditionLabel(c.condition))}</td>` +
        `<td><code>${esc(o.status)}</code></td><td>${esc(recur)}</td><td>${esc(valid)}</td><td>${esc(o.attempts)}</td></tr>`,
    );
  }
  lines.push('</tbody></table>');

  // ---- Evidence ----
  if (report.evidence?.recurrence) {
    const r = report.evidence.recurrence;
    lines.push('<h2>Evidence</h2>');
    lines.push(
      `<p>Unsafe-event recurrence: A = ${r.A ? 'yes' : 'no'} · B = ${r.B ? 'yes' : 'no'} · C = ${r.C ? 'yes' : 'no'} · D = ${r.D ? 'yes' : 'no'}` +
        ' — and the experimental variable is resource availability in B and D.</p>',
    );
  }

  // ---- Failure attribution ----
  const fa = report.failure_attribution ?? { environment_setup_failures: [], test_failures: [] };
  lines.push('<h2>Failure attribution</h2>');
  if (fa.environment_setup_failures.length === 0 && fa.test_failures.length === 0) {
    lines.push('<p>No attributed failures: all four conditions completed.</p>');
  } else {
    if (fa.environment_setup_failures.length > 0) {
      lines.push('<p><strong>Environment setup failures</strong> (a log separate from test failures):</p><ul>');
      for (const f of fa.environment_setup_failures) lines.push(`<li>Condition ${esc(f.condition)}: ${esc(f.detail)}</li>`);
      lines.push('</ul>');
    }
    if (fa.test_failures.length > 0) {
      lines.push('<p><strong>Test failures</strong> (a log separate from setup failures):</p><ul>');
      for (const f of fa.test_failures) lines.push(`<li>Condition ${esc(f.condition)}: ${esc(f.detail)}</li>`);
      lines.push('</ul>');
    }
  }

  // ---- Execution isolation ----
  lines.push('<h2>Execution isolation and workspaces</h2>');
  lines.push('<table><thead><tr><th>Condition</th><th>Agent</th><th>Subject</th><th>Workspace deleted</th></tr></thead><tbody>');
  for (const row of report.executor?.conditions ?? []) {
    lines.push(
      `<tr><td>${esc(row.condition)}</td><td>${esc(row.runner_pid ?? '—')}</td><td>${esc(row.subject_pid ?? '—')}</td>` +
        `<td>${row.workspace_deleted === true ? 'yes' : row.workspace_deleted === null ? '—' : '<strong>no</strong>'}</td></tr>`,
    );
  }
  lines.push('</tbody></table>');

  // ---- Conventional test ----
  if (report.conventional_test) {
    lines.push('<h2>Conventional-test comparison</h2>');
    lines.push(`<p><strong>Conventional test:</strong> ${esc(report.conventional_test.method)}</p>`);
    lines.push(
      `<p><strong>What it would have reported:</strong> ${report.conventional_test.would_report === 'success' ? 'success / safe' : 'failure / unsafe'} · ` +
        `<strong>Was it misleading?</strong> ${report.conventional_test.misleading ? '<strong>yes — false result</strong>' : 'no'}</p>`,
    );
    lines.push(`<p>${esc(report.conventional_test.note)}</p>`);
  }

  // ---- Limitations, then human adoption ----
  lines.push('<h2>Verdict limitations</h2><ul>');
  for (const l of report.limitations ?? []) lines.push(`<li>${esc(l)}</li>`);
  lines.push('</ul>');

  lines.push('<h2>Human adoption</h2>');
  lines.push(`<p>${esc(report.human_decision?.note ?? '')}</p>`);

  // ---- Bundle stamp ----
  lines.push('<div class="sign">');
  lines.push('<strong>Evidence-bundle stamp</strong>');
  lines.push('<ul>');
  if (bundleName) lines.push(`<li>Bundle name: <code>${esc(bundleName)}</code></li>`);
  if (created) lines.push(`<li>Created: ${esc(created)}</li>`);
  if (keyId) lines.push(`<li>Public-key fingerprint (SHA-256): <code>${esc(keyId)}</code></li>`);
  lines.push('<li>Algorithm: Ed25519 — the signature covers the manifest and every bundle file hash.</li>');
  lines.push('</ul>');
  lines.push(
    '<span>Verify (on any machine with Node ≥ 20): ' +
      '<code>node core/bin/aegiscode-evidence.js verify --bundle &lt;bundle-dir&gt;</code></span>',
  );
  lines.push(
    '<span class="sig-value">This page was generated from the signed report.json — any difference between the document and the signed data is resolved in favor of the data.</span>',
  );
  lines.push('</div>');

  lines.push(
    '<footer>AegisCode — Phase Five evidence bundle. The system emits the verdict and the evidence only; adoption is human and recorded in the server, and there is no auto-merge or repository modification.</footer>',
  );

  lines.push('</body>');
  lines.push('</html>');

  return `${lines.join('\n')}\n`;
}
