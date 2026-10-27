/**
 * AegisCode — centralized spending controls for the Meta advisory integration
 *
 * Every live model call must pass through this manager. The rules, in order:
 *
 *  1. Approved ceilings (never auto-reset, never auto-increased):
 *       total $10 · daily $5 · default $2/job · absolute $3/job.
 *  2. A "job" is one complete advisory cycle (explain + patch + summarize,
 *     with any retries included). Splitting a cycle into sub-calls must not
 *     bypass the cap — one reservation covers the whole cycle.
 *  3. Before any call: reserve the conservative maximum atomically. If the
 *     remaining budget cannot cover it, the call is rejected — never reduced
 *     silently and never attempted "anyway".
 *  4. After the call: reconcile the reservation with the provider-reported
 *     usage. Until provider billing confirms, the recorded cost is marked
 *     estimated. Uncertain or timed-out usage stays reserved.
 *  5. One active live reservation at a time — no background parallel spend.
 *  6. Accounting persists across restarts (plain JSON, atomic write).
 *
 * Mock calls cost $0 and reserve nothing, but they are still recorded — the
 * accounting never claims a spend that did not happen.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** The approved spending ceilings — spending ceilings, not target costs. */
export const APPROVED_LIMITS = {
  total_usd: 10,
  daily_usd: 5,
  per_job_default_usd: 2,
  per_job_absolute_usd: 3,
};

const BUDGET_FILE = 'meta-budget.json';

export class BudgetManager {
  /**
   * @param {string} dir storage directory (survives restarts)
   * @param {{limits?:object, now?:()=>Date}} [opts]
   */
  constructor(dir, { limits = APPROVED_LIMITS, now = () => new Date() } = {}) {
    this.path = path.join(dir, BUDGET_FILE);
    this.limits = limits;
    this.now = now;
    /** @type {Array<{job_key:string, reserved_usd:number, state:'reserved'|'held'|'reconciled', actual_usd:number|null, live:boolean, created_at:string, reconciled_at:string|null, held_at:string|null, hold_reason:string|null}>} */
    this.entries = [];
  }

