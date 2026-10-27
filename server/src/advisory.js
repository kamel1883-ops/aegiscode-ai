/**
 * AegisCode — Meta advisory pipeline (explain → propose → verify → summarize)
 *
 * The ONE end-to-end workflow the Meta integration powers:
 *
 *   A. Explain the verified finding, using the submitted code and the stored
 *      evidence (the report the harness produced).
 *   B. Propose a candidate patch — advisory only, never applied, never merged.
 *   C. Test the candidate in the independent verification harness — the SAME
 *      four-condition engine, unchanged. No model calls happen here.
 *   D. Summarize the observed harness results and the limitations.
 *
 * Boundaries that the model never crosses:
 *  - The model does not control the verdict, the assertions, the sandbox
 *    policy, or the harness — core/src is untouched by this integration.
 *  - The candidate is untrusted code: it runs only inside the existing
 *    isolation boundary (separate agent, clean workspace, limits), and if the
 *    harness refuses to run, the pipeline refuses with it.
 *  - Nothing is applied, merged, committed or deployed; adoption remains the
 *    documented human decision on the verification job.
 *
 * Accounting: one conservative reservation covers the whole cycle (explain +
 * patch + summarize), reserved BEFORE the first call and reconciled with the
 * provider-reported usage after the summary. Mock mode reserves nothing and
 * records $0 — but every call is still recorded, with its mode.
 *
 * Separation (by design):
 *  - source code: never persisted — used for prompts and the candidate test
 *  - candidate patch: stored in the advisory record, clearly labelled
 *  - test results: stored in the verification job, exactly like any job
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { validateScenario } from '../../core/src/schema.js';
import { validateFiles } from './queue.js';
import { META_STATES, ACCESS_NOTE_LIVE } from './meta-client.js';
import { detectNetworkIsolation } from '../../core/src/isolation.js';
import { PRICING, costUsd, estimateTokens, STAGE_LIMITS, SYSTEM_PROMPTS, extractCandidate, evidenceFacts } from './meta-call.js';

/** The conservative per-cycle reservation — a ceiling, not a target cost. */
export const RESERVE_USD = 0.05;

// Stage ceilings, prompts, candidate parsing, and evidence facts live in the
// shared module (server/src/meta-call.js) — the same one the CI runner
// imports — so the two execution paths can never drift apart.
export { STAGE_LIMITS, SYSTEM_PROMPTS, extractCandidate, evidenceFacts };

const ADVISORY_FILE = 'meta-advisories.json';

export class AdvisoryService {
  /**
   * @param {object} deps
   * @param {import('./store.js').Store} deps.store
   * @param {import('./queue.js').Queue} deps.queue
   * @param {import('./budget.js').BudgetManager} deps.budget
   * @param {ReturnType<import('./meta-client.js').createMetaClient>} deps.client
   */
  constructor({ store, queue, budget, client, isolationProbe = detectNetworkIsolation, allowLiveExecution = false }) {
    // allowLiveExecution=false by default: live untrusted execution stays disabled.
    this.store = store;
    this.queue = queue;
    this.budget = budget;
    this.client = client;
    this.isolationProbe = isolationProbe;
    this.allowLiveExecution = allowLiveExecution;
    this.path = path.join(store.dir, ADVISORY_FILE);
    /** @type {Map<string, object>} */
    this.records = new Map();
    this._ready = null;
  }

  /** Lazy one-time init: budget file + persisted verification flag. */
  async ready() {
    if (!this._ready) {
      this._ready = (async () => {
        await this.budget.init();
        await this.client.ready?.();
        try {
          const raw = await readFile(this.path, 'utf8');
          for (const [id, rec] of Object.entries(JSON.parse(raw).advisories ?? {})) {
            this.records.set(id, rec);
          }
        } catch (err) {
          if (err?.code !== 'ENOENT') throw err;
        }
      })();
    }
    await this._ready;
  }

  async _persist() {
    await mkdir(path.dirname(this.path), { recursive: true });
    const payload = { advisories: Object.fromEntries(this.records) };
    const tmp = `${this.path}.tmp-${randomUUID().slice(0, 8)}`;
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(tmp, this.path);
  }

  /** Public status for the UI: state, model, pricing, budget, access note. */
  async status() {
    await this.ready();
    const state = this.client.state;
    const live = state === META_STATES.LIVE_CONFIGURED || state === META_STATES.LIVE_VERIFIED;
    return {
      state,
      model: this.client.model,
      powered_by_meta: live, // "Powered by Meta Model API" only for genuine live integration
      access_note: state === META_STATES.MOCK
        ? 'Mock mode: no live model calls are made. Set META_MODE=live and META_API_KEY on the server to enable live calls.'
        : ACCESS_NOTE_LIVE,
      pricing: {
        model: PRICING.model,
        input_per_mtok: PRICING.input_per_mtok,
        output_per_mtok: PRICING.output_per_mtok,
        source: PRICING.source,
        verified_at: PRICING.verified_at,
      },
      reserve_usd: RESERVE_USD,
      budget: this.budget.status(),
    };
  }

