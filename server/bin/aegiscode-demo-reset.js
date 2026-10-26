#!/usr/bin/env node
/**
 * AegisCode — repeatable demo reset.
 *
 * Clears demo content so the next run starts clean:
 *   - jobs.json            (verification jobs + embedded reports)
 *   - meta-advisories.json (advisory cycles, candidates, summaries)
 *
 * NEVER touched (not reset, not erased):
 *   - meta-budget.json     (spending history — approvals would be voided otherwise)
 *   - meta-live-verified.json (live-verification flag)
 *   - accounts.json        (logins must keep working across demos)
 *   - audit.jsonl          (append-only: the reset itself is RECORDED there)
 *
 * Usage:
 *   node server/bin/aegiscode-demo-reset.js [--data ./data] --confirm
 *
 * Stop the server first: the queue holds jobs in memory, so resetting files
 * under a running server would desynchronize it. The script refuses to run
 * without --confirm.
 */

import { readFile, writeFile, rename, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next !== undefined && !next.startsWith('--') ? next : true;
}

if (!args.includes('--confirm')) {
  console.error('Refusing: pass --confirm to reset the demo content.');
  console.error('Usage: node server/bin/aegiscode-demo-reset.js [--data ./data] --confirm');
  process.exit(2);
}

const dataDir = path.resolve(String(flag('data', './data')));
await mkdir(dataDir, { recursive: true });

async function atomicWrite(file, obj) {
  const tmp = `${file}.tmp-${randomUUID().slice(0, 8)}`;
  await writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

function countJobs() {
  return readFile(path.join(dataDir, 'jobs.json'), 'utf8')
    .then((raw) => Object.keys(JSON.parse(raw).jobs ?? {}).length)
    .catch(() => 0);
}
function countAdvisories() {
  return readFile(path.join(dataDir, 'meta-advisories.json'), 'utf8')
    .then((raw) => Object.keys(JSON.parse(raw).advisories ?? {}).length)
    .catch(() => 0);
}
function budgetSummary() {
  return readFile(path.join(dataDir, 'meta-budget.json'), 'utf8')
    .then((raw) => {
      const entries = JSON.parse(raw).entries ?? [];
      return `${entries.length} entries (PRESERVED)`;
    })
    .catch(() => 'no budget file yet (nothing spent)');
}

const before = { jobs: await countJobs(), advisories: await countAdvisories() };
const budget = await budgetSummary();

await atomicWrite(path.join(dataDir, 'jobs.json'), { jobs: {} });
await atomicWrite(path.join(dataDir, 'meta-advisories.json'), { advisories: {} });

// The reset is recorded — the audit log is append-only and is never cleared.
await appendFile(
  path.join(dataDir, 'audit.jsonl'),
  `${JSON.stringify({
    ts: new Date().toISOString(),
    event: 'demo.reset',
    job_id: null,
    detail: { cleared_jobs: before.jobs, cleared_advisories: before.advisories, budget_untouched: true },
  })}\n`,
  'utf8',
);

console.log(`Demo reset complete in ${dataDir}:`);
console.log(`  cleared: ${before.jobs} jobs, ${before.advisories} advisories`);
console.log(`  preserved: budget (${budget}), accounts, audit log, live-verified flag`);
