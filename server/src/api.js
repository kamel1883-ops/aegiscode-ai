/**
 * AegisCode — API server (Phase Three: accounts, sessions, isolation)
 *
 * Zero dependencies: node:http only, and the same philosophy as the core —
 * everything reproducible on any machine with Node ≥ 20.
 *
 * Two-tier authentication:
 *  - **System token** (AEGISCODE_API_TOKENS): full access to every route — for automation.
 *  - **User session**: sees and manages only their own jobs — ownership is
 *    enforced on every route.
 *
 * The web UI: `web/` is served as static files from the root, and no code ever
 * executes in the browser or in the web server — the subject code always goes
 * through the core into a separate agent.
 *
 * Human-adoption interfaces:
 *  - One decision per job, never accepted before the verdict is issued.
 *  - The decision carries a reason and the decision maker's name, and is never
 *    edited after recording.
 *  - There is no interface that performs any code modification or merge — the
 *    design prevents it.
 */

import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { randomTimingSafeEqual } from './auth.js';
import { BudgetManager } from './budget.js';
import { createMetaClient } from './meta-client.js';
import { AdvisoryService } from './advisory.js';

const MAX_BODY_BYTES = 2_000_000;

const WEB_ROOT = fileURLToPath(new URL('../../web/', import.meta.url));

/** MIME map for UI files — no execution, no interpretation, serving only. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error('Request body exceeds the allowed limit.');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('Request body is not valid JSON.');
    err.status = 400;
    throw err;
  }
}

/** Serves a file from web/ — with a normalized path that never escapes the root. */
async function serveStatic(res, relPath) {
  const safePath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(WEB_ROOT, safePath);
  if (!full.startsWith(WEB_ROOT)) {
    sendText(res, 404, 'Not found.');
    return;
  }
  try {
    const data = await readFile(full);
    const type = MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    sendText(res, 404, 'Not found.');
  }
}

/**
 * Resolves the request identity: a system token (full access) or a user
 * session (own jobs only).
 * @returns {{scope:'system'}|{scope:'user', username:string}|null}
 */
function identify(req, tokens, accounts) {
  const auth = req.headers.authorization ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!provided) return null;

  if (randomTimingSafeEqual(provided, tokens)) return { scope: 'system' };

  const session = accounts?.authenticate(provided);
  if (session) return { scope: 'user', username: session.username };

  return null;
}

/**
 * Builds a fully configured server.
 *
 * @param {object} params
 * @param {import('./store.js').Store} params.store
 * @param {import('./queue.js').Queue} params.queue
 * @param {string[]} params.tokens allowed system tokens
 * @param {import('./accounts.js').AccountStore} params.accounts
 * @param {import('./advisory.js').AdvisoryService} [params.meta] advisory service (defaults to a mock-mode one from env)
 * @returns {import('node:http').Server}
 */