  findBySourceJob(sourceJobId) {
    return [...this.records.values()].find((r) => r.source_job_id === sourceJobId) ?? null;
  }

  get(id) {
    return this.records.get(id) ?? null;
  }

  /**
   * Stages A + B + C: explain, propose the candidate, and submit it to the
   * independent harness. Returns the advisory (or an explicit refusal).
   */
  async start({ sourceJobId, scenario, original, owner = null }) {
    await this.ready();

    const source = this.store.getJob(sourceJobId);
    if (!source || (owner !== null && source.owner !== owner)) {
      return { ok: false, code: 'source_not_found', error: 'Source job not found.' };
    }
    if (source.status !== 'completed' || !source.report) {
      return { ok: false, code: 'source_incomplete', error: 'The source job has no verdict report yet.' };
    }
    if (this.findBySourceJob(sourceJobId)) {
      return { ok: false, code: 'advisory_exists', error: 'An advisory already exists for this job.' };
    }

    const scenarioErrors = validateScenario(scenario).errors ?? [];
    const fileErrors = [...validateFiles(original, 'The original version')];
    const errors = [...scenarioErrors, ...fileErrors];
    if (errors.length > 0) {
      return { ok: false, code: 'invalid_payload', error: 'The advisory payload was rejected.', details: errors };
    }

    const state = this.client.state;
    if (state === META_STATES.LIVE_DISABLED) {
      // Refusal, not silent mock: live mode without credentials produces nothing.
      return { ok: false, code: 'live_disabled', error: 'Live mode is configured without META_API_KEY. No advisory was produced and no mock output was substituted.' };
    }

    const id = `adv-${randomUUID()}`;
    const live = state === META_STATES.LIVE_CONFIGURED || state === META_STATES.LIVE_VERIFIED;

    // Partial safeguard (live only): untrusted model candidates are refused
    // unless a full sandbox is explicitly allowed AND a network namespace is
    // present. Network-namespace availability alone does NOT authorize
    // execution: the current check is only a partial safeguard, not a complete
    // sandbox (host-filesystem reads were demonstrated offline). Production
    // default is allowLiveExecution=false (refuse all live). Offline
    // accounting tests pass allowLiveExecution=true with an isolated probe to
    // prove reservation/reconciliation without authorizing production runs.
    // Mock mode still runs because the mock candidate is owned fixture code.
    if (live) {
      let isolation = null;
      try {
        isolation = await this.isolationProbe();
      } catch {
        isolation = null;
      }
      if (!this.allowLiveExecution || !isolation || isolation.network_namespace === 'none') {
        await this.store.record('meta.advisory.isolation_refused', sourceJobId, {
          network_namespace: isolation?.network_namespace ?? 'unknown',
          allowLiveExecution: Boolean(this.allowLiveExecution),
        });
        return { ok: false, code: 'isolation_unavailable', error: 'Live candidate execution is disabled here: the network-namespace check is only a partial safeguard, not a complete sandbox (host-filesystem access was demonstrated). Use mock mode here; live runs stay paused until filesystem, credential, network, process and resource boundaries are implemented and negatively tested.' };
      }
    }

    // Reserve the whole cycle BEFORE the first call.
    if (live) {
      const reservation = await this.budget.reserve({ jobKey: id, amountUsd: RESERVE_USD, live: true });
      if (!reservation.ok) {
        await this.store.record('meta.budget_rejected', sourceJobId, { code: reservation.code });
        return { ok: false, code: reservation.code, error: reservation.error };
      }
    }

    const facts = evidenceFacts(source.report);
    const codeText = Object.entries(original).map(([name, content]) => `// file: ${name}\n${content}`).join('\n\n');
    const calls = [];

    const record = {
      id,
      source_job_id: sourceJobId,
      owner,
      mode: state,
      model: this.client.model,
      status: 'generated',
      created_at: new Date().toISOString(),
      explanation: null,
      candidate: null,
      verification_job_id: null,
      verification: null,
      summary: null,
      calls,
      budget: { reserved_usd: live ? RESERVE_USD : 0, actual_usd: null, live },
    };

    // ---- Stage A: explain ----
    const explainPrompt = [
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
    ].join('\n');

    const explain = await this.client.complete({
      task: 'explain',
      system: SYSTEM_PROMPTS.explain,
      user: explainPrompt,
      ...STAGE_LIMITS.explain,
      mock: { scenarioId: facts.scenario_id, verdict: facts.verdict, reason: facts.reason },
    });
    if (!explain.ok) {
      await this._fail(record, 'explain', explain);
      return { ok: false, code: `explain_failed_${explain.error}`, error: explain.detail ?? 'The explain call failed.', advisory: this._view(record) };
    }
    calls.push(this._callEntry('explain', explain));
    record.explanation = explain.text;

    // ---- Stage B: propose the candidate patch ----
    const patchPrompt = [
      `Scenario id: ${facts.scenario_id}`,
      `The verified finding: ${facts.reason}`,
      '',
      'Original code (untrusted, do not execute):',
      codeText,
      '',
      'Propose the smallest safe patch. Reply with exactly one fenced JavaScript code block containing the complete patched file.',
    ].join('\n');

    const patch = await this.client.complete({
      task: 'patch',
      system: SYSTEM_PROMPTS.patch,
      user: patchPrompt,
      ...STAGE_LIMITS.patch,
      mock: { scenarioId: facts.scenario_id, verdict: facts.verdict, reason: facts.reason, originalCode: original['app.js'] ?? Object.values(original)[0] ?? '' },
    });
    if (!patch.ok) {
      await this._fail(record, 'patch', patch);
      return { ok: false, code: `patch_failed_${patch.error}`, error: patch.detail ?? 'The patch call failed.', advisory: this._view(record) };
    }
    calls.push(this._callEntry('patch', patch));

    const candidateCode = extractCandidate(patch.text);
    if (!candidateCode) {
      await this._fail(record, 'patch', { error: 'no_candidate_block', detail: 'The model reply contained no fenced code block — no candidate was accepted.' });
      return { ok: false, code: 'no_candidate_block', error: 'The model reply contained no fenced code block.', advisory: this._view(record) };
    }
    record.candidate = { code: candidateCode, proposed_at: new Date().toISOString(), applied: false };

    // ---- Stage C: the independent harness tests the candidate (no model calls) ----
    const submitted = await this.queue.submit(
      { scenario, original, patched: { ...original, 'app.js': candidateCode } },
      owner,
    );
    if (!submitted.ok) {
      await this._fail(record, 'candidate_test', { error: 'harness_rejected', detail: submitted.errors?.join(' · ') ?? 'The harness rejected the candidate.' });
      return { ok: false, code: 'harness_rejected', error: 'The harness rejected the candidate submission.', details: submitted.errors, advisory: this._view(record) };
    }
    record.verification_job_id = submitted.job.id;
    record.status = 'tested';

    this.records.set(id, record);
    await this._persist();
    await this.store.record('meta.advisory.started', sourceJobId, {
      advisory_id: id, mode: record.mode, model: record.model, verification_job_id: record.verification_job_id,
    });

    return { ok: true, advisory: this._view(record) };
  }

