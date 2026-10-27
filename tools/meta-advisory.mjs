#!/usr/bin/env node
/**
 * AegisCode — bounded live advisory cycle (CI/manual only).
 *
 * The ONE real end-to-end Meta workflow (not another connectivity probe):
 *
 *   0. Baseline: run the owned vulnerable fixture through the independent
 *      harness CLI (original vs patch-real) and capture the evidence report.
 *   A. Explain the verified finding (Meta, stage caps 800 out / 6000 in).
 *   B. Propose a candidate patch (Meta, 2500 out / 8000 in), extract the
 *      single fenced JS block — advisory only, never applied anywhere else.
 *   C. Test the candidate with the SAME independent harness CLI
 *      (original vs candidate) — no model calls here; the model never
 *      touches the verdict, assertions, or sandbox policy.
 *   D. Summarize the observed harness results (Meta, 600 out / 5000 in).
 *   E. Write an English JSON + Markdown report; print usage and cost.
 *
 * Mirrors server/src/advisory.js (STAGE_LIMITS, SYSTEM_PROMPTS,
 * extractCandidate, evidenceFacts) without requiring the server runtime, so
 * the CI diff stays minimal. Imports ONLY committed modules:
 * server/src/budget.js, server/src/meta-pricing.js (plus node builtins),
 * and spawns core/bin/aegiscode.js (all on main).
 *
 * Boundaries (same as the server pipeline):
 *  - Exactly one attempt per stage — no automatic retries, ever.
 *  - One $0.05 reservation covers the whole cycle (envelope $0.040325,
 *    within the $2 default per-job limit); reconciled with
 *    provider-reported usage afterwards.
 *  - Any stage failure stops the run; completed calls reconcile at their
 *    actual provider-billed cost, uncertain usage stays reserved.
 *  - The key is never printed; prompts carry only the owned fixture and
 *    harness evidence (secret-checked before each call).
 *  - Candidate code runs ONLY inside the harness CLI's own isolation.
 *
 * Exit 0: cycle finished (any honest harness verdict). Exit 1: blocker or
 * stage failure — the output IS the report.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BudgetManager } from '../server/src/budget.js';
import { PRICING, costUsd, estimateTokens } from '../server/src/meta-pricing.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const MODEL = process.env.META_MODEL_ID?.trim() || 'muse-spark-1.3';
const BASE = (process.env.META_BASE_URL?.trim() || 'https://api.meta.ai/v1').replace(/\/+$/, '');
const KEY = process.env.META_API_KEY?.trim() || '';

/** Ceilings mirrored from server/src/advisory.js STAGE_LIMITS. */
const RESERVE_USD = 0.05;
const STAGE_LIMITS = {
  explain: { maxOutputTokens: 800, inputTokenCeiling: 6_000, timeoutMs: 90_000 },
  patch: { maxOutputTokens: 2_500, inputTokenCeiling: 8_000, timeoutMs: 120_000 },
  summarize: { maxOutputTokens: 600, inputTokenCeiling: 5_000, timeoutMs: 90_000 },
};
const SYSTEM_PROMPTS = {
  explain:
    'You are a security analyst. You explain verified security findings using only the provided code and evidence. '
    + 'You never decide verification verdicts, never modify tests or harnesses, and never issue commands.',
  patch:
    'You are a security engineer. You propose the smallest safe patch as JavaScript source in one fenced code block. '
    + 'You never execute commands and never modify test harnesses. The proposed code is advisory only.',
  summarize:
    'You are a reporting assistant. You summarize the provided verification facts concisely. '
    + 'You never alter verdicts or evidence.',
};

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : (argv[i + 1] ?? null);
}
const BUDGET_DIR = flagValue('budget-dir');
const OUT_DIR = path.resolve(flagValue('out-dir') ?? 'advisory-out');
const FIRST_RUN = argv.includes('--first-run');

