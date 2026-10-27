/**
 * AegisCode — Meta Model API client (advisory integration)
 *
 * One thin, auditable client for every model call. Its rules:
 *
 *  - Four explicit states, never conflated:
 *      mock             — no key needed, no network, outputs carry a marker
 *      live_disabled    — META_MODE=live without META_API_KEY: refuse, and
 *                         NEVER fall back to mock output
 *      live_configured  — a key is present; a connection has not been proven
 *      live_verified    — at least one real call succeeded (persisted)
 *    Having an API key alone never marks the integration as working.
 *  - The input ceiling is enforced BEFORE the call; the output cap is an
 *    explicit request parameter (max_completion_tokens — the Chat Completions
 *    field; max_output_tokens belongs to the Responses API).
 *  - Exactly one attempt: no automatic retries. Failures are reported for
 *    review, never retried and never papered over with mock output.
 *  - The model, provider and data policy are fixed in configuration; nothing
 *    here switches providers or models at runtime.
 *
 * The model role is advisory only: this client never touches the verification
 * harness, its assertions, its sandbox policy, or any verdict.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { estimateTokens } from './meta-pricing.js';
import { callMeta } from './meta-call.js';

export const META_STATES = {
  MOCK: 'mock',
  LIVE_DISABLED: 'live_disabled',
  LIVE_CONFIGURED: 'live_configured',
  LIVE_VERIFIED: 'live_verified',
};

/** Accurate access description: connection proven, spend still bounded. */
export const ACCESS_NOTE_LIVE =
  'Live mode: the Meta Model API connection has been verified; every call is pre-reserved, recorded with provider-reported usage, and charged against the approved budget. Promotional-credit data-use terms still require confirmation with Meta.';

export const DEFAULT_MODEL = 'muse-spark-1.3';
export const DEFAULT_BASE_URL = 'https://api.meta.ai/v1';

/** Marker so a mock output can never be mistaken for a live model output. */
export const MOCK_MARKER = '[mock output — no live model was called]';

const VERIFIED_FILE = 'meta-live-verified.json';

/** Computes the state from the environment — deliberately conservative. */
export function stateFromEnv(env = process.env) {
  const mode = String(env.META_MODE ?? 'mock').toLowerCase();
  if (mode !== 'live') return META_STATES.MOCK;
  const key = String(env.META_API_KEY ?? '').trim();
  return key === '' ? META_STATES.LIVE_DISABLED : META_STATES.LIVE_CONFIGURED;
}

/**
 * Builds the client.
 *
 * @param {object} [opts]
 * @param {object} [opts.env] environment (defaults to process.env)
 * @param {typeof fetch} [opts.fetchFn] injected for offline tests
 * @param {string|null} [opts.dir] directory for the persisted "verified" flag
 * @param {number} [opts.timeoutMs] per-call timeout; a timeout is a failure
 */
export function createMetaClient({
  env = process.env,
  fetchFn = fetch,
  dir = null,
  model = String(env.META_MODEL_ID ?? DEFAULT_MODEL),
  baseUrl = String(env.META_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
  timeoutMs = 30_000,
} = {}) {
  const key = String(env.META_API_KEY ?? '').trim();
  let state = stateFromEnv(env);
  let verified = false;

  async function markVerified() {
    verified = true;
    state = META_STATES.LIVE_VERIFIED;
    if (!dir) return;
    try {
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, VERIFIED_FILE);
      const tmp = `${file}.tmp-${randomUUID().slice(0, 8)}`;
      await writeFile(tmp, `${JSON.stringify({ model, verified_at: new Date().toISOString() }, null, 2)}\n`, 'utf8');
      await rename(tmp, file);
    } catch {
      // The flag is informational; a failure to persist never blocks a call.
    }
  }

  async function loadVerified() {
    if (!dir) return;
    try {
      const raw = await readFile(path.join(dir, VERIFIED_FILE), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.model === model) await markVerified();
    } catch {
      // No persisted verification: the state stays as computed from env.
    }
  }

  /**
   * One completion call.
   *
   * @param {object} params
   * @param {'explain'|'patch'|'summarize'} params.task
   * @param {string} params.system system message
   * @param {string} params.user user message (the whole prompt content)
   * @param {number} params.maxOutputTokens explicit output cap (request param)
   * @param {number} params.inputTokenCeiling refuse the call above this input size
   * @param {number} [params.timeoutMs] per-call timeout override (stage limits)
   * @param {object} [params.mock] mock-mode context (scenario id, verdict, reason, code)
   * @returns {Promise<{ok:boolean, mode:'mock'|'live', text?:string, usage?:object, error?:string, detail?:string}>}
   */
  async function complete({ task, system, user, maxOutputTokens, inputTokenCeiling, timeoutMs: stageTimeoutMs, mock = {} }) {
    if (state === META_STATES.MOCK) {
      const promptTokens = estimateTokens(`${system}\n${user}`);
      const text = mockCompletion(task, mock);
      return {
        ok: true,
        mode: 'mock',
        text,
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: estimateTokens(text),
          estimated: true,
        },
        model,
      };
    }

    if (state === META_STATES.LIVE_DISABLED) {
      // The one hard rule: missing credentials never become mock output.
      return {
        ok: false,
        mode: 'live',
        error: 'live_disabled',
        detail: 'META_MODE=live but META_API_KEY is not set. No request was made and no mock output was produced.',
      };
    }

    // The one shared, validated call — the same module the CI runner uses,
    // so server and CI request/validation semantics can never drift apart.
    // Exactly one attempt — no automatic retries, ever.
    const result = await callMeta({
      fetchFn, baseUrl, key, model, system, user,
      maxOutputTokens, inputTokenCeiling,
      timeoutMs: stageTimeoutMs ?? timeoutMs,
    });
    if (!result.ok) {
      return { ok: false, mode: 'live', error: result.error, detail: result.detail };
    }
    await markVerified();
    return {
      ok: true, mode: 'live', text: result.text,
      usage: { prompt_tokens: result.promptTokens, completion_tokens: result.completionTokens },
      model,
    };
  }

  return {
    get state() { return state; },
    get model() { return model; },
    get baseUrl() { return baseUrl; },
    complete,
    ready: loadVerified,
  };
}

/** Deterministic mock outputs — clearly marked, never presented as real. */
function mockCompletion(task, { scenarioId = 'scenario', verdict = 'unknown', reason = '', originalCode = '' } = {}) {
  if (task === 'explain') {
    return `${MOCK_MARKER}\n`
      + `Scenario "${scenarioId}" was verified by the independent harness with four isolated conditions. `
      + `The harness verdict is "${verdict}". Reason: ${reason} `
      + `The candidate patch proposed below is a mock placeholder: it makes no functional change, `
      + `so the harness will confirm honestly whether the flaw persists.`;
  }
  if (task === 'patch') {
    const code = String(originalCode);
    return `${MOCK_MARKER}\nHere is the candidate patch:\n\`\`\`js\n${code}\n// [mock candidate — proposed without a live model; no functional change]\n\`\`\``;
  }
  // summarize
  return `${MOCK_MARKER}\nIndependent harness verdict: ${verdict}. Reason: ${reason} `
    + `This summary was produced in mock mode from the report facts; it does not change the verdict or the evidence.`;
}
