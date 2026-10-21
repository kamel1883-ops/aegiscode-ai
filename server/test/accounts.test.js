import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Store } from '../src/store.js';
import { Queue } from '../src/queue.js';
import { createApiServer } from '../src/api.js';
import { AccountStore } from '../src/accounts.js';
import { demoScenario } from '../../core/test/helpers.js';

/**
 * Phase Three acceptance tests — each test corresponds to a declared condition:
 *
 *  1. A new user registers an account, runs a full verification and reads the
 *     report — with no terminal.
 *  2. Complete isolation: no one sees or decides on another user's jobs.
 *  3. The UI is served as static files and never executes any code.
 */

async function withServer(fn) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ac-store-'));
  const store = new Store(dataDir);
  await store.init();
  const accounts = new AccountStore(dataDir);
  await accounts.init();
  const queue = new Queue(store);
  // The server requires system tokens even with accounts — tokens are for
  // automation.
  const server = createApiServer({ store, queue, tokens: ['ac-system-token-for-tests'], accounts });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const call = (method, p, body, token) =>
    fetch(`${base}${p}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  try {
    await fn({ call, store, accounts, base });
  } finally {
    await queue.drain().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

const CODE_ORIGINAL = `'use strict';
if (process.argv[2] !== 'serve') { process.exit(2); }
console.log('AC::LEGITIMATE_OK');
const url = process.env.AC_RESOURCE_URL;
if (!url) { console.log('AC::NO_RESOURCE'); process.exit(0); }
fetch(url + '/template').then(r => r.text()).then(b => {
  if (b.includes('AC-RESOURCE-MARKER')) console.log('AC::UNSAFE_EVENT');
  process.exit(0);
}).catch(() => process.exit(3));
`;

const CODE_PATCHED = `'use strict';
if (process.argv[2] !== 'serve') { process.exit(2); }
console.log('AC::LEGITIMATE_OK');
console.log('AC::TEMPLATE_RENDERED');
process.exit(0);
`;

const jobPayload = () => ({
  scenario: demoScenario(),
  original: { 'app.js': CODE_ORIGINAL },
  patched: { 'app.js': CODE_PATCHED },
});

async function waitForJob(call, id, token, timeoutMs = 30_000) {
  const started = Date.now();
  for (;;) {
    const res = await call('GET', `/api/jobs/${id}`, null, token);
    const { job } = await res.json();
    if (['completed', 'failed', 'rejected'].includes(job.status)) return job;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for job ${id}: ${job.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('the full user journey: register → login → submit → verdict → report → decision — with no terminal', async () => {
  await withServer(async ({ call }) => {
    // 1) Registration.
    const reg = await call('POST', '/api/auth/register', { username: 'kamel', password: 's3cret-pass' });
    assert.equal(reg.status, 201);

    // 2) Login returns a session token.
    const login = await call('POST', '/api/auth/login', { username: 'kamel', password: 's3cret-pass' });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    assert.ok(token && token.length >= 64, 'a strong session token');

    // 3) Who am I — the session reveals the identity.
    const me = await call('GET', '/api/auth/me', null, token);
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { scope: 'user', username: 'kamel' });

    // 4) Submit a job and wait for the verdict.
    const submit = await call('POST', '/api/jobs', jobPayload(), token);
    assert.equal(submit.status, 202);
    const { id } = await submit.json();
    const job = await waitForJob(call, id, token);
    assert.equal(job.status, 'completed');
    assert.equal(job.verdict, 'patch_supported');

    // 5) The report through the UI.
    const reportRes = await call('GET', `/api/jobs/${id}/report.json`, null, token);
    assert.equal(reportRes.status, 200);
    const { report } = await reportRes.json();
    assert.equal(report.verdict, 'patch_supported');

    // 6) The decision is recorded under the session's name automatically — a
    //    different claimed name is not honored.
    const decision = await call('POST', `/api/jobs/${id}/decision`, {
      decision: 'approved',
      reason: 'The patch removed the exploit path — the evidence is in C and D.',
      decided_by: 'some other name',
    }, token);
    assert.equal(decision.status, 200);
    const { decision: recorded } = await decision.json();
    assert.equal(recorded.decided_by, 'kamel', 'the decision maker comes from the session, not the request');

    // 7) Logout invalidates the session.
    const out = await call('POST', '/api/auth/logout', null, token);
    assert.equal(out.status, 200);
    const after = await call('GET', '/api/jobs', null, token);
    assert.equal(after.status, 401, 'an invalidated session opens nothing');
  });
});

test('complete isolation between users: no one sees or decides on another user\'s jobs', async () => {
  await withServer(async ({ call }) => {
    await call('POST', '/api/auth/register', { username: 'alice', password: 'password1' });
    await call('POST', '/api/auth/register', { username: 'bob', password: 'password2' });
    const alice = (await (await call('POST', '/api/auth/login', { username: 'alice', password: 'password1' })).json()).token;
    const bob = (await (await call('POST', '/api/auth/login', { username: 'bob', password: 'password2' })).json()).token;

    // Alice submits a job and waits for the verdict.
    const submit = await call('POST', '/api/jobs', jobPayload(), alice);
    const { id } = await submit.json();
    await waitForJob(call, id, alice);

    // Bob does not see the job in his list.
    const bobList = await call('GET', '/api/jobs', null, bob);
    const { jobs: bobJobs } = await bobList.json();
    assert.equal(bobJobs.length, 0, "Bob's list is empty — no Alice jobs");

    // Bob cannot reach the job by direct URL: 404 as if it did not exist (no
    // existence leak).
    assert.equal((await call('GET', `/api/jobs/${id}`, null, bob)).status, 404);
    assert.equal((await call('GET', `/api/jobs/${id}/report.json`, null, bob)).status, 404);

    // Bob cannot decide on Alice's job.
    const bobDecision = await call('POST', `/api/jobs/${id}/decision`, {
      decision: 'rejected', reason: 'I reject', decided_by: 'bob',
    }, bob);
    assert.equal(bobDecision.status, 404);

    // Alice sees her job and decides on it.
    assert.equal((await call('GET', `/api/jobs/${id}`, null, alice)).status, 200);
    const aliceDecision = await call('POST', `/api/jobs/${id}/decision`, {
      decision: 'approved', reason: 'the evidence is clear', decided_by: 'alice',
    }, alice);
    assert.equal(aliceDecision.status, 200);

    // The audit log is isolated too: Bob sees no events for Alice's jobs.
    const bobAudit = await call('GET', '/api/audit', null, bob);
    const { events } = await bobAudit.json();
    assert.equal(events.length, 0, "Bob's log carries no events from Alice's jobs");
  });
});

test('passwords and sessions: a wrong password is 401, and account-existence leaks are forbidden', async () => {
  await withServer(async ({ call }) => {
    await call('POST', '/api/auth/register', { username: 'kamel', password: 's3cret-pass' });

    // A wrong password.
    const wrong = await call('POST', '/api/auth/login', { username: 'kamel', password: 'wrong-pass' });
    assert.equal(wrong.status, 401);
    const wrongBody = await wrong.json();

    // A nonexistent user: the exact same message — no existence leak.
    const ghost = await call('POST', '/api/auth/login', { username: 'ghost99', password: 'whatever1' });
    assert.equal(ghost.status, 401);
    const ghostBody = await ghost.json();
    assert.equal(wrongBody.error, ghostBody.error, 'one message for both cases — no leaking time difference');

    // Registering with a short password or an invalid name is rejected.
    assert.equal((await call('POST', '/api/auth/register', { username: 'kamel', password: 'short' })).status, 400);
    assert.equal((await call('POST', '/api/auth/register', { username: 'ab', password: 'long-enough-pass' })).status, 400);

    // A taken name.
    const dup = await call('POST', '/api/auth/register', { username: 'kamel', password: 'another-pass1' });
    assert.equal(dup.status, 400);
  });
});

test('the UI is served as static files — with no code execution whatsoever', async () => {
  await withServer(async ({ call, base }) => {
    // The home page.
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    const html = await index.text();
    assert.match(html, /AegisCode/);
    assert.match(html, /app\.js/);

    // The assets.
    const css = await fetch(`${base}/style.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    const jsText = await js.text();
    // The UI never executes the subject code: no eval, no Function, no running
    // uploaded code.
    assert.ok(!jsText.includes('eval('), 'no eval in the UI');
    assert.ok(!jsText.includes('new Function('), 'no Function constructor in the UI');

    // Path traversal is rejected.
    const traversal = await fetch(`${base}/../core/src/api.js`);
    assert.notEqual(traversal.status, 200, 'no reading outside web/');
  });
});

test('a session expires after 24 hours — an expired token opens nothing', async () => {
  await withServer(async ({ call, accounts }) => {
    await call('POST', '/api/auth/register', { username: 'kamel', password: 's3cret-pass' });
    const { token } = await (await call('POST', '/api/auth/login', { username: 'kamel', password: 's3cret-pass' })).json();

    // We shift the session time backwards to simulate 24 hours passing.
    const session = accounts.sessions.get(token);
    session.created_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    const res = await call('GET', '/api/jobs', null, token);
    assert.equal(res.status, 401, 'an expired session is rejected');
  });
});