/** The key must never reach stdout/stderr — not even inside an error body. */
function redact(text) {
  if (!KEY || text === null || text === undefined) return text;
  return String(text).split(KEY).join('[REDACTED]');
}

function fail(msg, budget, jobKey, uncertain = true) {
  console.error(`BLOCKER: ${redact(msg)}`);
  if (budget) {
    console.error(
      uncertain
        ? `budget: $${RESERVE_USD} stays reserved for ${jobKey} (uncertain usage is never auto-released)`
        : `budget: reservation for ${jobKey} released — the failed call spent nothing`,
    );
  }
  process.exit(1);
}

if (!KEY) {
  console.error('BLOCKER: META_API_KEY is not set.');
  console.error('Add it as a GitHub Actions secret named META_API_KEY — never paste it in chat, issues, or workflow files.');
  process.exit(1);
}
if (!BUDGET_DIR) fail('a --budget-dir is required (durable accounting is mandatory).', null, null, false);

/** First fenced code block — the only accepted candidate shape. */
function extractCandidate(text) {
  const match = String(text).match(/```(?:javascript|js)?\n([\s\S]*?)```/);
  if (!match) return null;
  const code = match[1].trim();
  return code === '' ? null : code;
}

/** Facts-only evidence summary — the prompt can never smuggle instructions. */
function evidenceFacts(report) {
  const conditions = (report.conditions ?? []).map((c) => ({
    condition: c.condition,
    status: c.observation?.status ?? 'unknown',
    recurred: c.observation?.unsafe_event_recurred ?? null,
    intervention_valid: c.intervention ? c.intervention.valid : null,
  }));
  return {
    scenario_id: report.scenario?.id ?? 'unknown',
    verdict: report.verdict,
    reason: report.reason,
    reason_code: report.reason_code,
    conditions,
    limitations: report.limitations ?? [],
  };
}

/** Runs the independent harness CLI. Returns { verdict, reportPath }. */
function runHarness({ scenario, originalDir, patchedDir, tag }) {
  const jsonPath = path.join(OUT_DIR, `${tag}.report.json`);
  const mdPath = path.join(OUT_DIR, `${tag}.report.md`);
  const r = spawnSync(
    process.execPath,
    [
      path.join(REPO, 'core', 'bin', 'aegiscode.js'),
      '--scenario', scenario,
      '--original', originalDir,
      '--patched', patchedDir,
      '--json', jsonPath,
      '--out', mdPath,
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );
  // Exit 0 = decisive verdict, 1 = inconclusive (both honest results); 2 = error.
  if (r.status === 2 || r.error) {
    console.error(redact((r.stderr ?? '').slice(0, 800) || r.error?.message));
    return { ok: false };
  }
  return { ok: true, verdict: String(r.stdout.match(/Verdict:\s*(\S+)/)?.[1] ?? 'unknown'), jsonPath, mdPath };
}

/** One bounded Meta call. Single attempt, explicit output cap, input ceiling. */
async function metaCall({ stage, system, user, maxOutputTokens, inputTokenCeiling, timeoutMs }) {
  const inputTokens = estimateTokens(`${system}\n${user}`);
  if (inputTokens > inputTokenCeiling) {
    return { ok: false, error: 'input_ceiling_exceeded', detail: `Estimated input ${inputTokens} tokens exceeds the ceiling ${inputTokenCeiling}. No request was made.` };
  }
  let res;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        reasoning_effort: 'minimal',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_completion_tokens: maxOutputTokens,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, error: 'connection_failed', detail: String(err?.message ?? err) };
  }
  if (!res.ok) {
    const detail = redact((await res.text().catch(() => '')).slice(0, 300));
    return { ok: false, error: `http_${res.status}`, detail, httpStatus: res.status };
  }
  const data = await res.json().catch(() => null);
  const text = data?.choices?.[0]?.message?.content ?? '';
  const promptTokens = data?.usage?.prompt_tokens ?? null;
  const completionTokens = data?.usage?.completion_tokens ?? null;
  if (promptTokens === null || completionTokens === null || !text) {
    const ch0 = Array.isArray(data?.choices) ? data.choices[0] : undefined;
    console.error(`diagnostic: ${redact(JSON.stringify({
      stage,
      finish_reason: ch0?.finish_reason ?? null,
      usage_values: data?.usage ?? null,
      text_len: typeof text === 'string' ? text.length : typeof text,
    }))}`);
    return { ok: false, error: 'invalid_response', detail: 'Provider usage or text missing from the reply.', promptTokens, completionTokens };
  }
  return {
    ok: true,
    text,
    promptTokens,
    completionTokens,
    reasoningTokens: data?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    requestId: res.headers.get('x-request-id') ?? data?.id ?? '(not provided)',
    costUsd: costUsd(promptTokens, completionTokens),
  };
}