export function createApiServer({ store, queue, tokens, accounts, meta = null }) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new Error('No access tokens: the server refuses to start without tokens (the safe default).');
  }
  if (!accounts) {
    throw new Error('The account store is mandatory: the server does not run without accounts.');
  }

  // The Meta advisory service: mock mode by default (no key, no network, no
  // live call — and no automatic call at startup in any mode).
  const advisory = meta ?? new AdvisoryService({
    store,
    queue,
    budget: new BudgetManager(store.dir),
    client: createMetaClient({ env: process.env, dir: store.dir }),
    // Explicit opt-in only (default off): live model-generated candidates
    // are never executed without it, even where a boundary exists.
    allowLiveExecution: process.env.AC_ALLOW_LIVE_EXECUTION === '1',
  });

  return createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const method = req.method ?? 'GET';

    try {
      // ---- The UI: static files without authentication (the login page is public) ----
      if (!url.pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') {
          sendText(res, 405, 'Method not allowed.');
          return;
        }
        await serveStatic(res, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        return;
      }

      // ---- Account registration: no authentication ----
      if (method === 'POST' && url.pathname === '/api/auth/register') {
        const body = await readBody(req);
        const { ok, error, username } = await accounts.register(body.username, body.password);
        if (!ok) {
          sendJson(res, 400, { error });
          return;
        }
        await store.record('account.registered', null, { username });
        sendJson(res, 201, { username });
        return;
      }

      // ---- Login: returns a session token ----
      if (method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readBody(req);
        const { ok, error, token, username } = await accounts.login(body.username, body.password);
        if (!ok) {
          sendJson(res, 401, { error });
          return;
        }
        await store.record('account.login', null, { username });
        sendJson(res, 200, { token, username });
        return;
      }

      // ---- All other routes: authentication mandatory ----
      const actor = identify(req, tokens, accounts);
      if (!actor) {
        await store.record('auth.rejected', null, { path: url.pathname, method });
        sendJson(res, 401, { error: 'Unauthorized: log in or use a system token.' });
        return;
      }

      // ---- Logout ----
      if (method === 'POST' && url.pathname === '/api/auth/logout') {
        const auth = req.headers.authorization ?? '';
        const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        accounts.logout(provided);
        sendJson(res, 200, { ok: true });
        return;
      }

      // ---- Who am I ----
      if (method === 'GET' && url.pathname === '/api/auth/me') {
        sendJson(res, 200, { scope: actor.scope, username: actor.username ?? null });
        return;
      }

      // ---- Health: for tests and liveness checks ----
      if (method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true, service: 'aegiscode-api', phase: 3 });
        return;
      }

      // ---- Submit a verification job ----
      if (method === 'POST' && url.pathname === '/api/jobs') {
        const body = await readBody(req);
        const owner = actor.scope === 'user' ? actor.username : null;
        const { ok, errors, job } = await queue.submit({
          scenario: body.scenario,
          original: body.original,
          patched: body.patched,
        }, owner);
        if (!ok) {
          sendJson(res, 400, { error: 'The job was rejected before scheduling.', details: errors });
          return;
        }
        sendJson(res, 202, { id: job.id, status: job.status });
        return;
      }

      // ---- Job list: a user sees only their own jobs ----
      if (method === 'GET' && url.pathname === '/api/jobs') {
        const jobs = store.listJobs(actor.scope === 'user' ? actor.username : null).map((j) => ({
          id: j.id,
          status: j.status,
          verdict: j.verdict,
          scenario_id: j.scenario_id,
          created_at: j.created_at,
          finished_at: j.finished_at,
          decision: j.human_decision.status,
        }));
        sendJson(res, 200, { jobs });
        return;
      }

      // ---- A specific job route: isolation is enforced here ----
      const jobMatch = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9-]+)$/);
      if (jobMatch) {
        const job = store.getJob(jobMatch[1]);
        // Isolation: someone else's job is treated as if it did not exist —
        // no leak of existence or content.
        if (!job || (actor.scope === 'user' && job.owner !== actor.username)) {
          sendJson(res, 404, { error: 'Job not found.' });
          return;
        }
        if (method === 'GET') {
          const { report, markdown, ...summary } = job;
          sendJson(res, 200, {
            job: summary,
            has_report: report !== null,
            report_url: `/api/jobs/${job.id}/report`,
          });
          return;
        }
      }

      // ---- The job report (JSON or Markdown) ----
      const reportMatch = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9-]+)\/report(\.json|\.md)?$/);
      if (reportMatch && method === 'GET') {
        const job = store.getJob(reportMatch[1]);
        if (!job || (actor.scope === 'user' && job.owner !== actor.username)) {
          sendJson(res, 404, { error: 'Job not found.' });
          return;
        }
        if (job.status !== 'completed' || job.report === null) {
          sendJson(res, 409, { error: `No report yet — job status: ${job.status}.`, verdict: job.verdict });
          return;
        }
        if (reportMatch[2] === '.md') {
          sendText(res, 200, `${job.markdown}\n`, 'text/markdown; charset=utf-8');
        } else {
          sendJson(res, 200, { report: job.report });
        }
        return;
      }

      // ---- Human adoption: one decision per job, with a mandatory reason ----
      const decisionMatch = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9-]+)\/decision$/);
      if (decisionMatch && method === 'POST') {
        const job = store.getJob(decisionMatch[1]);
        if (!job || (actor.scope === 'user' && job.owner !== actor.username)) {
          sendJson(res, 404, { error: 'Job not found.' });
          return;
        }
        const body = await readBody(req);
        // The decision maker: a session records its own name automatically —
        // claiming another name is not possible.
        const decidedBy = actor.scope === 'user' ? actor.username : String(body.decided_by ?? '').trim();
        const { ok, error, job: updated } = await store.recordDecision(decisionMatch[1], {
          decision: body.decision,
          reason: body.reason,
          decidedBy,
        });
        if (!ok) {
          sendJson(res, 409, { error });
          return;
        }
        sendJson(res, 200, { id: updated.id, decision: updated.human_decision });
        return;
      }

      // ---- Meta advisory: integration status (state, model, pricing, budget) ----
      if (url.pathname === '/api/meta/status' && method === 'GET') {
        sendJson(res, 200, await advisory.status());
        return;
      }

      // ---- Meta advisory: start a cycle (stages A + B + C) ----
      if (url.pathname === '/api/meta/advisory' && method === 'POST') {
        const body = await readBody(req);
        const owner = actor.scope === 'user' ? actor.username : null;
        const result = await advisory.start({
          sourceJobId: String(body.source_job_id ?? ''),
          scenario: body.scenario,
          original: body.original,
          owner,
        });
        if (!result.ok) {
          const status = ['source_not_found', 'not_found'].includes(result.code) ? 404
            : ['advisory_exists', 'source_incomplete'].includes(result.code) ? 409
              : 400;
          sendJson(res, status, { error: result.error, code: result.code, details: result.details ?? undefined });
          return;
        }
        sendJson(res, 202, { advisory: result.advisory });
        return;
      }

      // ---- Meta advisory: stage D (summarize), cancel, or read ----
      const advMatch = url.pathname.match(/^\/api\/meta\/advisory\/([A-Za-z0-9-]+)(?:\/(summarize|cancel))?$/);
      if (advMatch) {
        const id = advMatch[1];
        const action = advMatch[2] ?? null;
        const owner = actor.scope === 'user' ? actor.username : null;
        // Isolation: someone else's advisory is treated as if it did not exist.
        // A GET accepts the advisory id, the source job id, or the verification
        // job id, so the UI can look up the lineage from either report without
        // new calls. POST actions (summarize/cancel) still require the advisory
        // id inside the service — a source/verification id never triggers them.
        const record = advisory.get(id) ?? advisory.findBySourceJob(id) ?? (action === null && method === 'GET' ? advisory.findByVerificationJob(id) : null);
        if (!record || (owner !== null && record.owner !== owner)) {
          sendJson(res, 404, { error: 'Advisory not found.' });
          return;
        }
        if (method === 'GET' && action === null) {
          sendJson(res, 200, { advisory: advisory._view(record) });
          return;
        }
        if (method === 'POST' && action === 'summarize') {
          const result = await advisory.summarize({ id, owner });
          if (!result.ok) {
            sendJson(res, result.code === 'not_found' ? 404 : 409, { error: result.error, code: result.code });
            return;
          }
          sendJson(res, 200, { advisory: result.advisory });
          return;
        }
        if (method === 'POST' && action === 'cancel') {
          const result = await advisory.cancel({ id, owner });
          if (!result.ok) {
            sendJson(res, result.code === 'not_found' ? 404 : 409, { error: result.error, code: result.code });
            return;
          }
          sendJson(res, 200, { advisory: result.advisory });
          return;
        }
      }

      // ---- Audit log: a user sees only events for their own jobs ----
      if (method === 'GET' && url.pathname === '/api/audit') {
        let events = store.recentAudit();
        if (actor.scope === 'user') {
          const mine = new Set(store.listJobs(actor.username).map((j) => j.id));
          events = events.filter((e) => e.job_id !== null && mine.has(e.job_id));
        }
        sendJson(res, 200, { events });
        return;
      }

      // ---- No merge and no code-modification interfaces: the design prevents them ----
      if (/^\/api\/jobs\/[A-Za-z0-9-]+\/(merge|apply|commit)/.test(url.pathname)) {
        sendJson(res, 405, {
          error: 'The system performs no merge and no code modification — adoption is an external human decision.',
        });
        return;
      }

      sendJson(res, 404, { error: `No route for ${method} ${url.pathname}.` });
    } catch (err) {
      sendJson(res, err.status ?? 500, { error: String(err?.message ?? err) });
    }
  });
}
