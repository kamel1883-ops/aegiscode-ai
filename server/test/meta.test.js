import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Store } from '../src/store.js';
import { Queue } from '../src/queue.js';
import { createApiServer } from '../src/api.js';
import { AccountStore } from '../src/accounts.js';
import { BudgetManager, APPROVED_LIMITS } from '../src/budget.js';
import { createMetaClient, stateFromEnv, META_STATES, MOCK_MARKER, ACCESS_NOTE_LIVE } from '../src/meta-client.js';
import { AdvisoryService, RESERVE_USD, STAGE_LIMITS, extractCandidate } from '../src/advisory.js';
import { PRICING, costUsd, estimateTokens } from '../src/meta-pricing.js';
import { demoScenario } from '../../core/test/helpers.js';
import { readFile as readFixture } from 'node:fs/promises';

/**
 * Meta advisory acceptance tests — offline only. No test here makes a real
 * network call: the live path is exercised with an injected fetch stub that
 * impersonates the provider, and every default server runs in mock mode.
 *
 * Covered:
 *  1. The four states — an API key alone never marks the integration as working.
 *  2. Mock mode never touches the network and always carries its marker.
 *  3. live_disabled refuses and NEVER falls back to mock output.
 *  4. The live path: request shape, input ceiling, single attempt, provider
 *     usage accounting, reconciliation, verified-flag persistence.
 *  5. The end-to-end advisory cycle through the real harness (mock client).
 *  6. Budget rejection is explicit; isolation holds for other users' advisories.
 */

const TOKEN = 'ac-meta-token-000';

const PATCH_REAL = await readFixture(
  path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'core', 'fixtures', 'patch-real', 'app.js'),
  'utf8',
);
const ORIGINAL = await readFixture(
  path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'core', 'fixtures', 'original', 'app.js'),
  'utf8',
);

/* ------------------------------------------------------------------ */
/* 1–4: the client                                                     */
/* ------------------------------------------------------------------ */

