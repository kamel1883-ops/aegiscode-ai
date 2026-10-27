import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BudgetManager, APPROVED_LIMITS } from '../src/budget.js';

/**
 * Spending-control acceptance tests — every ceiling the owner approved:
 *
 *  1. One reservation covers the whole job cycle; splitting is impossible.
 *  2. $2 default needs approval above it; $3 absolute is never exceeded.
 *  3. Total ($10) and daily ($5) exhaustion reject the call up front.
 *  4. One active live reservation at a time.
 *  5. Accounting persists across restarts and is never auto-reset.
 *  6. Reconciliation replaces the reservation with provider-reported usage;
 *     a cancelled cycle releases it.
 */

async function withManager(fn, { limits = APPROVED_LIMITS, clock = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-budget-'));
  const now = clock ?? (() => new Date());
  const manager = new BudgetManager(dir, { limits, now });
  await manager.init();
  try {
    await fn({ manager, dir, now });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

test('the approved ceilings are exactly the ones the owner approved', () => {
  assert.deepEqual(APPROVED_LIMITS, {
    total_usd: 10,
    daily_usd: 5,
    per_job_default_usd: 2,
    per_job_absolute_usd: 3,
  });
});

test('one reservation covers the whole cycle: a second reservation for the same job is rejected', async () => {
  await withManager(async ({ manager }) => {
    const first = await manager.reserve({ jobKey: 'adv-1', amountUsd: 0.05, live: true });
    assert.equal(first.ok, true);

    // Splitting the same cycle into sub-calls may not bypass the budget.
    const second = await manager.reserve({ jobKey: 'adv-1', amountUsd: 0.01, live: true });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'job_already_reserved');
    assert.equal(manager.status().open_reservations, 1);
  });
});

test('above the default per-job maximum: approval required; above the absolute maximum: always rejected', async () => {
  await withManager(async ({ manager }) => {
    const needsApproval = await manager.reserve({ jobKey: 'adv-2', amountUsd: 2.5, live: true });
    assert.equal(needsApproval.ok, false);
    assert.equal(needsApproval.code, 'approval_required');

    const approved = await manager.reserve({ jobKey: 'adv-2', amountUsd: 2.5, live: true, approvedExtra: true });
    assert.equal(approved.ok, true, 'an explicitly approved overage is allowed up to $3');

    const overAbsolute = await manager.reserve({ jobKey: 'adv-3', amountUsd: 3.01, live: true, approvedExtra: true });
    assert.equal(overAbsolute.ok, false);
    assert.equal(overAbsolute.code, 'job_absolute_exceeded');
  });
});

test('budget exhaustion: the total and the daily ceiling both reject up front', async () => {
  // Total exhaustion with a daily ceiling that does not interfere.
  await withManager(async ({ manager }) => {
    const r1 = await manager.reserve({ jobKey: 't1', amountUsd: 3, live: false, approvedExtra: true });
    assert.equal(r1.ok, true);
    const r2 = await manager.reserve({ jobKey: 't2', amountUsd: 3, live: false, approvedExtra: true });
    assert.equal(r2.ok, true);
    const r3 = await manager.reserve({ jobKey: 't3', amountUsd: 3, live: false, approvedExtra: true });
    assert.equal(r3.ok, true);
    // used 9 of 10 — the last $1 cannot cover another $2.
    const r4 = await manager.reserve({ jobKey: 't4', amountUsd: 2, live: false, approvedExtra: true });
    assert.equal(r4.ok, false);
    assert.equal(r4.code, 'total_budget_exhausted');
  }, { limits: { ...APPROVED_LIMITS, daily_usd: 10 } });

  // Daily exhaustion with a total that does not interfere.
  await withManager(async ({ manager }) => {
    const r1 = await manager.reserve({ jobKey: 'd1', amountUsd: 3, live: false, approvedExtra: true });
    assert.equal(r1.ok, true);
    const r2 = await manager.reserve({ jobKey: 'd2', amountUsd: 2, live: false, approvedExtra: true });
    assert.equal(r2.ok, true);
    const r3 = await manager.reserve({ jobKey: 'd3', amountUsd: 0.05, live: false });
    assert.equal(r3.ok, false);
    assert.equal(r3.code, 'daily_budget_exhausted');
  }, { limits: { ...APPROVED_LIMITS, total_usd: 100 } });
});

test('one active live job at a time — a second live reservation waits', async () => {
  await withManager(async ({ manager }) => {
    const first = await manager.reserve({ jobKey: 'live-1', amountUsd: 0.05, live: true });
    assert.equal(first.ok, true);

    const second = await manager.reserve({ jobKey: 'live-2', amountUsd: 0.05, live: true });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'another_live_job_active');

    // Non-live (mock-cycle accounting) entries do not take the live slot.
    const mock = await manager.reserve({ jobKey: 'mock-1', amountUsd: 0.05, live: false });
    assert.equal(mock.ok, true);

    // Cancelling the live cycle frees the slot.
    await manager.release({ jobKey: 'live-1' });
    const third = await manager.reserve({ jobKey: 'live-2', amountUsd: 0.05, live: true });
    assert.equal(third.ok, true);
  });
});

test('accounting persists across restarts and is never auto-reset', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-budget-persist-'));
  try {
    const m1 = new BudgetManager(dir);
    await m1.init();
    await m1.reserve({ jobKey: 'p1', amountUsd: 0.05, live: true });
    await m1.reconcile({ jobKey: 'p1', actualUsd: 0.0403 });

    // A "restart": a brand-new manager over the same directory.
    const m2 = new BudgetManager(dir);
    await m2.init();
    const status = m2.status();
    assert.equal(status.used_total_usd, 0.0403, 'the reconciled spend survives a restart');
    assert.equal(status.remaining_total_usd, Number((10 - 0.0403).toFixed(6)));

    // The file on disk is real, human-auditable accounting.
    const raw = JSON.parse(await readFile(path.join(dir, 'meta-budget.json'), 'utf8'));
    assert.equal(raw.entries.length, 1);
    assert.equal(raw.entries[0].state, 'reconciled');
    assert.equal(raw.entries[0].actual_usd, 0.0403);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('reconciliation uses provider-reported usage; a cancelled cycle releases the reservation', async () => {
  await withManager(async ({ manager }) => {
    await manager.reserve({ jobKey: 'r1', amountUsd: 0.05, live: true });
    const rec = await manager.reconcile({ jobKey: 'r1', actualUsd: 0.0123 });
    assert.equal(rec.ok, true);
    assert.equal(manager.status().used_total_usd, 0.0123, 'actual usage replaces the reservation');
    assert.equal(manager.status().open_reservations, 0);

    // Reconciling twice never double-charges.
    const again = await manager.reconcile({ jobKey: 'r1', actualUsd: 5 });
    assert.equal(again.ok, false);
    assert.equal(again.code, 'already_reconciled');
    assert.equal(manager.status().used_total_usd, 0.0123);

    // A cancelled cycle releases its reservation entirely.
    await manager.reserve({ jobKey: 'r2', amountUsd: 0.05, live: true });
    const released = await manager.release({ jobKey: 'r2' });
    assert.equal(released.ok, true);
    assert.equal(manager.status().used_total_usd, 0.0123);
    assert.equal(manager.status().active_live_jobs, 0);
  });
});

test('the daily bucket rolls over in UTC — yesterday’s spend is not today’s', async () => {
  const day = (d) => () => new Date(Date.UTC(2026, 9, d, 12, 0, 0));
  await withManager(async ({ manager }) => {
    await manager.reserve({ jobKey: 'y1', amountUsd: 3, live: false, approvedExtra: true });
    await manager.reserve({ jobKey: 'y2', amountUsd: 2, live: false, approvedExtra: true });
    assert.equal(manager.status().used_today_usd, 5);

    // "Tomorrow": the same reservations no longer count against today.
    const tomorrow = new BudgetManager(path.dirname(manager.path), { now: day(27) });
    await tomorrow.init();
    assert.equal(tomorrow.status().used_today_usd, 0);
    assert.equal(tomorrow.status().used_total_usd, 5, 'the total ceiling still counts all history');
  }, { clock: day(26) });
});
