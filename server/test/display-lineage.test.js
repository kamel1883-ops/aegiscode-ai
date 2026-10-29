import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile as readFixture } from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));

import { Store } from '../src/store.js';
import { Queue } from '../src/queue.js';
import { createApiServer } from '../src/api.js';
import { AccountStore } from '../src/accounts.js';
import { demoScenario } from '../../core/test/helpers.js';

/**
 * Display-lineage tests (offline, mock mode — no live model calls).
 * The UI change only reads saved reports; these tests lock the API contract
 * it depends on:
 *  1. GET /api/meta/advisory/:id resolves via advisory id, source job id,
 *     AND verification job id — all three return the same advisory.
 *  2. Ownership holds on the reverse path: another account gets 404.
 *  3. POST actions still require the advisory id — a verification id never
 *     triggers summarize/cancel.
 *  4. Reports carry the automatic fields the UI renders (functional,
 *     acceptance, human_decision) so missing-field guards are only for
 *     historic reports.
 */

const TOKEN = 'ac-lineage-token-000';

const ORIGINAL = await readFixture(
  path.join(here, '..', '..', 'core', 'fixtures', 'original', 'app.js'),
  'utf8',
);
const PATCH_REAL = await readFixture(
  path.join(here, '..', '..', 'core', 'fixtures', 'patch-real', 'app.js'),
  'utf8',
);

async function withServer(fn) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ac-lineage-'));
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
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  const register = async (username, password) => {
    await call('POST', '/api/auth/register', { username, password });
    const res = await call('POST', '/api/auth/login', { username, password });
    return (await res.json()).token;
  };

  try {
    await fn({ call, register });
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
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for job ${id}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('advisory resolves via advisory id, source id, and verification id — same record', async () => {
  await withServer(async ({ call, register }) => {
    const scenario = demoScenario();
    const submit = await call('POST', '/api/jobs', {
      scenario,
      original: { 'app.js': ORIGINAL },
      patched: { 'app.js': PATCH_REAL },
    });
    assert.equal(submit.status, 202);
    const { id: sourceId } = await submit.json();
    await waitForJob(call, sourceId);

    const start = await call('POST', '/api/meta/advisory', {
      source_job_id: sourceId,
      scenario,
      original: { 'app.js': ORIGINAL },
    });
    assert.equal(start.status, 202);
    const { advisory } = await start.json();
    assert.ok(advisory.id);
    assert.ok(advisory.verification_job_id);
    const verificationId = advisory.verification_job_id;

    for (const key of [advisory.id, sourceId, verificationId]) {
      const res = await call('GET', `/api/meta/advisory/${key}`);
      assert.equal(res.status, 200, `GET via ${key} must resolve`);
      const body = await res.json();
      assert.equal(body.advisory.id, advisory.id);
      assert.equal(body.advisory.source_job_id, sourceId);
      assert.equal(body.advisory.verification_job_id, verificationId);
    }

    // Ownership holds on the reverse path too.
    const bob = await register('bob', 'bob-pass-123');
    for (const key of [advisory.id, sourceId, verificationId]) {
      const foreign = await call('GET', `/api/meta/advisory/${key}`, undefined, bob);
      assert.equal(foreign.status, 404, `another account must not see the advisory via ${key}`);
    }

    // POST actions still require the advisory id — a verification id is rejected
    // with 404 and causes no side effect (the advisory stays 'tested').
    const badSummarize = await call('POST', `/api/meta/advisory/${verificationId}/summarize`);
    assert.equal(badSummarize.status, 404, 'summarize via verification id must be rejected with 404');
    const recheck = await call('GET', `/api/meta/advisory/${advisory.id}`);
    assert.equal(recheck.status, 200);
    assert.equal((await recheck.json()).advisory.status, 'tested', 'a rejected summarize must not change the advisory');

    // The verification report carries the automatic fields the UI renders.
    await waitForJob(call, verificationId);
    const repRes = await call('GET', `/api/jobs/${verificationId}/report.json`);
    assert.equal(repRes.status, 200);
    const { report } = await repRes.json();
    assert.ok(report.functional && typeof report.functional.status === 'string', 'functional present');
    assert.ok(report.acceptance && typeof report.acceptance.decision === 'string', 'acceptance present');
    assert.ok(report.human_decision && typeof report.human_decision.status === 'string', 'human decision present');
    assert.notEqual(report.acceptance.decision, report.human_decision.status, 'automatic acceptance and human decision are separate fields');

    // Summarize locks the advisory contract the UI renders: acceptance is the
    // decision string (older and current records alike), functional carries
    // its status. The UI must read both shapes without crashing.
    const summary = await call('POST', `/api/meta/advisory/${advisory.id}/summarize`);
    assert.equal(summary.status, 200);
    const done = (await summary.json()).advisory;
    assert.ok(done.verification, 'summarize fills the verification slot');
    assert.equal(typeof done.verification.acceptance, 'string', 'acceptance is stored as the decision string');
    assert.ok(done.verification.functional === null || typeof done.verification.functional.status === 'string', 'functional carries its status when present');
    const reread = await call('GET', `/api/meta/advisory/${advisory.id}`);
    assert.equal((await reread.json()).advisory.verification.acceptance, done.verification.acceptance, 'the stored shape survives a refetch');
  });
});
