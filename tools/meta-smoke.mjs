#!/usr/bin/env node
/**
 * AegisCode — bounded Meta live smoke probe (CI/manual only).
 *
 * ONE tiny synthetic call, no confidential content, no retries:
 *   - input: a fixed ~40-word prompt (far below any ceiling)
 *   - output cap: max_completion_tokens = 50 (Chat Completions field)
 *   - single attempt, 30 s timeout, then stop — success or honest failure
 *   - refuses to run without META_API_KEY; the key is never printed
 *
 * Optional durable accounting (--budget-dir):
 *   - uses the SAME BudgetManager rules as the server ($10 total · $5/day ·
 *     $2/job default · $3 absolute · one active live job · no auto-reset)
 *   - reserves the $0.05 ceiling BEFORE the call; reconciles the
 *     provider-reported actual cost AFTER it
 *   - FAIL-CLOSED: a missing/corrupt ledger refuses the call unless
 *     --first-run is passed for the explicitly approved first session;
 *     timed-out or uncertain usage stays reserved (never auto-released)
 *
 * Exit 0: the call succeeded within the $0.05 ceiling (usage + cost printed).
 * Exit 1: missing secret, budget rejection, HTTP error (exact sanitized
 *         status), timeout, or invalid response — the output IS the report.
 *
 * Cost math uses the verified pricing table:
 *   $1.25 / 1M input tokens · $4.25 / 1M output tokens (standard mode).
 */

import { BudgetManager } from '../server/src/budget.js';

const MODEL = process.env.META_MODEL_ID?.trim() || 'muse-spark-1.3';
const BASE = (process.env.META_BASE_URL?.trim() || 'https://api.meta.ai/v1').replace(/\/+$/, '');
const KEY = process.env.META_API_KEY?.trim() || '';

const MAX_COST_USD = 0.05;
const INPUT_PER_MTOK = 1.25;
const OUTPUT_PER_MTOK = 4.25;

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : (argv[i + 1] ?? null);
}
const BUDGET_DIR = flagValue('budget-dir');
const FIRST_RUN = argv.includes('--first-run');

/** The key must never reach stdout/stderr — not even inside an error body. */
function redact(text) {
  if (!KEY || text === null || text === undefined) return text;
  return String(text).split(KEY).join('[REDACTED]');
}

if (!KEY) {
  console.error('BLOCKER: META_API_KEY is not set.');
  console.error('Add it as a GitHub Actions secret named META_API_KEY — never paste it in chat, issues, or workflow files.');
  process.exit(1);
}

// ---- Durable accounting (fail-closed) ----
let budget = null;
let jobKey = null;
if (BUDGET_DIR) {
  budget = new BudgetManager(BUDGET_DIR);
  try {
    await budget.init();
  } catch (err) {
    console.error(`BLOCKER: budget_ledger_unreadable — ${redact(err?.message ?? err)}. Refusing the call.`);
    process.exit(1);
  }
  if (budget.entries.length === 0 && !FIRST_RUN) {
    console.error('BLOCKER: no budget ledger found in the budget dir — refusing the call (fail-closed).');
    console.error('Re-run with --first-run ONLY for the explicitly approved first validation session.');
    process.exit(1);
  }
  // Manual reconciliation only: explicit, logged, never automatic.
  // Format: --reconcile jobKey:actualUsd (or META_RECONCILE env). Reconciles
  // a RESERVED entry to its provider-confirmed actual, then exits with NO call.
  const reconcileRaw = flagValue('reconcile') ?? (process.env.META_RECONCILE?.trim() || null);
  if (reconcileRaw) {
    const sep = String(reconcileRaw).lastIndexOf(':');
    const rKey = sep === -1 ? '' : String(reconcileRaw).slice(0, sep);
    const rAmt = sep === -1 ? NaN : Number(String(reconcileRaw).slice(sep + 1));
    if (!rKey || !Number.isFinite(rAmt) || rAmt < 0) {
      console.error('BLOCKER: bad reconcile request — expected jobKey:actualUsd with a non-negative amount.');
      process.exit(1);
    }
    const rec = await budget.reconcile({ jobKey: rKey, actualUsd: rAmt });
    if (!rec.ok) {
      console.error(`BLOCKER: reconcile failed — ${rec.code}: ${redact(rec.error)}`);
      process.exit(1);
    }
    const s = budget.status();
    console.log(`budget: reconciled ${rKey} to actual $${rAmt} (provider-confirmed) — remaining $${s.remaining_total_usd} of $${s.approved_total_usd} total`);
    console.log('RECONCILE: DONE — no model call was made.');
    process.exit(0);
  }
  const runId = process.env.GITHUB_RUN_ID ?? 'local';
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? '1';
  jobKey = `ci-smoke-${runId}-${attempt}`;
  const reservation = await budget.reserve({ jobKey, amountUsd: MAX_COST_USD, live: true });
  if (!reservation.ok) {
    console.error(`BLOCKER: budget refused the reservation — ${reservation.code}: ${redact(reservation.error)}`);
    console.error(`Ledger: used $${budget.usedTotalUsd().toFixed(6)} of $${budget.limits.total_usd} total; $${budget.usedTodayUsd().toFixed(6)} of $${budget.limits.daily_usd} today.`);
    process.exit(1);
  }
  console.log(`budget: reserved $${MAX_COST_USD} for ${jobKey} (ceiling, not spend)`);
}

