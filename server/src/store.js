/**
 * AegisCode — job store and audit log (Phase Two)
 *
 * The design enforces the human-adoption rule in practice, not as a slogan:
 *  - The store keeps **only the verdict, the evidence and the adoption
 *    decision** — it owns no interface for modifying code or merging a change,
 *    and it never references a real repository.
 *  - The audit log is an **append-only file** (JSONL): every event is added,
 *    never edited.
 *  - Every human decision is recorded with who decided, when and why — and is
 *    never changed after recording.
 *
 * Storage is plain JSON files: zero dependencies, and any machine reproduces
 * the same files.
 */

import { mkdir, readFile, writeFile, appendFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const JOBS_FILE = 'jobs.json';
const AUDIT_FILE = 'audit.jsonl';

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.jobsPath = path.join(dir, JOBS_FILE);
    this.auditPath = path.join(dir, AUDIT_FILE);
    /** @type {Map<string, object>} */
    this.jobs = new Map();
    /** @type {object[]} */
    this.auditEvents = [];
  }

  async init() {
    await mkdir(this.dir, { recursive: true });

    try {
      const raw = await readFile(this.jobsPath, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [id, job] of Object.entries(parsed.jobs ?? {})) {
        this.jobs.set(id, job);
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }

    try {
      const raw = await readFile(this.auditPath, 'utf8');
      this.auditEvents = raw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try { return JSON.parse(l); } catch { return null; }
        })
        .filter(Boolean);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  async _persistJobs() {
    const obj = { jobs: Object.fromEntries(this.jobs) };
    const tmp = `${this.jobsPath}.tmp-${randomUUID().slice(0, 8)}`;
    await writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    await rename(tmp, this.jobsPath);
  }

  /**
   * Creates a new job for a given owner. The job starts as queued with a
   * pending human decision — and the job owns no field that allows code
   * modification.
   */
  async createJob({ scenarioId, owner }) {
    const id = `job-${randomUUID()}`;
    const job = {
      id,
      owner: owner ?? null,
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      status: 'queued', // queued → running → completed | failed | rejected
      scenario_id: scenarioId ?? null,
      verdict: null,
      reason_code: null,
      reason: null,
      errors: [],
      report: null,
      markdown: null,
      human_decision: {
        status: 'pending',
        reason: null,
        decided_by: null,
        decided_at: null,
        note: 'Adoption is a documented human decision; no auto-merge and no modification is performed.',
      },
    };
    this.jobs.set(id, job);
    await this._persistJobs();
    return job;
  }

  getJob(id) {
    return this.jobs.get(id) ?? null;
  }

  listJobs(owner = null) {
    const all = [...this.jobs.values()];
    // Isolation: an owner sees only their own jobs; a null owner means
    // "system" — sees everything.
    const visible = owner === null ? all : all.filter((j) => j.owner === owner);
    return visible.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  async updateJob(id, patch) {
    const job = this.jobs.get(id);
    if (!job) return null;
    Object.assign(job, patch);
    await this._persistJobs();
    return job;
  }

  /**
   * Records a human decision — once only, and never edited afterwards.
   * @returns {{ok:boolean, error?:string, job?:object}}
   */
  async recordDecision(id, { decision, reason, decidedBy }) {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, error: 'Job not found.' };

    if (job.verdict === null) {
      return { ok: false, error: 'No verdict is recorded for this job yet; a decision cannot precede the report.' };
    }
    if (job.human_decision.status !== 'pending') {
      return { ok: false, error: `A decision is already recorded (${job.human_decision.status}) and is not edited.` };
    }
    if (!['approved', 'rejected'].includes(decision)) {
      return { ok: false, error: 'The decision must be approved or rejected.' };
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      return { ok: false, error: 'The decision reason is mandatory and may not be empty.' };
    }
    if (typeof decidedBy !== 'string' || decidedBy.trim() === '') {
      return { ok: false, error: 'The decision maker name is mandatory — no anonymous decisions.' };
    }

    job.human_decision = {
      status: decision,
      reason: reason.trim(),
      decided_by: decidedBy.trim(),
      decided_at: new Date().toISOString(),
      note: 'A documented human decision; no automatic modification was made to any code.',
    };
    // The stored report carries a copy of the adoption state — synced with the
    // decision, otherwise the UI would show decision buttons again after recording.
    if (job.report && typeof job.report === 'object') {
      job.report.human_decision = { ...job.human_decision };
    }
    await this._persistJobs();
    await this.record('decision.recorded', id, { decision, decided_by: job.human_decision.decided_by });
    return { ok: true, job };
  }

  /** Appends an event to the append-only audit log — never erased, never edited. */
  async record(event, jobId, detail = {}) {
    const entry = { ts: new Date().toISOString(), event, job_id: jobId, detail };
    this.auditEvents.push(entry);
    await appendFile(this.auditPath, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  }

  recentAudit(limit = 200) {
    return this.auditEvents.slice(-limit);
  }
}