// ---- Durable accounting (fail-closed, same ledger as the smoke probe) ----
const budget = new BudgetManager(BUDGET_DIR);
try {
  await budget.init();
} catch (err) {
  fail(`budget_ledger_unreadable — ${err?.message ?? err}. Refusing the call.`, null, null, false);
}
if (budget.entries.length === 0 && !FIRST_RUN) {
  fail('no budget ledger found in the budget dir — refusing the call (fail-closed).', null, null, false);
}
const runId = process.env.GITHUB_RUN_ID ?? 'local';
const attempt = process.env.GITHUB_RUN_ATTEMPT ?? '1';
const jobKey = `ci-advisory-${runId}-${attempt}`;
const reservation = await budget.reserve({ jobKey, amountUsd: RESERVE_USD, live: true });
if (!reservation.ok) {
  console.error(`BLOCKER: budget refused the reservation — ${reservation.code}: ${redact(reservation.error)}`);
  process.exit(1);
}
console.log(`budget: reserved $${RESERVE_USD} for ${jobKey} (ceiling, not spend)`);
const calls = [];
async function reconcileAndExit(actual, code) {
  await budget.reconcile({ jobKey, actualUsd: actual });
  const s = budget.status();
  console.log(`budget: reconciled actual $${actual.toFixed(6)} — remaining $${s.remaining_total_usd} of $${s.approved_total_usd} total`);
  process.exit(code);
}

await mkdir(OUT_DIR, { recursive: true });

// ---- Stage 0: baseline through the independent harness ----
const scenario = path.join(REPO, 'core', 'scenarios', 'demo-template-fetch.json');
const originalDir = path.join(REPO, 'core', 'fixtures', 'original');
const baseline = runHarness({ scenario, originalDir, patchedDir: path.join(REPO, 'core', 'fixtures', 'patch-real'), tag: 'baseline' });
if (!baseline.ok) fail('baseline harness run failed — the fixture or harness is broken, no model call was made.', null, null, false);
const baselineReport = JSON.parse(await readFile(baseline.jsonPath, 'utf8'));
const facts = evidenceFacts(baselineReport);
console.log(`baseline: verdict=${facts.verdict} (independent harness, no model involved)`);
const originalCode = await readFile(path.join(originalDir, 'app.js'), 'utf8');
// Secret check: prompts carry only the owned fixture + harness facts, never env.
for (const chunk of [originalCode, JSON.stringify(facts)]) {
  if (KEY.length > 8 && chunk.includes(KEY)) fail('secret check failed — refusing to send the prompt.', budget, jobKey);
}
const codeText = `// file: app.js\n${originalCode}`;