  async init() {
    await mkdir(path.dirname(this.path), { recursive: true });
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      this.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      this.entries = [];
    }
  }

  async _persist() {
    const payload = { limits: this.limits, entries: this.entries };
    const tmp = `${this.path}.tmp-${randomUUID().slice(0, 8)}`;
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(tmp, this.path);
  }

  _amount(entry) {
    // Both open reservations and held historical liabilities count toward the
    // ceilings. Only a reconciled entry counts at its provider-reported actual.
    // Reasoning tokens are never added separately: costUsd prices the whole
    // completion_tokens figure once (see server/src/meta-pricing.js).
    return entry.state === 'reconciled' ? (entry.actual_usd ?? 0) : entry.reserved_usd;
  }

  _utcDay(iso) {
    return String(iso).slice(0, 10);
  }

  usedTotalUsd() {
    return this.entries.reduce((sum, e) => sum + this._amount(e), 0);
  }

  usedTodayUsd() {
    const today = this._utcDay(this.now().toISOString());
    return this.entries
      .filter((e) => this._utcDay(e.created_at) === today)
      .reduce((sum, e) => sum + this._amount(e), 0);
  }

  usedByJobUsd(jobKey) {
    return this.entries.filter((e) => e.job_key === jobKey).reduce((sum, e) => sum + this._amount(e), 0);
  }

  activeLiveJobs() {
    // 'held' entries are historical liabilities: still deducted from the
    // totals, but they no longer occupy the single live-job slot. Only an
    // entry with state 'reserved' blocks a new live reservation.
    return this.entries.filter((e) => e.state === 'reserved' && e.live === true);
  }

  heldEntries() {
    return this.entries.filter((e) => e.state === 'held');
  }

  getEntry(jobKey) {
    return this.entries.find((e) => e.job_key === jobKey) ?? null;
  }

  /**
   * Atomically reserves the conservative maximum for one complete job cycle.
   * @param {{jobKey:string, amountUsd:number, live?:boolean, approvedExtra?:boolean}} params
   * @returns {Promise<{ok:boolean, code?:string, error?:string}>}
   */
  async reserve({ jobKey, amountUsd, live = true, approvedExtra = false }) {
    if (typeof jobKey !== 'string' || jobKey === '' || !Number.isFinite(amountUsd) || amountUsd <= 0) {
      return { ok: false, code: 'invalid_reservation', error: 'A job key and a positive amount are required.' };
    }
    if (this.getEntry(jobKey)) {
      return { ok: false, code: 'job_already_reserved', error: 'This job already holds a reservation; splitting a cycle is not allowed.' };
    }
    if (amountUsd > this.limits.per_job_absolute_usd) {
      return { ok: false, code: 'job_absolute_exceeded', error: `The reservation exceeds the absolute per-job maximum ($${this.limits.per_job_absolute_usd}).` };
    }
    if (amountUsd > this.limits.per_job_default_usd && !approvedExtra) {
      return { ok: false, code: 'approval_required', error: `Above the default per-job maximum ($${this.limits.per_job_default_usd}) — explicit approval is required.` };
    }
    if (this.usedTotalUsd() + amountUsd > this.limits.total_usd) {
      return { ok: false, code: 'total_budget_exhausted', error: 'The approved total budget cannot cover this job.' };
    }
    if (this.usedTodayUsd() + amountUsd > this.limits.daily_usd) {
      return { ok: false, code: 'daily_budget_exhausted', error: 'The approved daily budget cannot cover this job.' };
    }
    if (live && this.activeLiveJobs().length >= 1) {
      return { ok: false, code: 'another_live_job_active', error: 'One active live job at a time — finish or cancel the current one first.' };
    }

    this.entries.push({
      job_key: jobKey,
      reserved_usd: amountUsd,
      state: 'reserved',
      actual_usd: null,
      live,
      created_at: this.now().toISOString(),
      reconciled_at: null,
    });
    await this._persist();
    return { ok: true };
  }

  /**
   * Moves an UNRESOLVED reservation to 'held' after its execution is known
   * to be finished (e.g. its GitHub Actions run is completed) but its
   * provider usage cannot be recovered. The amount stays deducted from the
   * totals — it is never zeroed and never erased — but it no longer blocks
   * the single live-job slot. A held entry can later be reconciled to a
   * provider-confirmed actual or left held indefinitely.
   */
  async holdUnresolved({ jobKey, reason = '' }) {
    const entry = this.getEntry(jobKey);
    if (!entry) return { ok: false, code: 'no_reservation', error: 'No reservation to hold.' };
    if (entry.state !== 'reserved') return { ok: false, code: 'not_open', error: 'Only an open reservation can be held.' };
    entry.state = 'held';
    entry.held_at = this.now().toISOString();
    entry.hold_reason = String(reason).slice(0, 500);
    await this._persist();
    return { ok: true };
  }

  /** Reconciles a reservation with the provider-reported actual cost. */
  async reconcile({ jobKey, actualUsd }) {
    const entry = this.getEntry(jobKey);
    if (!entry) return { ok: false, code: 'no_reservation', error: 'No reservation to reconcile.' };
    if (entry.state === 'reconciled') return { ok: false, code: 'already_reconciled', error: 'This reservation is already reconciled.' };
    if (!Number.isFinite(actualUsd) || actualUsd < 0) {
      return { ok: false, code: 'invalid_actual', error: 'A non-negative actual cost is required.' };
    }
    entry.state = 'reconciled';
    entry.actual_usd = actualUsd;
    entry.reconciled_at = this.now().toISOString();
    await this._persist();
    return { ok: true };
  }

  /** Releases a reservation (cycle failed or was cancelled before any spend). */
  async release({ jobKey }) {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !(e.job_key === jobKey && e.state === 'reserved'));
    const released = this.entries.length < before;
    if (released) await this._persist();
    return { ok: released, code: released ? undefined : 'no_open_reservation' };
  }

  /** A read-only accounting snapshot for the UI and the audit trail. */
  status() {
    const held = this.heldEntries();
    return {
      approved_total_usd: this.limits.total_usd,
      used_total_usd: Number(this.usedTotalUsd().toFixed(6)),
      remaining_total_usd: Number((this.limits.total_usd - this.usedTotalUsd()).toFixed(6)),
      daily_limit_usd: this.limits.daily_usd,
      used_today_usd: Number(this.usedTodayUsd().toFixed(6)),
      remaining_today_usd: Number((this.limits.daily_usd - this.usedTodayUsd()).toFixed(6)),
      per_job_default_usd: this.limits.per_job_default_usd,
      per_job_absolute_usd: this.limits.per_job_absolute_usd,
      open_reservations: this.entries.filter((e) => e.state === 'reserved').length,
      active_live_jobs: this.activeLiveJobs().length,
      held_reservations: held.length,
      held_total_usd: Number(held.reduce((sum, e) => sum + e.reserved_usd, 0).toFixed(6)),
    };
  }
}
