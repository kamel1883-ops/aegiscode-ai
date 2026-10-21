import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Store } from '../src/store.js';
import { Queue } from '../src/queue.js';
import { createApiServer } from '../src/api.js';
import { tokensFromEnv } from '../src/auth.js';
import { AccountStore } from '../src/accounts.js';
import { demoScenario } from '../../core/test/helpers.js';

/**
 * Phase Two acceptance tests — each test corresponds to a declared condition:
 *
 *  1. Full cycle: submit a job → verdict → recorded human decision, end to end.
 *  2. Explicit rejections: a decision before the verdict, a second decision
 *     after the first, auto-merge — all rejected.
 *  3. Authentication: no token or a wrong token ⇒ 401, and the server refuses
 *     to start without tokens.
 *  4. The audit log documents every event and is never erased.
 */

const TOKEN = 'ac-test-token-000';

async function withServer(fn) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ac-store-'));
  const store = new Store(dataDir);
  await store.init();
  const accounts = new AccountStore(dataDir);
  await accounts.init();
  const queue = new Queue(store);
  const server = createApiServer({ store, queue, tokens: [TOKEN], accounts });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const call = (method, p, body, token = TOKEN) =>
    fetch(`${base}${p}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  try {
    await fn({ call, store, queue, base });
  } finally {
    // We wait for any job still in the queue before closing and deleting, so
    // the store never writes into a deleted directory (activity after the test
    // ends).
    await queue.drain().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Reads a fixture's code as an uploadable file map. */
async function fixtureFiles(name) {
  const content = await readFile(
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'core', 'fixtures', name, 'app.js'),
    'utf8',
  );
  return { 'app.js': content };
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

test('full cycle: submit → decisive verdict → recorded human decision — end to end', async () => {
  await withServer(async ({ call }) => {
    // 1) Submit a verification job with the real patch.
    const submit = await call('POST', '/api/jobs', {
      scenario: demoScenario(),
      original: await fixtureFiles('original'),
      patched: await fixtureFiles('patch-real'),
    });
    assert.equal(submit.status, 202, `the response was ${submit.status}`);
    const { id, status } = await submit.json();
    assert.equal(status, 'queued');

    // 2) Final state: a decisive patch_supported — and the summary points to a
    //    stored report (the summary deliberately omits the big report; it is
    //    fetched via /report).
    const job = await waitForJob(call, id);
    assert.equal(job.status, 'completed');
    assert.equal(job.verdict, 'patch_supported');
    assert.equal(job.human_decision.status, 'pending', 'the decision is human — not taken yet');

    // 3) The report is available in both formats through a dedicated route.
    const json = await call('GET', `/api/jobs/${id}/report.json`);
    assert.equal(json.status, 200);
    const { report } = await json.json();
    assert.equal(report.verdict, 'patch_supported');
    assert.equal(report.human_decision.status, 'pending', 'the report does not claim adoption');
    assert.equal(report.executor.all_workspaces_deleted, true, 'Phase One evidence in the server report');

    const md = await call('GET', `/api/jobs/${id}/report.md`);
    assert.equal(md.status, 200);
    assert.match(md.headers.get('content-type'), /text\/markdown/);
    assert.match(await md.text(), /Verdict/);

    // 4) Human adoption: a decision with a reason and a named decision maker.
    const decision = await call('POST', `/api/jobs/${id}/decision`, {
      decision: 'approved',
      reason: 'The patch removed the exploit path; the evidence is in conditions C and D.',
      decided_by: 'kamel',
    });
    assert.equal(decision.status, 200);
    const decided = await decision.json();
    assert.equal(decided.decision.status, 'approved');
    assert.equal(decided.decision.decided_by, 'kamel');
    assert.ok(decided.decision.decided_at, 'the decision time is documented');
    assert.ok(decided.decision.reason.includes('evidence'));

    // 5) The decision is persisted in the store and sticks.
    const after = await call('GET', `/api/jobs/${id}`);
    const { job: afterJob } = await after.json();
    assert.equal(afterJob.human_decision.status, 'approved');
    assert.equal(afterJob.human_decision.decided_by, 'kamel');

    // 6) The report itself reflects the decision — otherwise the UI would show
    //    decision buttons again after recording.
    const afterReport = await call('GET', `/api/jobs/${id}/report.json`);
    assert.equal(afterReport.status, 200);
    const { report: decidedReport } = await afterReport.json();
    assert.equal(decidedReport.human_decision.status, 'approved', 'the report carries the decision after recording');
    assert.equal(decidedReport.human_decision.decided_by, 'kamel');
  });
});

test('a decision before the verdict is explicitly rejected (409) — no verdict, no decision', async () => {
  await withServer(async ({ call }) => {
    const submit = await call('POST', '/api/jobs', {
      scenario: demoScenario(),
      original: await fixtureFiles('original'),
      patched: await fixtureFiles('patch-real'),
    });
    const { id } = await submit.json();

    // The job may be queued or running — the decision must be rejected in both
    // cases (409).
    const decision = await call('POST', `/api/jobs/${id}/decision`, {
      decision: 'approved',
      reason: 'premature decision',
      decided_by: 'kamel',
    });
    assert.equal(decision.status, 409);
    const body = await decision.json();
    assert.match(body.error, /No verdict/);

    // And also for a nonexistent job: 404 — "not found" is more precise than "conflict".
    const ghost = await call('POST', '/api/jobs/job-ghost/decision', {
      decision: 'approved',
      reason: 'x',
      decided_by: 'y',
    });
    assert.equal(ghost.status, 404);
  });
});

test('a decision without a reason, without a name, or after a first decision is rejected', async () => {
  await withServer(async ({ call }) => {
    const submit = await call('POST', '/api/jobs', {
      scenario: demoScenario(),
      original: await fixtureFiles('original'),
      patched: await fixtureFiles('patch-real'),
    });
    const { id } = await submit.json();
    await waitForJob(call, id);

    // A decision without a reason.
    const noReason = await call('POST', `/api/jobs/${id}/decision`, { decision: 'approved', reason: '', decided_by: 'kamel' });
    assert.equal(noReason.status, 409);

    // A decision without a decision maker.
    const noActor = await call('POST', `/api/jobs/${id}/decision`, { decision: 'rejected', reason: 'a reason', decided_by: '' });
    assert.equal(noActor.status, 409);

    // A correct first decision.
    const first = await call('POST', `/api/jobs/${id}/decision`, { decision: 'rejected', reason: 'the vulnerability remains in D', decided_by: 'kamel' });
    assert.equal(first.status, 200);

    // A second decision is refused — decisions are not edited.
    const second = await call('POST', `/api/jobs/${id}/decision`, { decision: 'approved', reason: 'I changed my mind', decided_by: 'kamel' });
    assert.equal(second.status, 409);
    const body = await second.json();
    assert.match(body.error, /already recorded/);
  });
});

test('no merge and no code-modification interface: merge/apply/commit are rejected with 405', async () => {
  await withServer(async ({ call }) => {
    for (const action of ['merge', 'apply', 'commit']) {
      const res = await call('POST', `/api/jobs/job-x/${action}`, { branch: 'main' });
      assert.equal(res.status, 405, `${action} must be 405`);
      const body = await res.json();
      assert.match(body.error, /performs no merge/);
    }
  });
});

test('authentication: no token or wrong token ⇒ 401 — and no route is exempt', async () => {
  await withServer(async ({ call }) => {
    const noToken = await call('GET', '/api/health', null, '');
    assert.equal(noToken.status, 401);

    const badToken = await call('GET', '/api/jobs', null, 'wrong-token');
    assert.equal(badToken.status, 401);

    // Sensitive routes are protected too.
    const audit = await call('GET', '/api/audit', null, 'wrong-token');
    assert.equal(audit.status, 401);

    // And the valid token succeeds.
    const ok = await call('GET', '/api/health');
    assert.equal(ok.status, 200);
  });
});

test('a broken scenario is rejected at scheduling (400) — no job without the eight fields', async () => {
  await withServer(async ({ call }) => {
    const res = await call('POST', '/api/jobs', {
      scenario: { id: 'broken' }, // missing the fields
      original: await fixtureFiles('original'),
      patched: await fixtureFiles('patch-real'),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.details.length > 0, 'the errors are detailed');

    // And unsafe files (path traversal) are rejected.
    const traversal = await call('POST', '/api/jobs', {
      scenario: demoScenario(),
      original: { '../escape.js': 'x' },
      patched: await fixtureFiles('patch-real'),
    });
    assert.equal(traversal.status, 400);
    const body2 = await traversal.json();
    assert.ok(body2.details.some((e) => e.includes('unsafe')));
  });
});

test('the audit log documents events and is never erased', async () => {
  await withServer(async ({ call, store }) => {
    const submit = await call('POST', '/api/jobs', {
      scenario: demoScenario(),
      original: await fixtureFiles('original'),
      patched: await fixtureFiles('patch-real'),
    });
    const { id } = await submit.json();
    await waitForJob(call, id);
    await call('POST', `/api/jobs/${id}/decision`, { decision: 'approved', reason: 'a reason', decided_by: 'kamel' });

    const audit = await call('GET', '/api/audit');
    assert.equal(audit.status, 200);
    const { events } = await audit.json();
    const kinds = events.map((e) => e.event);
    assert.ok(kinds.includes('job.submitted'), 'submission is documented');
    assert.ok(kinds.includes('job.completed'), 'completion is documented');
    assert.ok(kinds.includes('decision.recorded'), 'the decision is documented');

    // A rejected authentication attempt is documented too.
    const rejectedAuth = await call('GET', '/api/audit', null, 'bad');
    assert.equal(rejectedAuth.status, 401);
    const audit2 = await call('GET', '/api/audit');
    const { events: events2 } = await audit2.json();
    assert.ok(events2.some((e) => e.event === 'auth.rejected'), 'failed authentication attempts are documented');

    // The log is append-only on disk — never erased.
    const onDisk = await readFile(path.join(store.dir, 'audit.jsonl'), 'utf8');
    assert.ok(onDisk.includes('decision.recorded'), 'the log is materially saved on disk');
  });
});

test('the server refuses to start without access tokens and without an account store (the safe default)', () => {
  assert.throws(
    () => createApiServer({ store: null, queue: null, tokens: [], accounts: null }),
    /No access tokens/,
  );
  assert.throws(
    () => createApiServer({ store: null, queue: null, tokens: [TOKEN], accounts: null }),
    /account store is mandatory/,
  );
});

test('tokensFromEnv: reads tokens from the environment and ignores whitespace', () => {
  assert.deepEqual(tokensFromEnv({ AEGISCODE_API_TOKENS: ' a , b ,,c ' }), ['a', 'b', 'c']);
  assert.deepEqual(tokensFromEnv({}), []);
});