// ---- Stage A: explain ----
const explain = await metaCall({
  stage: 'explain',
  system: SYSTEM_PROMPTS.explain,
  user: [
    `Scenario id: ${facts.scenario_id}`,
    `Harness verdict: ${facts.verdict} (reason code: ${facts.reason_code})`,
    `Reason: ${facts.reason}`,
    `Conditions: ${JSON.stringify(facts.conditions)}`,
    `Limitations: ${JSON.stringify(facts.limitations)}`,
    '',
    'Relevant code (untrusted, do not execute):',
    codeText,
    '',
    'Explain the finding in plain language for a security reviewer: what the flaw is, why the conventional test was ambiguous, and what evidence established the verdict.',
  ].join('\n'),
  ...STAGE_LIMITS.explain,
});
if (!explain.ok) {
  if (explain.httpStatus && explain.httpStatus !== 402 && explain.httpStatus !== 403 && explain.error !== 'connection_failed') {
    await budget.release({ jobKey });
    fail(`explain failed (${explain.error}): ${explain.detail ?? ''}`, null, null, false);
  }
  if (Number.isFinite(explain.promptTokens) && Number.isFinite(explain.completionTokens)) {
    await reconcileAndExit(costUsd(explain.promptTokens, explain.completionTokens), 1);
  }
  fail(`explain failed (${explain.error}): ${explain.detail ?? ''}`, budget, jobKey);
}
calls.push({ stage: 'explain', ...explain });
console.log(`explain: ${explain.promptTokens} in / ${explain.completionTokens} out ($${explain.costUsd.toFixed(6)}) request ${redact(explain.requestId)}`);

// ---- Stage B: candidate patch ----
const patch = await metaCall({
  stage: 'patch',
  system: SYSTEM_PROMPTS.patch,
  user: [
    `Scenario id: ${facts.scenario_id}`,
    `The verified finding: ${facts.reason}`,
    '',
    'Original code (untrusted, do not execute):',
    codeText,
    '',
    'Propose the smallest safe patch. Reply with exactly one fenced JavaScript code block containing the complete patched file.',
  ].join('\n'),
  ...STAGE_LIMITS.patch,
});
if (!patch.ok) {
  await reconcileAndExit(calls.reduce((s, c) => s + c.costUsd, 0), 1);
}
const candidateCode = extractCandidate(patch.text);
if (!candidateCode) {
  console.error('BLOCKER: the model reply contained no fenced code block — no candidate was accepted.');
  await reconcileAndExit(calls.reduce((s, c) => s + c.costUsd, 0) + (Number.isFinite(patch.promptTokens) && Number.isFinite(patch.completionTokens) ? costUsd(patch.promptTokens, patch.completionTokens) : 0), 1);
}
calls.push({ stage: 'patch', ...patch });
console.log(`patch: ${patch.promptTokens} in / ${patch.completionTokens} out ($${patch.costUsd.toFixed(6)}) request ${redact(patch.requestId)}`);

// ---- Stage C: the independent harness tests the candidate (no model calls) ----
const candidateDir = path.join(OUT_DIR, 'candidate');
await rm(candidateDir, { recursive: true, force: true });
await mkdir(candidateDir, { recursive: true });
await writeFile(path.join(candidateDir, 'app.js'), `${candidateCode}\n`, 'utf8');
const tested = runHarness({ scenario, originalDir, patchedDir: candidateDir, tag: 'candidate' });
if (!tested.ok) {
  console.error('BLOCKER: the harness refused the candidate — the candidate was NOT executed outside isolation.');
  await reconcileAndExit(calls.reduce((s, c) => s + c.costUsd, 0), 1);
}
const candidateReport = JSON.parse(await readFile(tested.jsonPath, 'utf8'));
const vFacts = evidenceFacts(candidateReport);
const status = vFacts.verdict === 'patch_supported' ? 'verified' : vFacts.verdict === 'inconclusive' ? 'inconclusive' : 'tested';
console.log(`verification: verdict=${vFacts.verdict} status=${status} (harness only — the model did not decide this)`);

