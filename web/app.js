/**
 * AegisCode AI — UI logic (Phase Three)
 *
 * The UI is a thin client: it talks to the API only, and never runs or
 * interprets the subject code — the code passes through the server to the core
 * and into a separate agent.
 *
 * The session token is stored in sessionStorage (cleared when the tab closes) —
 * not localStorage, so no login trace survives closing the browser.
 */

const api = {
  token: sessionStorage.getItem('ac_token') ?? null,

  async call(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON response */ }
    if (res.status === 401 && this.token) {
      this.token = null;
      sessionStorage.removeItem('ac_token');
      showAuth();
    }
    return { status: res.status, data };
  },

  setToken(token) {
    this.token = token;
    if (token) sessionStorage.setItem('ac_token', token);
    else sessionStorage.removeItem('ac_token');
  },
};

const $ = (id) => document.getElementById(id);

const VERDICT_LABELS = {
  patch_supported: 'Patch supported — the vulnerability did not recur even with the resource available',
  environment_masked: 'Environment masked — the success came from the environment, not the patch',
  interaction_dependent: 'Interaction dependent — the effect changes with the environment',
  inconclusive: 'Inconclusive — intervention validity or run completion could not be confirmed',
};

const STATUS_LABELS = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  rejected: 'Rejected',
};

/* ---------------- Screens ---------------- */

function showAuth() {
  $('auth-view').classList.remove('hidden');
  $('app-view').classList.add('hidden');
  $('user-box').classList.add('hidden');
}

async function showApp(username) {
  $('auth-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  $('user-box').classList.remove('hidden');
  $('who').textContent = username ? `Welcome, ${username}` : 'System token';
  await refreshJobs();
}

/* ---------------- Login ---------------- */

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  const { status, data } = await api.call('POST', '/api/auth/login', {
    username: $('auth-username').value.trim(),
    password: $('auth-password').value,
  });
  if (status !== 200) {
    $('auth-error').textContent = data?.error ?? 'Could not sign in.';
    return;
  }
  api.setToken(data.token);
  await showApp(data.username);
});

$('register-btn').addEventListener('click', async () => {
  $('auth-error').textContent = '';
  const username = $('auth-username').value.trim();
  const password = $('auth-password').value;
  // Early client-side validation with explicit messages — before any server
  // call, so the raw server messages never show for an empty press or an
  // invalid name.
  if (!username || !password) {
    $('auth-error').textContent = 'Type your username (letters only) and password (8+ characters) first — then press "Create account".';
    return;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/.test(username)) {
    $('auth-error').textContent = 'Username: 3–32 characters, letters, digits and " _ - ." only, starting with a letter or digit. Example: nour-co';
    return;
  }
  if (password.length < 8) {
    $('auth-error').textContent = 'Password: at least 8 characters.';
    return;
  }
  const { status, data } = await api.call('POST', '/api/auth/register', {
    username,
    password,
  });
  if (status !== 201) {
    $('auth-error').textContent = data?.error ?? 'Could not create the account.';
    return;
  }
  // After registration we sign in directly.
  $('auth-form').dispatchEvent(new Event('submit'));
});

$('logout-btn').addEventListener('click', async () => {
  await api.call('POST', '/api/auth/logout');
  api.setToken(null);
  showAuth();
});

/* ---------------- Jobs ---------------- */

const DEMO_ORIGINAL = `'use strict';
// The original version: fetches a template from an external resource without
// validation — a vulnerability.
if (process.argv[2] !== 'serve') { process.exit(2); }
console.log('AC::LEGITIMATE_OK');
const url = process.env.AC_RESOURCE_URL;
if (!url) { console.log('AC::NO_RESOURCE'); process.exit(0); }
fetch(url + '/template').then(r => r.text()).then(body => {
  if (body.includes('AC-RESOURCE-MARKER')) console.log('AC::UNSAFE_EVENT');
  process.exit(0);
}).catch(() => process.exit(3));
`;

