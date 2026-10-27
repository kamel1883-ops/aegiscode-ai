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
  await loadMetaStatus();
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

  // Remember the submission so the advisory can reuse exactly the same source
  // code — the server never stores uploaded code.
  const submitted = {
    scenario: {
      id: $('scenario-id').value.trim(),
      unsafe_event: $('unsafe-event').value.trim(),
      legitimate_behavior_checks: [$('legit-check').value.trim()],
      baseline_environment: { description: 'Baseline: no network resource available', network: 'loopback-only' },
      permitted_interventions: [{ kind: 'synthetic_resource', name: 'template-endpoint' }],
      synthetic_resource_profile: { kind: 'loopback_http', path: '/template', status: 200, body: 'AC-RESOURCE-MARKER' },
      intervention_validity_checks: { min_probes: 1, expect_status: 200, expect_body_contains: 'AC-PROBE-OK' },
      resource_limits: { timeout_ms: 5000, max_memory_mb: 128, max_output_bytes: 16384 },
      maximum_attempts: 2,
    },
    original: { 'app.js': $('original-code').value },
  };
  sessionStorage.setItem(`ac_src_${data.id}`, JSON.stringify(submitted));

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
  list.replaceChildren();

  if (!data?.jobs?.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No jobs yet — submit a new one.';
    list.append(empty);
    return;
  }

  for (const job of data.jobs) {
    // Built with textContent — never with innerHTML: the values come from the
    // server and are treated as untrusted, exactly like the subject code.
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'job';
    const id = document.createElement('span');
    id.className = 'id';
    id.textContent = job.id;
    const badge = document.createElement('span');
    const label = job.verdict && job.status === 'completed'
      ? (VERDICT_LABELS[job.verdict] ?? job.verdict).split('—')[0].trim()
      : (STATUS_LABELS[job.status] ?? job.status);
    badge.className = `badge ${job.status}`;
    badge.textContent = label;
    el.append(id, badge);
    el.addEventListener('click', () => {
      if (job.status === 'completed') openReport(job.id);
    });
    list.append(el);
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

  // The four-condition matrix — cells are built with textContent, never with
  // innerHTML, so nothing server-sourced is ever interpreted as markup.
  const tbody = $('matrix').querySelector('tbody');
  tbody.replaceChildren();
  const rows = [
    ['Original version S', 'A', 'B'],
    ['Patched version P', 'C', 'D'],
  ];
  const byKey = Object.fromEntries(report.conditions.map((c) => [c.condition, c]));

  for (const [label, baseKey, subKey] of rows) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = label;
    tr.append(th);
    for (const key of [baseKey, subKey]) {
      const td = document.createElement('td');
      const c = byKey[key];
      if (!c || c.observation.status !== 'completed') {
        td.className = 'na';
        td.textContent = c ? (STATUS_LABELS[c.observation.status] ?? c.observation.status) : '—';
      } else {
        const recurred = c.observation.unsafe_event_recurred;
        td.className = recurred ? 'recurred' : 'clean';
        td.textContent = recurred ? 'vulnerability recurred' : 'does not recur';
      }
      tr.append(td);
    }
    tbody.append(tr);
  }

  $('report-reason').textContent = report.reason;
  const limits = $('report-limits');
  limits.replaceChildren();
  for (const l of report.limitations ?? []) {
    const li = document.createElement('li');
    li.textContent = l;
    limits.appendChild(li);
  }

  const conv = $('conventional');
  if (report.conventional_test) {
    const t = report.conventional_test;
    const strong = document.createElement('strong');
    const rest = t.misleading
      ? ` it would have declared "${t.would_report === 'success' ? 'success' : 'failure'}" while the causal verdict is: ${VERDICT_LABELS[report.verdict].split('—')[0].trim()}.`
      : ' no false result in this case.';
    strong.textContent = t.misleading ? 'The conventional test was misleading:' : 'The conventional test:';
    conv.replaceChildren(strong, document.createTextNode(rest));
    conv.classList.remove('hidden');
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

  // The Meta advisory panel: status + any existing cycle for this job.
  await loadAdvisory(id);
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

/* ---------------- The Meta advisory panel ---------------- */

const ADVISORY_STATES = {
  mock: { label: 'MOCK', cls: 'mock' },
  live_disabled: { label: 'LIVE DISABLED', cls: 'live_disabled' },
  live_configured: { label: 'LIVE CONFIGURED', cls: 'live_configured' },
  live_verified: { label: 'LIVE CONNECTED', cls: 'live_verified' },
};

const ADVISORY_CHIPS = {
  generated: 'Generated',
  tested: 'Tested',
  verified: 'Verified',
  inconclusive: 'Inconclusive',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

let metaStatus = null;
let currentAdvisory = null;
let advisorySourceJobId = null;
let advisoryPollTimer = null;

async function loadMetaStatus() {
  const { status, data } = await api.call('GET', '/api/meta/status');
  metaStatus = status === 200 ? data : null;
  renderMetaHeader();
}

function renderMetaHeader() {
  const chip = $('meta-state-chip');
  if (!metaStatus) {
    chip.textContent = 'unavailable';
    chip.className = 'state-chip';
    return;
  }
  const s = ADVISORY_STATES[metaStatus.state] ?? { label: metaStatus.state, cls: '' };
  chip.textContent = s.label;
  chip.className = `state-chip ${s.cls}`;
  // “Powered by Meta Model API” is shown only for a genuine live integration.
  $('meta-powered').classList.toggle('hidden', !metaStatus.powered_by_meta);
  $('meta-model').textContent = `model: ${metaStatus.model}`;
  $('meta-note').textContent = metaStatus.access_note ?? '';
}

function advisorySourceFor(jobId) {
  const raw = sessionStorage.getItem(`ac_src_${jobId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function loadAdvisory(jobId) {
  advisorySourceJobId = jobId;
  clearInterval(advisoryPollTimer);
  currentAdvisory = null;
  if (!metaStatus) await loadMetaStatus();

  const { status, data } = await api.call('GET', `/api/meta/advisory/${jobId}`);
  currentAdvisory = status === 200 ? data.advisory : null;

  if (!currentAdvisory) {
    $('advisory-body').classList.add('hidden');
    $('advisory-summarize').classList.add('hidden');
    $('advisory-cancel').classList.add('hidden');
    $('advisory-start').classList.remove('hidden');
    const haveSource = advisorySourceFor(jobId) !== null;
    $('advisory-start').disabled = !haveSource || metaStatus?.state === 'live_disabled';
    $('advisory-hint').textContent = metaStatus?.state === 'live_disabled'
      ? 'Live mode is configured without credentials — the advisory refuses to run and never falls back to mock output.'
      : haveSource
        ? 'One cycle runs three model calls at most: explain, propose, summarize. The candidate is tested by our harness — the model never decides the verdict.'
        : 'The original code for this job is not in this session — load the demo (or paste the original code) and submit it again to enable the advisory.';
    return;
  }
  renderAdvisory();
}

function renderAdvisory() {
  const a = currentAdvisory;
  if (!a) return;

  $('advisory-start').classList.add('hidden');
  $('advisory-body').classList.remove('hidden');

  // The pipeline chips — the final chip always comes from the harness verdict.
  const chips = $('advisory-chips');
  chips.replaceChildren();
  const flow = a.status === 'failed' ? ['failed']
    : a.status === 'cancelled' ? ['cancelled']
      : a.status === 'verified' ? ['generated', 'tested', 'verified']
        : a.status === 'inconclusive' ? ['generated', 'tested', 'inconclusive']
          : ['generated', 'tested']; // tested | completed (a decisive negative verdict)
  for (const key of flow) {
    const span = document.createElement('span');
    span.className = `pipe-chip ${key}`;
    span.textContent = ADVISORY_CHIPS[key];
    chips.append(span);
  }
  const mode = document.createElement('span');
  mode.className = `pipe-chip mode ${a.mode === 'mock' ? 'mock' : 'live'}`;
  mode.textContent = a.mode === 'mock' ? 'mock output' : 'live model output';
  chips.append(mode);

  $('advisory-explanation').textContent = a.explanation ?? '';
  $('advisory-candidate').textContent = a.candidate ? a.candidate.code : '';

  const ver = a.verification;
  $('advisory-verification').textContent = ver
    ? `Harness verdict: ${ver.verdict} — ${ver.reason}`
    : (a.verification_job_id
      ? `Verification job ${a.verification_job_id} was submitted to the harness — waiting for the verdict…`
      : '');

  $('advisory-summary').textContent = a.summary ? a.summary.text : '';

  // Usage and cost: every call, with its mode and whether it is estimated.
  const usage = $('advisory-usage');
  usage.replaceChildren();
  for (const c of a.usage.calls) {
    const li = document.createElement('li');
    const tokens = c.prompt_tokens !== null && c.completion_tokens !== null
      ? `${c.prompt_tokens.toLocaleString()} in / ${c.completion_tokens.toLocaleString()} out`
      : 'usage not reported';
    li.textContent = `${c.stage} · ${c.mode} · ${tokens} · ${c.estimated ? 'est. ' : ''}$${(c.cost_usd ?? 0).toFixed(4)}`;
    usage.append(li);
  }
  $('advisory-budget').textContent =
    `Cycle: reserved $${a.usage.reserved_usd.toFixed(2)}` +
    (a.usage.actual_usd !== null ? `, reconciled at $${a.usage.actual_usd.toFixed(4)} (estimated until provider billing confirms)` : '') +
    (metaStatus?.budget
      ? ` — approved budget remaining: $${metaStatus.budget.remaining_total_usd.toFixed(2)} of $${metaStatus.budget.approved_total_usd}`
      : '');

  // Actions: summarize after the harness finishes; cancel only mid-cycle.
  $('advisory-summarize').classList.toggle('hidden', a.status !== 'tested');
  $('advisory-cancel').classList.toggle('hidden', !['generated', 'tested'].includes(a.status));
  $('advisory-hint').textContent = a.status === 'tested'
    ? 'The harness verdict is in — let the model summarize it. The summary never changes the verdict or the evidence.'
    : ['verified', 'inconclusive', 'completed'].includes(a.status)
      ? 'The cycle is complete. Adoption remains your decision below.'
      : '';

  // Poll the verification job (our own API — no model calls in this loop).
  if (a.verification_job_id && !a.verification) {
    clearInterval(advisoryPollTimer);
    advisoryPollTimer = setInterval(async () => {
      const { status, data } = await api.call('GET', `/api/jobs/${a.verification_job_id}`);
      if (!data?.job) return;
      if (['completed', 'failed', 'rejected'].includes(data.job.status)) {
        clearInterval(advisoryPollTimer);
        if (data.job.status === 'completed') {
          $('advisory-verification').textContent = `Harness verdict: ${data.job.verdict} — ${data.job.reason}`;
          await loadMetaStatus();
        } else {
          $('advisory-verification').textContent = `The harness refused the candidate — job status: ${data.job.status}.`;
        }
        await refreshJobs();
      }
    }, 900);
  }
}

$('advisory-start').addEventListener('click', async () => {
  $('advisory-hint').textContent = '';
  const source = advisorySourceFor(advisorySourceJobId);
  if (!source) {
    $('advisory-hint').textContent = 'The original code for this job is not in this session — submit it again to enable the advisory.';
    return;
  }
  $('advisory-start').disabled = true;
  const { status, data } = await api.call('POST', '/api/meta/advisory', {
    source_job_id: advisorySourceJobId,
    scenario: source.scenario,
    original: source.original,
  });
  if (status !== 202) {
    $('advisory-hint').textContent = data?.error ?? 'The advisory was rejected.';
    $('advisory-start').disabled = false;
    return;
  }
  currentAdvisory = data.advisory;
  renderAdvisory();
  await loadMetaStatus();
});

$('advisory-summarize').addEventListener('click', async () => {
  if (!currentAdvisory) return;
  $('advisory-summarize').disabled = true;
  const { status, data } = await api.call('POST', `/api/meta/advisory/${currentAdvisory.id}/summarize`);
  $('advisory-summarize').disabled = false;
  if (status !== 200) {
    $('advisory-hint').textContent = data?.error ?? 'Could not summarize.';
    return;
  }
  currentAdvisory = data.advisory;
  renderAdvisory();
  await loadMetaStatus();
});

$('advisory-cancel').addEventListener('click', async () => {
  if (!currentAdvisory) return;
  const { status, data } = await api.call('POST', `/api/meta/advisory/${currentAdvisory.id}/cancel`);
  if (status !== 200) {
    $('advisory-hint').textContent = data?.error ?? 'Could not cancel.';
    return;
  }
  currentAdvisory = null;
  $('advisory-body').classList.add('hidden');
  $('advisory-start').classList.remove('hidden');
  $('advisory-start').disabled = false;
  $('advisory-hint').textContent = 'The cycle was cancelled and its reservation was released.';
  await loadMetaStatus();
});

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