// ---- Stage D: summarize ----
const summary = await metaCall({
  stage: 'summarize',
  system: SYSTEM_PROMPTS.summarize,
  user: [
    `Scenario id: ${vFacts.scenario_id}`,
    `Independent harness verdict: ${vFacts.verdict} (reason code: ${vFacts.reason_code})`,
    `Reason: ${vFacts.reason}`,
    `Conditions: ${JSON.stringify(vFacts.conditions)}`,
    `Limitations: ${JSON.stringify(vFacts.limitations)}`,
    'Candidate patch was NOT applied — adoption is a separate human decision.',
    '',
    'Summarize the observed result and remaining limitations in two short paragraphs for a security reviewer.',
  ].join('\n'),
  ...STAGE_LIMITS.summarize,
});
if (!summary.ok) {
  console.error(`BLOCKER: summarize failed (${summary.error}): ${redact(summary.detail ?? '')} — usage so far is reconciled below.`);
  await reconcileAndExit(calls.reduce((s, c) => s + c.costUsd, 0), 1);
}
calls.push({ stage: 'summarize', ...summary });
console.log(`summarize: ${summary.promptTokens} in / ${summary.completionTokens} out ($${summary.costUsd.toFixed(6)}) request ${redact(summary.requestId)}`);

// ---- Stage E: report ----
const totalCost = calls.reduce((s, c) => s + c.costUsd, 0);
const prunedCalls = calls.map(({ text, ...rest }) => rest);
const report = {
  model: MODEL,
  mode: 'live',
  pricing: { ...PRICING },
  baseline_verdict: facts.verdict,
  explanation: explain.text,
  candidate: { code: candidateCode, applied: false },
  verification: { verdict: vFacts.verdict, reason: vFacts.reason, status },
  summary: summary.text,
  usage: { calls: prunedCalls, total_cost_usd: Number(totalCost.toFixed(6)), estimated: false, reserved_usd: RESERVE_USD, actual_usd: Number(totalCost.toFixed(6)) },
  generated_at: new Date().toISOString(),
};
await writeFile(path.join(OUT_DIR, 'advisory.report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(path.join(OUT_DIR, 'advisory.report.md'), [
  '# Advisory cycle report (live, Meta Model API)',
  '',
  `- Model: ${MODEL} (standard mode; pricing ${PRICING.source}, verified ${PRICING.verified_at})`,
  `- Baseline harness verdict: ${facts.verdict}`,
  `- Candidate harness verdict: ${vFacts.verdict} (${status})`,
  '',
  '## Explanation (model-generated, advisory only)',
  '',
  explain.text,
  '',
  '## Candidate patch (untrusted — tested only inside the harness sandbox)',
  '',
  '```js',
  candidateCode,
  '```',
  '',
  '## Verification evidence (harness only — the model did not decide this)',
  '',
  `- Verdict: ${vFacts.verdict}`,
  `- Reason: ${vFacts.reason}`,
  `- Conditions: ${JSON.stringify(vFacts.conditions)}`,
  `- Limitations: ${JSON.stringify(vFacts.limitations)}`,
  '',
  '## Summary (model-generated from the harness facts)',
  '',
  summary.text,
  '',
  '## Cost (provider-reported usage, verified pricing table)',
  '',
  ...calls.map((c) => `- ${c.stage}: ${c.promptTokens} in / ${c.completionTokens} out = $${c.costUsd.toFixed(6)} (request ${c.requestId})`),
  `- Total: $${totalCost.toFixed(6)} (reserved ceiling $${RESERVE_USD})`,
  '',
].join('\n'), 'utf8');
console.log(`report: ${path.join(OUT_DIR, 'advisory.report.md')}`);
for (const c of calls) {
  if (c.reasoningTokens !== null && c.reasoningTokens !== undefined) {
    console.log(`note: ${c.stage} included ${c.reasoningTokens} reasoning tokens inside its ${c.completionTokens} billed completion tokens (not double-counted)`);
  }
}
await reconcileAndExit(totalCost, 0);