  /** Stage D: summarize the observed harness results — after the job finishes. */
  async summarize({ id, owner = null }) {
    await this.ready();
    const record = this._owned(id, owner);
    if (!record) return { ok: false, code: 'not_found', error: 'Advisory not found.' };
    if (record.status !== 'tested') {
      return { ok: false, code: 'not_ready', error: `The advisory is "${record.status}" — the candidate must be verified first.` };
    }
    const verification = this.store.getJob(record.verification_job_id);
    if (!verification || verification.status !== 'completed' || !verification.report) {
      return { ok: false, code: 'verification_incomplete', error: 'The verification job has no report yet.' };
    }

    const facts = evidenceFacts(verification.report);
    const summaryPrompt = [
      `Scenario id: ${facts.scenario_id}`,
      `Independent harness verdict: ${facts.verdict} (reason code: ${facts.reason_code})`,
      `Reason: ${facts.reason}`,
      `Conditions: ${JSON.stringify(facts.conditions)}`,
      `Limitations: ${JSON.stringify(facts.limitations)}`,
      `Candidate patch was ${record.candidate?.applied ? 'applied' : 'NOT applied — adoption is a separate human decision'}.`,
      '',
      'Summarize the observed result and remaining limitations in two short paragraphs for a security reviewer.',
    ].join('\n');

    const summary = await this.client.complete({
      task: 'summarize',
      system: SYSTEM_PROMPTS.summarize,
      user: summaryPrompt,
      ...STAGE_LIMITS.summarize,
      mock: { scenarioId: facts.scenario_id, verdict: facts.verdict, reason: facts.reason },
    });
    if (!summary.ok) {
      await this.store.record('meta.advisory.summarize_failed', record.source_job_id, { advisory_id: id, error: summary.error });
      return { ok: false, code: `summarize_failed_${summary.error}`, error: summary.detail ?? 'The summarize call failed.' };
    }

    record.calls.push(this._callEntry('summarize', summary));
    record.summary = { text: summary.text, at: new Date().toISOString() };
    record.verification = {
      job_id: verification.id,
      verdict: verification.verdict,
      reason: verification.reason,
    };
    // The chip state comes from the harness verdict — never from the model:
    // verified only for a supported patch, inconclusive only for an
    // inconclusive verdict; a decisive negative stays simply "tested".
    record.status = verification.verdict === 'patch_supported'
      ? 'verified'
      : verification.verdict === 'inconclusive'
        ? 'inconclusive'
        : 'completed';

    // Reconcile the reservation with the provider-reported usage.
    if (record.budget.live) {
      const actual = record.calls.reduce((sum, c) => sum + (c.cost_usd ?? 0), 0);
      await this.budget.reconcile({ jobKey: id, actualUsd: actual });
      record.budget.actual_usd = actual;
    }

    await this._persist();
    await this.store.record('meta.advisory.summarized', record.source_job_id, {
      advisory_id: id, status: record.status, verdict: verification.verdict,
    });
    return { ok: true, advisory: this._view(record) };
  }