test('the four states: a key alone never marks the integration as connected', async () => {
  assert.equal(stateFromEnv({}), META_STATES.MOCK, 'default is mock');
  assert.equal(stateFromEnv({ META_MODE: 'live' }), META_STATES.LIVE_DISABLED, 'live without a key is disabled, not mock');
  assert.equal(stateFromEnv({ META_MODE: 'live', META_API_KEY: 'LLM_x' }), META_STATES.LIVE_CONFIGURED, 'a key is configured — not verified');
  assert.equal(stateFromEnv({ META_MODE: 'MOCK', META_API_KEY: 'LLM_x' }), META_STATES.MOCK, 'mock mode wins even with a key');

  // A configured key with a successful call becomes verified — persisted.
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-meta-flag-'));
  try {
    const fetchFn = async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const client = createMetaClient({ env: { META_MODE: 'live', META_API_KEY: 'LLM_x' }, fetchFn, dir });
    await client.ready();
    assert.equal(client.state, META_STATES.LIVE_CONFIGURED);
    await client.complete({ task: 'explain', system: 's', user: 'u', maxOutputTokens: 10, inputTokenCeiling: 100 });
    assert.equal(client.state, META_STATES.LIVE_VERIFIED);

    // A "restart": the verified flag survives.
    const restarted = createMetaClient({ env: { META_MODE: 'live', META_API_KEY: 'LLM_x' }, fetchFn, dir });
    await restarted.ready();
    assert.equal(restarted.state, META_STATES.LIVE_VERIFIED);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('mock mode: deterministic, marked output — and the network is never touched', async () => {
  let fetches = 0;
  const client = createMetaClient({
    env: {},
    fetchFn: async () => { fetches += 1; throw new Error('network must not be used'); },
  });
  await client.ready();
  assert.equal(client.state, META_STATES.MOCK);

  const result = await client.complete({
    task: 'explain',
    system: 's',
    user: 'u',
    maxOutputTokens: 800,
    inputTokenCeiling: 6000,
    mock: { scenarioId: 'demo', verdict: 'patch_supported', reason: 'because.' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'mock');
  assert.ok(result.text.startsWith(MOCK_MARKER), 'a mock output can never be mistaken for a real one');
  assert.equal(result.usage.estimated, true);
  assert.equal(fetches, 0, 'zero network calls in mock mode');

  const again = await client.complete({ task: 'explain', system: 's', user: 'u', maxOutputTokens: 800, inputTokenCeiling: 6000, mock: { scenarioId: 'demo', verdict: 'patch_supported', reason: 'because.' } });
  assert.equal(again.text, result.text, 'mock output is deterministic');
});

test('live_disabled: the call is refused and mock output is NEVER substituted', async () => {
  let fetches = 0;
  const client = createMetaClient({
    env: { META_MODE: 'live' },
    fetchFn: async () => { fetches += 1; return new Response('{}'); },
  });
  await client.ready();
  assert.equal(client.state, META_STATES.LIVE_DISABLED);

  const result = await client.complete({ task: 'explain', system: 's', user: 'u', maxOutputTokens: 800, inputTokenCeiling: 6000 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'live_disabled');
  assert.equal(result.text, undefined, 'no text at all — mock is not a fallback');
  assert.equal(fetches, 0);
});

test('the live path with a stubbed provider: request shape, ceilings, one attempt, honest failures', async () => {
  const calls = [];
  const fetchOk = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      choices: [{ message: { content: ' LIVE TEXT ' } }],
      usage: { prompt_tokens: 1234, completion_tokens: 321 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = createMetaClient({
    env: { META_MODE: 'live', META_API_KEY: 'LLM_test_key' },
    fetchFn: fetchOk,
  });
  await client.ready();

  const ok = await client.complete({ task: 'explain', system: 'sys', user: 'usr', maxOutputTokens: 800, inputTokenCeiling: 6000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.mode, 'live');
  assert.equal(ok.usage.prompt_tokens, 1234, 'provider-reported usage wins');

  const { url, init } = calls[0];
  assert.ok(url.startsWith('https://api.meta.ai/v1/chat/completions'), `unexpected url: ${url}`);
  assert.equal(init.headers.authorization, 'Bearer LLM_test_key');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'muse-spark-1.3');
  assert.equal(body.max_completion_tokens, 800, 'the output cap is an explicit request parameter');
  assert.equal(body.messages.length, 2);

  // Input ceiling: over it, the request is never made.
  const over = await client.complete({ task: 'patch', system: 's', user: 'x'.repeat(30_000), maxOutputTokens: 2500, inputTokenCeiling: 8000 });
  assert.equal(over.ok, false);
  assert.equal(over.error, 'input_ceiling_exceeded');
  assert.equal(calls.length, 1, 'no request above the ceiling');

  // Connection failure: reported, never retried, never converted to mock.
  let attempts = 0;
  const failing = createMetaClient({
    env: { META_MODE: 'live', META_API_KEY: 'LLM_x' },
    fetchFn: async () => { attempts += 1; throw new Error('ECONNREFUSED'); },
  });
  const failed = await failing.complete({ task: 'explain', system: 's', user: 'u', maxOutputTokens: 800, inputTokenCeiling: 6000 });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'connection_failed');
  assert.equal(failed.text, undefined);
  assert.equal(attempts, 1, 'exactly one attempt — no automatic retries');

  // HTTP 402 (the documented billing error): surfaced verbatim for review.
  const refused = createMetaClient({
    env: { META_MODE: 'live', META_API_KEY: 'LLM_x' },
    fetchFn: async () => new Response('insufficient balance or lapsed payment method', { status: 402 }),
  });
  const r = await refused.complete({ task: 'explain', system: 's', user: 'u', maxOutputTokens: 800, inputTokenCeiling: 6000 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'http_402');
});

test('the pricing table is the verified official one — costs are computed from it', () => {
  assert.equal(PRICING.model, 'muse-spark-1.3');
  assert.equal(PRICING.input_per_mtok, 1.25);
  assert.equal(PRICING.output_per_mtok, 4.25);
  assert.equal(PRICING.source, 'https://dev.meta.ai/docs/pricing-rate-limits');
  // The reservation envelope is exactly the sum of the stage ceilings:
  // inputs 6,000 + 8,000 + 5,000 = 19,000;
  // outputs 800 + 2,500 + 600 = 3,900.
  const inputTotal = STAGE_LIMITS.explain.inputTokenCeiling + STAGE_LIMITS.patch.inputTokenCeiling + STAGE_LIMITS.summarize.inputTokenCeiling;
  const outputTotal = STAGE_LIMITS.explain.maxOutputTokens + STAGE_LIMITS.patch.maxOutputTokens + STAGE_LIMITS.summarize.maxOutputTokens;
  assert.equal(inputTotal, 19_000);
  assert.equal(outputTotal, 3_900);
  const envelope = costUsd(inputTotal, outputTotal);
  assert.ok(Math.abs(envelope - 0.040325) < 1e-9, `got ${envelope}`);
  // The $0.05 reservation covers the whole envelope with a margin.
  assert.ok(envelope < RESERVE_USD, `envelope ${envelope} exceeds the $${RESERVE_USD} reservation`);
  // The conservative estimate never under-counts.
  assert.ok(estimateTokens('abcdefgh') >= 2);
});

test('extractCandidate: only a real fenced block is accepted', () => {
  assert.equal(extractCandidate('no block here'), null);
  assert.equal(extractCandidate('```js\n```'), null);
  assert.equal(extractCandidate('text\n```js\nconst a = 1;\n```\nmore'), 'const a = 1;');
});

/* ------------------------------------------------------------------ */
/* 5–6: the API, offline                                               */
/* ------------------------------------------------------------------ */

async function withServer(fn, { meta } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ac-meta-'));
  const store = new Store(dataDir);
  await store.init();
  const accounts = new AccountStore(dataDir);
  await accounts.init();
  const queue = new Queue(store);
  const advisory = meta ? meta({ store, queue, dataDir }) : null;
  const server = createApiServer({ store, queue, tokens: [TOKEN], accounts, meta: advisory ?? undefined });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const call = (method, p, body, token = TOKEN) =>
    fetch(`${base}${p}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

  // A registered user session — for ownership checks (a session is never a
  // system token: it sees only its own things).
  const register = async (username, password) => {
    await call('POST', '/api/auth/register', { username, password });
    const res = await call('POST', '/api/auth/login', { username, password });
    return (await res.json()).token;
  };

  try {
    await fn({ call, store, queue, accounts, register });
  } finally {
    await queue.drain().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function waitForJob(call, id, timeoutMs = 30_000) {
  const started = Date.now();
  for (;;) {
    const res = await call('GET', `/api/jobs/${id}`);
    const { job } = await res.json();
    if (['completed', 'failed', 'rejected'].includes(job.status)) return job;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for job ${id}: ${job.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('status endpoint: mock state, verified pricing, budget — and an accurate access note', async () => {
  await withServer(async ({ call }) => {
    const res = await call('GET', '/api/meta/status');
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.equal(s.state, 'mock');
    assert.equal(s.model, 'muse-spark-1.3');
    assert.equal(s.powered_by_meta, false, 'mock mode never claims a live integration');
    assert.ok(!s.access_note.includes('tested'), 'mock note, not the live-access note');
    assert.equal(s.pricing.source, PRICING.source);
    assert.equal(s.budget.approved_total_usd, APPROVED_LIMITS.total_usd);
    assert.equal(s.budget.used_total_usd, 0);
    assert.equal(s.reserve_usd, RESERVE_USD);
  });
});

test('the live-disabled API refuses an advisory — no mock fallback, no spend', async () => {
  await withServer(async ({ call }) => {
    const submit = await call('POST', '/api/jobs', {
      scenario: demoScenario(),
      original: { 'app.js': ORIGINAL },
      patched: { 'app.js': PATCH_REAL },
    });
    const { id } = await submit.json();
    await waitForJob(call, id);

    const res = await call('POST', '/api/meta/advisory', {
      source_job_id: id,
      scenario: demoScenario(),
      original: { 'app.js': ORIGINAL },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'live_disabled');
    assert.ok(!JSON.stringify(body).includes(MOCK_MARKER), 'no mock output anywhere in the refusal');
  }, {
    meta: ({ store, queue, dataDir }) => new AdvisoryService({
      store,
      queue,
      budget: new BudgetManager(dataDir),
      client: createMetaClient({ env: { META_MODE: 'live' }, fetchFn: async () => { throw new Error('must not be called'); } }),
    }),
  });
});

test('end-to-end mock advisory: explain → candidate → the real harness → summarize', async () => {
  await withServer(async ({ call, register }) => {
    const scenario = demoScenario();
    const submit = await call('POST', '/api/jobs', {
      scenario,
      original: { 'app.js': ORIGINAL },
      patched: { 'app.js': PATCH_REAL },
    });
    const { id } = await submit.json();
    const source = await waitForJob(call, id);
    assert.equal(source.verdict, 'patch_supported');

    // Stage A+B+C: one POST, mock model, the candidate goes to the REAL harness.
    const start = await call('POST', '/api/meta/advisory', {
      source_job_id: id,
      scenario,
      original: { 'app.js': ORIGINAL },
    });
    assert.equal(start.status, 202);
    const { advisory } = await start.json();
    assert.equal(advisory.mode, 'mock');
    assert.equal(advisory.status, 'tested');
    assert.ok(advisory.explanation.startsWith(MOCK_MARKER));
    assert.ok(advisory.candidate.code.includes('mock candidate'), 'the mock candidate is honestly cosmetic');
    assert.ok(!advisory.candidate.applied, 'nothing is ever applied');

    // The verification is a normal job — real isolation, real matrix.
    const verified = await waitForJob(call, advisory.verification_job_id);
    assert.equal(verified.status, 'completed');
    // A cosmetic mock patch cannot pass a causal test: the flaw recurs.
    assert.equal(verified.verdict, 'environment_masked');

    // Stage D: summarize from the harness facts.
    const summary = await call('POST', `/api/meta/advisory/${advisory.id}/summarize`);
    assert.equal(summary.status, 200);
    const done = (await summary.json()).advisory;
    assert.equal(done.status, 'completed', 'a decisive negative verdict is simply tested, not verified');
    assert.ok(done.summary.text.startsWith(MOCK_MARKER));
    assert.equal(done.verification.verdict, 'environment_masked', 'the chip state comes from the harness, never the model');

    // Accounting: three mock calls, zero cost, zero budget movement.
    assert.equal(done.usage.calls.length, 3);
    assert.ok(done.usage.calls.every((c) => c.mode === 'mock'));
    assert.equal(done.usage.total_cost_usd, 0);
    assert.equal(done.usage.reserved_usd, 0, 'mock cycles reserve nothing');

    const status = (await (await call('GET', '/api/meta/status')).json());
    assert.equal(status.budget.used_total_usd, 0, 'mock mode spends nothing');

    // The same advisory cannot be started twice for one job.
    const again = await call('POST', '/api/meta/advisory', { source_job_id: id, scenario, original: { 'app.js': ORIGINAL } });
    assert.equal(again.status, 409);

    // Isolation: another user sees nothing.
    const bobToken = await register('bob', 'bob-pass-123');
    const foreign = await call('GET', `/api/meta/advisory/${advisory.id}`, undefined, bobToken);
    assert.equal(foreign.status, 404, 'someone else’s advisory does not exist for another user');
  });
});

test('the live accounting path (stubbed provider): reservation, provider usage, reconciliation', async () => {
  const fetchStub = async (url, init) => {
    const body = JSON.parse(init.body);
    const isPatch = body.messages[1].content.includes('fenced JavaScript code block');
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: isPatch
            ? `Here is the candidate:\n\`\`\`js\n${PATCH_REAL}\n\`\`\``
            : 'An explanation of the verified finding, from the stubbed provider.',
        },
      }],
      usage: { prompt_tokens: 2000, completion_tokens: 500 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  await withServer(async ({ call }) => {
    const scenario = demoScenario();
    const submit = await call('POST', '/api/jobs', {
      scenario,
      original: { 'app.js': ORIGINAL },
      patched: { 'app.js': PATCH_REAL },
    });
    const { id } = await submit.json();
    await waitForJob(call, id);

    const start = await call('POST', '/api/meta/advisory', {
      source_job_id: id,
      scenario,
      original: { 'app.js': ORIGINAL },
    });
    assert.equal(start.status, 202);
    const { advisory } = await start.json();
    assert.equal(advisory.mode, META_STATES.LIVE_CONFIGURED, 'a configured key is not yet a verified connection');
    assert.equal(advisory.usage.reserved_usd, RESERVE_USD, 'the conservative reservation was taken before the calls');

    // The budget shows the reservation while the cycle is open.
    const mid = (await (await call('GET', '/api/meta/status')).json()).budget;
    assert.equal(mid.used_total_usd, RESERVE_USD);
    assert.equal(mid.active_live_jobs, 1, 'one active live job at a time');
    const powered = (await (await call('GET', '/api/meta/status')).json());
    assert.equal(powered.powered_by_meta, true, 'live integration — the badge is now truthful');
    assert.equal(powered.access_note, ACCESS_NOTE_LIVE);

    const verified = await waitForJob(call, advisory.verification_job_id);
    assert.equal(verified.verdict, 'patch_supported', 'the stubbed candidate is the real patch');

    const summary = await call('POST', `/api/meta/advisory/${advisory.id}/summarize`);
    assert.equal(summary.status, 200);
    const done = (await summary.json()).advisory;
    assert.equal(done.status, 'verified');
    assert.equal(done.usage.calls.length, 3);
    assert.ok(done.usage.calls.every((c) => c.mode === 'live'), 'each call records its real mode');

    // Provider-reported usage priced from the verified table: 3 × (2000 in + 500 out).
    // That is 6,000 in + 1,500 out = 0.0075 + 0.006375 = $0.013875 — the
    // observed-usage accounting, distinct from the $0.040325 ceiling envelope
    // above. The $0.05 reservation covers both; the two numbers must not be
    // equated with each other.
    const expected = 3 * costUsd(2000, 500);
    assert.ok(Math.abs(expected - 0.013875) < 1e-12, `got ${expected}`);
    assert.ok(Math.abs(done.usage.total_cost_usd - expected) < 1e-9, `got ${done.usage.total_cost_usd}, expected ${expected}`);
    assert.ok(Math.abs(done.usage.actual_usd - expected) < 1e-9, 'the reservation is reconciled to the provider-reported usage');
    assert.ok(done.usage.estimated === false, 'live usage is provider-reported');

    const after = (await (await call('GET', '/api/meta/status')).json()).budget;
    assert.equal(after.active_live_jobs, 0, 'the live slot is free after reconciliation');
    assert.ok(Math.abs(after.used_total_usd - expected) < 1e-9);
  }, {
    meta: ({ store, queue, dataDir }) => new AdvisoryService({
      store,
      queue,
      budget: new BudgetManager(dataDir),
      client: createMetaClient({ env: { META_MODE: 'live', META_API_KEY: 'LLM_stub' }, fetchFn: fetchStub }),
    }),
  });
});

test('budget exhaustion blocks a live advisory with an explicit code — the call is never made', async () => {
  const fetchStub = async () => { throw new Error('the provider must not be called'); };
  await withServer(async ({ call }) => {
    const scenario = demoScenario();
    const submit = await call('POST', '/api/jobs', {
      scenario,
      original: { 'app.js': ORIGINAL },
      patched: { 'app.js': PATCH_REAL },
    });
    const { id } = await submit.json();
    await waitForJob(call, id);

    const res = await call('POST', '/api/meta/advisory', {
      source_job_id: id,
      scenario,
      original: { 'app.js': ORIGINAL },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'daily_budget_exhausted');
  }, {
    meta: ({ store, queue, dataDir }) => new AdvisoryService({
      store,
      queue,
      budget: new BudgetManager(dataDir, { limits: { ...APPROVED_LIMITS, daily_usd: 0.01 } }),
      client: createMetaClient({ env: { META_MODE: 'live', META_API_KEY: 'LLM_stub' }, fetchFn: fetchStub }),
    }),
  });
});

test('the persisted budget file is auditable after a live cycle', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-meta-audit-'));
  try {
    const budget = new BudgetManager(dir);
    await budget.init();
    await budget.reserve({ jobKey: 'adv-audit', amountUsd: RESERVE_USD, live: true });
    await budget.reconcile({ jobKey: 'adv-audit', actualUsd: 0.040325 });
    const raw = JSON.parse(await readFile(path.join(dir, 'meta-budget.json'), 'utf8'));
    assert.equal(raw.entries[0].job_key, 'adv-audit');
    assert.equal(raw.entries[0].live, true);
    assert.equal(raw.entries[0].actual_usd, 0.040325);
    assert.ok(raw.entries[0].created_at && raw.entries[0].reconciled_at);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