const DEMO_PATCHED = `'use strict';
// The real patch: the template source is local-only — no network request at all.
if (process.argv[2] !== 'serve') { process.exit(2); }
console.log('AC::LEGITIMATE_OK');
const template = { layout: 'default', content: 'Hello, world' };
if (!template.content) { process.exit(4); }
console.log('AC::TEMPLATE_RENDERED');
process.exit(0);
`;

$('load-demo').addEventListener('click', () => {
  $('scenario-id').value = 'demo-template-fetch';
  $('unsafe-event').value = 'AC::UNSAFE_EVENT';
  $('legit-check').value = 'AC::LEGITIMATE_OK';
  $('original-code').value = DEMO_ORIGINAL;
  $('patched-code').value = DEMO_PATCHED;
  $('job-error').textContent = '';
});

$('job-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('job-error').textContent = '';

  const scenario = {
    id: $('scenario-id').value.trim(),
    unsafe_event: $('unsafe-event').value.trim(),
    legitimate_behavior_checks: [$('legit-check').value.trim()],
    baseline_environment: { description: 'Baseline: no network resource available', network: 'loopback-only' },
    permitted_interventions: [{ kind: 'synthetic_resource', name: 'template-endpoint' }],
    synthetic_resource_profile: { kind: 'loopback_http', path: '/template', status: 200, body: 'AC-RESOURCE-MARKER' },
    intervention_validity_checks: { min_probes: 1, expect_status: 200, expect_body_contains: 'AC-PROBE-OK' },
    resource_limits: { timeout_ms: 5000, max_memory_mb: 128, max_output_bytes: 16384 },
    maximum_attempts: 2,
  };

  const { status, data } = await api.call('POST', '/api/jobs', {
    scenario,
    original: { 'app.js': $('original-code').value },
    patched: { 'app.js': $('patched-code').value },
  });

  if (status !== 202) {
    $('job-error').textContent = data?.details?.join(' · ') ?? data?.error ?? 'Could not submit the job.';
    return;
  }

  $('original-code').value = '';
  $('patched-code').value = '';
  await refreshJobs();
  watchJob(data.id);
});

let pollTimer = null;

function watchJob(id) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const { data } = await api.call('GET', `/api/jobs/${id}`);
    if (!data?.job) return;
    if (['completed', 'failed', 'rejected'].includes(data.job.status)) {
      clearInterval(pollTimer);
      await refreshJobs();
      if (data.job.status === 'completed') openReport(id);
    }
  }, 700);
}

async function refreshJobs() {
  const { data } = await api.call('GET', '/api/jobs');
  const list = $('jobs-list');
  list.innerHTML = '';

  if (!data?.jobs?.length) {
    list.innerHTML = '<p class="empty">No jobs yet — submit a new one.</p>';
    return;
  }

  for (const job of data.jobs) {
    const el = document.createElement('div');
    el.className = 'job';
    const label = job.verdict && job.status === 'completed'
      ? (VERDICT_LABELS[job.verdict] ?? job.verdict).split('—')[0].trim()
      : (STATUS_LABELS[job.status] ?? job.status);
    el.innerHTML = `<span class="id">${job.id}</span><span class="badge ${job.status}">${label}</span>`;
    el.addEventListener('click', () => {
      if (job.status === 'completed') openReport(job.id);
    });
    list.appendChild(el);
  }
}

/* ---------------- The report ---------------- */

let currentJobId = null;