const body = {
  model: MODEL,
  messages: [
    { role: 'system', content: 'Reply with exactly: SMOKE_OK. No other text.' },
    { role: 'user', content: 'Connectivity smoke test. Reply with exactly: SMOKE_OK.' },
  ],
  max_completion_tokens: 50,
};

let res;
try {
  res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
} catch (err) {
  // Uncertain usage stays reserved — fail-closed, reconciled by hand later.
  console.error(`BLOCKER: connection_failed — ${redact(err?.message ?? err)}`);
  if (budget) console.error(`budget: $${MAX_COST_USD} stays reserved for ${jobKey} (uncertain usage is never auto-released)`);
  process.exit(1);
}

if (!res.ok) {
  const detail = redact((await res.text().catch(() => '')).slice(0, 300));
  console.error(`BLOCKER: http_${res.status} — ${detail}`);
  if (res.status === 401) console.error('Meaning: the key is missing, invalid, or revoked.');
  if (res.status === 402 || res.status === 403) {
    console.error('Meaning: the account blocked the request (billing / payment-method requirement is the known suspect).');
  }
  if (budget) {
    await budget.release({ jobKey });
    console.error(`budget: reservation for ${jobKey} released — an HTTP rejection spends nothing`);
  }
  process.exit(1);
}

const data = await res.json().catch(() => null);
const text = data?.choices?.[0]?.message?.content ?? '';
const promptTokens = data?.usage?.prompt_tokens ?? null;
const completionTokens = data?.usage?.completion_tokens ?? null;
const requestId =
  res.headers.get('x-request-id') ?? res.headers.get('x-requestid') ?? data?.id ?? '(not provided)';

if (promptTokens === null || completionTokens === null || !text) {
  // Extended shape diagnostic: key names, finish reason, usage NUMBERS
  // (counts are safe and needed for accounting) — never content or secrets.
  const ch0 = Array.isArray(data?.choices) ? data.choices[0] : undefined;
  const msg = ch0 && typeof ch0.message === 'object' && ch0.message !== null ? ch0.message : undefined;
  const diag = {
    finish_reason: ch0?.finish_reason ?? null,
    message_keys: msg ? Object.keys(msg).slice(0, 25) : typeof msg,
    content_type: msg ? (Array.isArray(msg.content) ? `array[${msg.content.length}]` : typeof msg.content) : 'n/a',
    usage_values: data?.usage && typeof data.usage === 'object'
      ? { prompt_tokens: data.usage.prompt_tokens ?? null, completion_tokens: data.usage.completion_tokens ?? null, total_tokens: data.usage.total_tokens ?? null }
      : null,
    text_len: typeof text === 'string' ? text.length : typeof text,
  };
  console.error('BLOCKER: invalid_response — provider usage or text missing from the reply.');
  console.error(`diagnostic: ${redact(JSON.stringify(diag))}`);
  if (budget && Number.isFinite(promptTokens) && Number.isFinite(completionTokens)) {
    // The spend IS known even though the text is unusable: reconcile it so the
    // ledger stays truthful and later runs are not blocked. The BLOCKER stands.
    const actual = (promptTokens / 1e6) * INPUT_PER_MTOK + (completionTokens / 1e6) * OUTPUT_PER_MTOK;
    await budget.reconcile({ jobKey, actualUsd: actual });
    console.log(`budget: reconciled known usage to actual $${actual.toFixed(6)} for ${jobKey} (text unusable, spend accounted)`);
  } else if (budget) {
    console.error(`budget: $${MAX_COST_USD} stays reserved for ${jobKey} (uncertain usage is never auto-released)`);
  }
  process.exit(1);
}

const cost = (promptTokens / 1e6) * INPUT_PER_MTOK + (completionTokens / 1e6) * OUTPUT_PER_MTOK;
console.log(`model: ${MODEL}`);
console.log(`reply: ${redact(text.trim().slice(0, 80))}`);
console.log(`usage: ${promptTokens} in / ${completionTokens} out (provider-reported)`);
console.log(`cost: $${cost.toFixed(6)} (ceiling $${MAX_COST_USD})`);
console.log(`request_id: ${redact(String(requestId))}`);

if (cost > MAX_COST_USD) {
  console.error(`BLOCKER: cost $${cost.toFixed(6)} exceeds the $${MAX_COST_USD} smoke ceiling. Stopping for approval.`);
  if (budget) console.error(`budget: $${MAX_COST_USD} stays reserved for ${jobKey} (reconcile by hand)`);
  process.exit(1);
}

if (budget) {
  await budget.reconcile({ jobKey, actualUsd: cost });
  const s = budget.status();
  console.log(`budget: reconciled actual $${cost.toFixed(6)} — remaining $${s.remaining_total_usd} of $${s.approved_total_usd} total`);
}
console.log('SMOKE: PASS — live connection verified within budget. No secret was printed.');
