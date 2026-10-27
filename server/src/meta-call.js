/**
 * AegisCode — shared Meta model-call module (server AND CI runner)
 *
 * The single source of truth for every live model request. Both execution
 * paths import from here — server/src/advisory.js (via meta-client.js) and
 * tools/meta-advisory.mjs — so request shape, validation, pricing, and
 * accounting can never drift into two different implementations:
 *
 *  - STAGE_LIMITS: per-stage output caps, input ceilings, timeouts.
 *  - SYSTEM_PROMPTS: the fixed advisory-only instructions.
 *  - callMeta: one bounded request (reasoning_effort minimal, explicit
 *    output cap, input ceiling, single attempt) with strict response
 *    validation. Empty text or missing provider usage is `invalid_response`,
 *    never silent garbage. Reasoning tokens are reported for transparency
 *    and are already inside completion_tokens — never added twice.
 *  - extractCandidate / evidenceFacts: shared parsing and prompt facts.
 *
 * The key only ever travels in the Authorization header. Nothing this
 * module returns embeds it, so error details are safe to log and store.
 */

import { PRICING, costUsd, estimateTokens } from './meta-pricing.js';

export { PRICING, costUsd, estimateTokens };

/** Per-stage ceilings: [max output tokens, input token ceiling, timeout]. */
export const STAGE_LIMITS = {
  explain: { maxOutputTokens: 800, inputTokenCeiling: 6_000, timeoutMs: 90_000 },
  patch: { maxOutputTokens: 2_500, inputTokenCeiling: 8_000, timeoutMs: 120_000 },
  summarize: { maxOutputTokens: 600, inputTokenCeiling: 5_000, timeoutMs: 90_000 },
};

/** Fixed system prompts — advisory role only, stated in every call. */
export const SYSTEM_PROMPTS = {
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

/** Lowest supported reasoning depth ("none" returns HTTP 400 on muse-spark). */
export const REASONING_EFFORT = 'minimal';

/** First fenced code block — the only accepted candidate shape. */
export function extractCandidate(text) {
  const match = String(text).match(/```(?:javascript|js)?\n([\s\S]*?)```/);
  if (!match) return null;
  const code = match[1].trim();
  return code === '' ? null : code;
}

/** Facts-only evidence summary — prompts can never smuggle instructions. */
export function evidenceFacts(report) {
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

/**
 * One bounded, validated model call. Exactly one attempt — no retries.
 *
 * @param {object} params
 * @param {typeof fetch} params.fetchFn fetch implementation (injected)
 * @param {string} params.baseUrl API base URL
 * @param {string} params.key API key (header only, never in returned strings)
 * @param {string} params.model model ID
 * @param {string} params.system system message
 * @param {string} params.user user message
 * @param {number} params.maxOutputTokens explicit output cap (request param)
 * @param {number} params.inputTokenCeiling refuse above this input size
 * @param {number} [params.timeoutMs] per-call timeout
 * @returns {Promise<{ok:boolean, text?:string, promptTokens?:number, completionTokens?:number, reasoningTokens?:number|null, requestId?:string, costUsd?:number, error?:string, detail?:string, httpStatus?:number}>}
 */
export async function callMeta({
  fetchFn, baseUrl, key, model, system, user,
  maxOutputTokens, inputTokenCeiling, timeoutMs = 90_000,
}) {
  const inputTokens = estimateTokens(`${system}\n${user}`);
  if (inputTokenCeiling && inputTokens > inputTokenCeiling) {
    return {
      ok: false,
      error: 'input_ceiling_exceeded',
      detail: `Estimated input ${inputTokens} tokens exceeds the ceiling ${inputTokenCeiling}. No request was made.`,
    };
  }

  let res;
  try {
    res = await fetchFn(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        reasoning_effort: REASONING_EFFORT,
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
    let detail = '';
    try { detail = (await res.text()).slice(0, 500); } catch { /* body unavailable */ }
    return { ok: false, error: `http_${res.status}`, detail, httpStatus: res.status };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: 'invalid_response', detail: 'The response body was not valid JSON.' };
  }

  const text = data?.choices?.[0]?.message?.content ?? '';
  const promptTokens = data?.usage?.prompt_tokens ?? null;
  const completionTokens = data?.usage?.completion_tokens ?? null;
  if (promptTokens === null || completionTokens === null || !text) {
    return {
      ok: false,
      error: 'invalid_response',
      detail: `Provider usage or text missing (finish_reason=${data?.choices?.[0]?.finish_reason ?? 'unknown'}, text_len=${typeof text === 'string' ? text.length : typeof text}).`,
      promptTokens: Number.isFinite(promptTokens) ? promptTokens : undefined,
      completionTokens: Number.isFinite(completionTokens) ? completionTokens : undefined,
    };
  }

  return {
    ok: true,
    text,
    promptTokens,
    completionTokens,
    reasoningTokens: data?.usage?.completion_tokens_details?.reasoning_tokens
      ?? data?.usage?.output_tokens_details?.reasoning_tokens ?? null,
    requestId: res.headers?.get?.('x-request-id') ?? data?.id ?? '(not provided)',
    costUsd: costUsd(promptTokens, completionTokens),
  };
}