async function openReport(id) {
  const { status, data } = await api.call('GET', `/api/jobs/${id}/report.json`);
  if (status !== 200) return;

  currentJobId = id;
  const report = data.report;

  $('report-card').classList.remove('hidden');
  $('report-id').textContent = id;
  $('report-md-link').href = `/api/jobs/${id}/report.md`;
  // The download link needs the token — we rely on the browser keeping the
  // session via fetch only, so we fetch the Markdown report and open it as a
  // data window.
  $('report-md-link').onclick = async (e) => {
    e.preventDefault();
    const res = await fetch(`/api/jobs/${id}/report.md`, {
      headers: { authorization: `Bearer ${api.token}` },
    });
    const text = await res.text();
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    window.open(URL.createObjectURL(blob), '_blank', 'noopener');
  };

  const banner = $('verdict-banner');
  banner.className = `verdict ${report.verdict}`;
  banner.textContent = VERDICT_LABELS[report.verdict] ?? report.verdict;

  // The four-condition matrix.
  const tbody = $('matrix').querySelector('tbody');
  tbody.innerHTML = '';
  const rows = [
    ['Original version S', 'A', 'B'],
    ['Patched version P', 'C', 'D'],
  ];
  const byKey = Object.fromEntries(report.conditions.map((c) => [c.condition, c]));

  for (const [label, baseKey, subKey] of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<th>${label}</th>${[baseKey, subKey].map((key) => {
      const c = byKey[key];
      if (!c || c.observation.status !== 'completed') {
        return `<td class="na">${c ? (STATUS_LABELS[c.observation.status] ?? c.observation.status) : '—'}</td>`;
      }
      const recurred = c.observation.unsafe_event_recurred;
      return `<td class="${recurred ? 'recurred' : 'clean'}">${recurred ? 'vulnerability recurred' : 'does not recur'}</td>`;
    }).join('')}</tr>`;
    tbody.appendChild(tr);
  }

  $('report-reason').textContent = report.reason;
  const limits = $('report-limits');
  limits.innerHTML = '';
  for (const l of report.limitations ?? []) {
    const li = document.createElement('li');
    li.textContent = l;
    limits.appendChild(li);
  }

  const conv = $('conventional');
  if (report.conventional_test) {
    const t = report.conventional_test;
    conv.classList.remove('hidden');
    conv.innerHTML = t.misleading
      ? `<strong>The conventional test was misleading:</strong> it would have declared "${t.would_report === 'success' ? 'success' : 'failure'}" while the causal verdict is: ${VERDICT_LABELS[report.verdict].split('—')[0].trim()}.`
      : '<strong>The conventional test:</strong> no false result in this case.';
  } else {
    conv.classList.add('hidden');
  }

  // Adoption state.
  const decision = report.human_decision;
  const decisionRow = $('decision-row');
  const reasonWrap = $('decision-reason-wrap');
  const result = $('decision-result');
  if (decision.status === 'pending') {
    decisionRow.classList.remove('hidden');
    result.textContent = '';
    $('approve-btn').onclick = () => decide('approved');
    $('reject-btn').onclick = () => decide('rejected');
  } else {
    decisionRow.classList.add('hidden');
    reasonWrap.classList.add('hidden');
    result.textContent = `Recorded decision: ${decision.status === 'approved' ? 'approve' : 'reject'} — ${decision.decided_by} · ${decision.reason}`;
  }

  $('report-card').scrollIntoView({ behavior: 'smooth' });
}

async function decide(decision) {
  const reason = $('decision-reason').value.trim();
  if (!reason) {
    $('decision-reason-wrap').classList.remove('hidden');
    $('decision-result').textContent = 'The decision reason is mandatory.';
    return;
  }
  const { status, data } = await api.call('POST', `/api/jobs/${currentJobId}/decision`, {
    decision,
    reason,
  });
  if (status !== 200) {
    $('decision-result').textContent = data?.error ?? 'Could not record the decision.';
    return;
  }
  $('decision-reason').value = '';
  $('decision-reason-wrap').classList.add('hidden');
  $('decision-result').textContent = `Decision recorded: ${decision} — by ${data.decision.decided_by}.`;
  $('decision-row').classList.add('hidden');
  await refreshJobs();
}

/* ---------------- Boot ---------------- */

(async () => {
  if (!api.token) {
    showAuth();
    return;
  }
  const { status, data } = await api.call('GET', '/api/auth/me');
  if (status !== 200) {
    showAuth();
    return;
  }
  await showApp(data.username);
})();