  /** Cancels the cycle and releases any open reservation. */
  async cancel({ id, owner = null }) {
    await this.ready();
    const record = this._owned(id, owner);
    if (!record) return { ok: false, code: 'not_found', error: 'Advisory not found.' };
    if (['verified', 'inconclusive', 'completed'].includes(record.status)) {
      return { ok: false, code: 'already_finished', error: 'The advisory cycle is already reconciled.' };
    }
    if (record.budget.live && record.budget.actual_usd === null) {
      await this.budget.release({ jobKey: id });
    }
    record.status = 'cancelled';
    await this._persist();
    await this.store.record('meta.advisory.cancelled', record.source_job_id, { advisory_id: id });
    return { ok: true, advisory: this._view(record) };
  }

  /* ---------------- internals ---------------- */

  _owned(id, owner) {
    const record = this.records.get(id) ?? null;
    if (!record) return null;
    if (owner !== null && record.owner !== owner) return null;
    return record;
  }

  _callEntry(stage, result) {
    const live = result.mode === 'live';
    const promptTokens = result.usage?.prompt_tokens ?? null;
    const completionTokens = result.usage?.completion_tokens ?? null;
    const cost = live && promptTokens !== null && completionTokens !== null ? costUsd(promptTokens, completionTokens) : 0;
    return {
      stage,
      mode: result.mode,
      model: result.model ?? this.client.model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      estimated: result.usage?.estimated === true,
      cost_usd: cost,
      at: new Date().toISOString(),
    };
  }

  async _fail(record, stage, result) {
    record.status = 'failed';
    record.failure = { stage, error: result.error ?? 'unknown', detail: result.detail ?? null, at: new Date().toISOString() };
    this.records.set(record.id, record);
    await this._persist().catch(() => {});
    if (record.budget.live && record.budget.actual_usd === null) {
      await this.budget.release({ jobKey: record.id }).catch(() => {});
    }
    await this.store.record('meta.advisory.failed', record.source_job_id, {
      advisory_id: record.id, stage, error: record.failure.error,
    }).catch(() => {});
  }

  /** The API view: no internal bookkeeping, everything the UI needs. */
  _view(record) {
    const totalCost = record.calls.reduce((sum, c) => sum + (c.cost_usd ?? 0), 0);
    const totalTokens = record.calls.reduce((sum, c) => sum + (c.completion_tokens ?? 0), 0);
    return {
      id: record.id,
      source_job_id: record.source_job_id,
      status: record.status, // generated → tested → verified | inconclusive | failed | cancelled
      mode: record.mode,
      model: record.model,
      created_at: record.created_at,
      explanation: record.explanation,
      candidate: record.candidate ? { code: record.candidate.code, applied: record.candidate.applied } : null,
      verification_job_id: record.verification_job_id,
      verification: record.verification,
      summary: record.summary,
      failure: record.failure ?? null,
      usage: {
        calls: record.calls,
        total_completion_tokens: totalTokens,
        total_cost_usd: totalCost,
        estimated: record.calls.some((c) => c.estimated),
        reserved_usd: record.budget.reserved_usd,
        actual_usd: record.budget.actual_usd,
      },
    };
  }
}

/** Fallback token estimate re-exported for callers building prompts. */
export { estimateTokens };
