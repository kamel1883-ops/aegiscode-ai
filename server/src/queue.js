/**
 * AegisCode — verification job queue (Phase Two)
 *
 * Every job runs exactly once, in sequence: causal verification runs four
 * conditions in isolation, and concurrency here weakens the evidence rather
 * than speeding it up.
 *
 * Every job:
 *  1. Creates a temporary workspace for each version (original/patched) from
 *     the uploaded files.
 *  2. Runs verify() from the core — meaning it goes entirely through the
 *     separate, isolated agent path.
 *  3. Stores the verdict and the evidence.
 *  4. Deletes the temporary workspaces — and no real repository is ever
 *     touched.
 */

import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { verify } from '../../core/src/index.js';
import { validateScenario } from '../../core/src/schema.js';

/** Abuse protection: a ceiling on file count and per-file size in each version. */
const MAX_FILES = 50;
const MAX_FILE_BYTES = 1_000_000;

/**
 * Validates an uploaded file map: safe relative keys with no traversal, and
 * text values within the ceiling.
 * @returns {string[]} errors — empty when valid.
 */
export function validateFiles(files, label) {
  const errors = [];
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    return [`${label} must be an object mapping relative paths to text values.`];
  }
  const keys = Object.keys(files);
  if (keys.length === 0) errors.push(`${label} is empty — at least one file is required.`);
  if (keys.length > MAX_FILES) errors.push(`${label}: file count (${keys.length}) exceeds the limit (${MAX_FILES}).`);
  for (const key of keys) {
    if (key === '' || path.isAbsolute(key) || key.split('/').includes('..')) {
      errors.push(`${label}: the path "${key}" is unsafe — relative paths only, no "..".`);
    }
    const value = files[key];
    if (typeof value !== 'string') {
      errors.push(`${label}: content of "${key}" is not text.`);
    } else if (Buffer.byteLength(value, 'utf8') > MAX_FILE_BYTES) {
      errors.push(`${label}: size of "${key}" exceeds the limit.`);
    }
  }
  return errors;
}

/** Writes a file map into a temporary directory and returns its path. */
async function materialize(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-upload-'));
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(dir, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content, 'utf8');
  }
  return dir;
}

export class Queue {
  /**
   * @param {object} store job and audit store
   * @param {object} [opts]
   * @param {(raw:object, subjects:object)=>Promise<object>} [opts.verifyFn] injection for tests
   */
  constructor(store, { verifyFn = verify } = {}) {
    this.store = store;
    this.verifyFn = verifyFn;
    /** @type {Promise<void>} the chain: every job waits for its predecessor */
    this.chain = Promise.resolve();
  }

  /**
   * Submits a job: validates the inputs immediately (scenario + two file maps),
   * then schedules execution under the requester's owner name.
   *
   * @param {{scenario:object, original:object, patched:object}} payload
   * @param {string|null} owner job owner (username) — for user isolation
   * @returns {Promise<{ok:boolean, errors?:string[], job?:object}>}
   */
  async submit({ scenario, original, patched }, owner = null) {
    const errors = [];
    // The scenario is validated **strictly at submission** — an incomplete
    // scenario never enters the queue at all.
    if (typeof scenario !== 'object' || scenario === null || Array.isArray(scenario)) {
      errors.push('The scenario must be an object with the eight fields.');
    } else {
      const { ok: scenarioOk, errors: scenarioErrors } = validateScenario(scenario);
      if (!scenarioOk) errors.push(...scenarioErrors);
    }
    errors.push(...validateFiles(original, 'The original version'));
    errors.push(...validateFiles(patched, 'The patched version'));

    if (errors.length > 0) {
      await this.store.record('job.rejected_payload', null, { errors });
      return { ok: false, errors };
    }

    const job = await this.store.createJob({ scenarioId: scenario.id ?? null, owner });
    await this.store.record('job.submitted', job.id, { scenario_id: job.scenario_id });

    // Execution happens in the chain: sequential, not concurrent. A snapshot of
    // the accepted state is returned (not the live object, which may turn
    // running before the response is sent).
    const snapshot = { id: job.id, status: 'queued' };
    this.chain = this.chain.then(() => this.#run(job.id, { scenario, original, patched }));
    return { ok: true, job: snapshot };
  }

  /** Waits for the chain to drain — for tests. */
  async drain() {
    await this.chain;
  }

  async #run(jobId, { scenario, original, patched }) {
    const job = this.store.getJob(jobId);
    if (!job) return;

    await this.store.updateJob(jobId, { status: 'running', started_at: new Date().toISOString() });
    await this.store.record('job.started', jobId, null);

    let originalDir = null;
    let patchedDir = null;

    try {
      originalDir = await materialize(original);
      patchedDir = await materialize(patched);

      const result = await this.verifyFn(scenario, { original: originalDir, patched: patchedDir }, { jobId });

      if (!result.ok) {
        // A broken scenario OR an infrastructure refusal (unknown sandbox,
        // no daemon in require-container): rejected before any verdict —
        // and the rejection is documented. Never falls back to process.
        const infra = result.infra_refused === true;
        await this.store.updateJob(jobId, {
          status: 'rejected',
          finished_at: new Date().toISOString(),
          errors: result.errors,
        });
        await this.store.record(infra ? 'job.rejected_infra' : 'job.rejected_scenario', jobId, { errors: result.errors });
        return;
      }

      await this.store.updateJob(jobId, {
        status: 'completed',
        finished_at: new Date().toISOString(),
        verdict: result.verdict,
        reason_code: result.report.reason_code,
        reason: result.report.reason,
        report: result.report,
        markdown: result.markdown,
      });
      await this.store.record('job.completed', jobId, { verdict: result.verdict });
    } catch (err) {
      // A thrown infrastructure refusal is also a rejection, not a silent
      // fallback and not a candidate crash. Candidate crashes/timeouts are
      // returned inside the report (status crash/timeout), never thrown.
      const msg = String(err?.message ?? err);
      const infra = msg.startsWith('sandbox_refused') || err?.code === 'container_unavailable';
      await this.store.updateJob(jobId, {
        status: infra ? 'rejected' : 'failed',
        finished_at: new Date().toISOString(),
        errors: [msg],
      });
      await this.store.record(infra ? 'job.rejected_infra' : 'job.failed', jobId, { error: msg });
    } finally {
      // Temporary workspaces are deleted in every case: no trace remains and
      // no real repository is ever touched.
      for (const dir of [originalDir, patchedDir]) {
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
