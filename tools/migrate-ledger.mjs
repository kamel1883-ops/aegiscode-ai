#!/usr/bin/env node
/**
 * AegisCode — one-time budget migration (CI ledger → local runtime ledger).
 *
 * Copies the approved CI spend history into a LOCAL data directory so the
 * local server enforces the SAME $10 allowance — never a second one.
 * Three categories are preserved separately (never merged into "confirmed"):
 *
 *   1. provider-confirmed  $0.007320  (smoke $0.000243 + advisory $0.007077)
 *   2. manual-unconfirmed   $0.010000  (hand-entered reconcile, run 40423863576)
 *   3. held-liability       $0.050000  (run 40424188914, usage unrecoverable)
 *
 * Expected totals: used $0.067320, remaining $9.932680 of $10.
 *
 * Safety (fail-closed):
 *  - Dry-run by default: without --confirm it prints the plan and writes
 *    NOTHING. Pass --confirm to write.
 *  - Refuses if the target directory already holds ANY ledger entries —
 *    it never overwrites, merges into, or resets an existing ledger, and
 *    running it twice cannot double-count (the second run refuses).
 *  - Refuses if the target limits differ from the approved $10/$5/$2/$3.
 *  - Writes LEDGER-PROVENANCE.json mapping every entry to its CI run ID.
 *
 * Usage:
 *   node tools/migrate-ledger.mjs --data-dir ./data          # dry-run
 *   node tools/migrate-ledger.mjs --data-dir ./data --confirm # write once
 *
 * No network, no model calls, no secrets — run it before configuring any key.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

import { BudgetManager, APPROVED_LIMITS } from '../server/src/budget.js';

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : (argv[i + 1] ?? null);
}
const DATA_DIR = flagValue('data-dir');
const CONFIRM = argv.includes('--confirm');

if (!DATA_DIR) {
  console.error('BLOCKER: --data-dir is required (e.g. --data-dir ./data). Nothing was written.');
  process.exit(1);
}

/** The audited CI history — amounts verified against run logs. */
const HISTORY = [
  {
    jobKey: 'ci-live-confirmed',
    category: 'provider-confirmed',
    amountUsd: 0.00732,
    live: false,
    sources: [
      { run: 40513303189, note: 'meta-smoke #9: 38 in / 46 out = $0.000243 (request 3129469d-…)' },
      { run: 40520279526, note: 'meta-advisory #1: 637/709 + 488/291 + 246/262 = $0.007077 (requests 31258a20…, 602e36ee…, ae62f24f…)' },
    ],
  },
  {
    jobKey: 'ci-manual-unconfirmed',
    category: 'manual-unconfirmed',
    amountUsd: 0.01,
    live: false,
    sources: [
      { run: 40423863576, note: 'hand-entered reconcile of ci-smoke-40419658611-1 — NOT provider-reported usage' },
    ],
  },
  {
    jobKey: 'ci-held-40424188914-1',
    category: 'held-liability',
    amountUsd: 0.05,
    live: false,
    hold: true,
    sources: [
      { run: 40424188914, note: 'invalid_response with 50-token cap; usage values never recorded' },
      { run: 40512662595, note: 'held as unresolved liability — deducted, live slot released, no model call' },
    ],
  },
];

const EXPECTED_USED = 0.06732;

const budget = new BudgetManager(path.resolve(DATA_DIR));
try {
  await budget.init();
} catch (err) {
  console.error(`BLOCKER: cannot read target ledger — ${err?.message ?? err}. Nothing was written.`);
  process.exit(1);
}

if (JSON.stringify(budget.limits) !== JSON.stringify(APPROVED_LIMITS)) {
  console.error(`BLOCKER: target limits ${JSON.stringify(budget.limits)} differ from approved ${JSON.stringify(APPROVED_LIMITS)}. Nothing was written.`);
  process.exit(1);
}
if (budget.entries.length > 0) {
  console.error(`BLOCKER: target ledger already holds ${budget.entries.length} entr(ies) — refusing to overwrite, merge, or double-count. Nothing was written.`);
  process.exit(1);
}

console.log('Migration plan (CI history → local ledger, same $10 allowance):');
for (const h of HISTORY) {
  console.log(`  - ${h.jobKey}: $${h.amountUsd.toFixed(6)} [${h.category}]${h.hold ? ' → HELD (deducted, no live slot)' : ' → reconciled'}`);
}
console.log(`Expected: used $${EXPECTED_USED.toFixed(6)}, remaining $${(APPROVED_LIMITS.total_usd - EXPECTED_USED).toFixed(6)} of $${APPROVED_LIMITS.total_usd}.`);

if (!CONFIRM) {
  console.log('DRY-RUN: pass --confirm to write. Nothing was written.');
  process.exit(0);
}

await mkdir(path.resolve(DATA_DIR), { recursive: true });
for (const h of HISTORY) {
  const r = await budget.reserve({ jobKey: h.jobKey, amountUsd: h.amountUsd, live: h.live });
  if (!r.ok) {
    console.error(`BLOCKER: reserve failed for ${h.jobKey} — ${r.code}: ${r.error}. Earlier entries in THIS run were not completed; target ledger state: ${budget.entries.length} entr(ies). Re-run only after inspecting ${path.join(path.resolve(DATA_DIR), 'meta-budget.json')}.`);
    process.exit(1);
  }
  if (h.hold) {
    const held = await budget.holdUnresolved({ jobKey: h.jobKey, reason: 'Migrated CI liability (run 40424188914): usage unrecoverable, preserved as deduction' });
    if (!held.ok) {
      console.error(`BLOCKER: hold failed for ${h.jobKey} — ${held.code}. Nothing further was written.`);
      process.exit(1);
    }
  } else {
    const rec = await budget.reconcile({ jobKey: h.jobKey, actualUsd: h.amountUsd });
    if (!rec.ok) {
      console.error(`BLOCKER: reconcile failed for ${h.jobKey} — ${rec.code}. Nothing further was written.`);
      process.exit(1);
    }
  }
}

const provenance = {
  migrated_at: new Date().toISOString(),
  source: 'CI actions/cache ledger meta-budget-v1-* (runs 40419658611…40520279526)',
  allowance_usd: APPROVED_LIMITS.total_usd,
  items: HISTORY.map(({ jobKey, category, amountUsd, sources }) => ({ job_key: jobKey, category, amount_usd: amountUsd, sources })),
  expected_used_usd: EXPECTED_USED,
};
await writeFile(path.join(path.resolve(DATA_DIR), 'LEDGER-PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');

const s = budget.status();
console.log(`MIGRATED: used $${s.used_total_usd} of $${s.approved_total_usd} total — remaining $${s.remaining_total_usd}; held $${s.held_total_usd} in ${s.held_reservations} reservation(s); active live jobs ${s.active_live_jobs}.`);
if (Math.abs(s.used_total_usd - EXPECTED_USED) > 1e-9) {
  console.error(`BLOCKER: migrated total $${s.used_total_usd} does not match expected $${EXPECTED_USED.toFixed(6)} — inspect before any live use.`);
  process.exit(1);
}
console.log('Verify: LEDGER-PROVENANCE.json in the data dir maps every entry to its CI run. CI live execution must stay paused while this runtime owns the budget.');
