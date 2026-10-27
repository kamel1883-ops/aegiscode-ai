/**
 * AegisCode — verified Meta Model API pricing (Meta advisory integration)
 *
 * These are the rates transcribed from Meta's official pricing page, with the
 * date they were verified — nothing here is estimated or invented. If the
 * rates change on Meta's side, this table must be re-verified and the date
 * updated; every cost computed by the budget manager cites this source.
 *
 * Source: https://dev.meta.ai/docs/pricing-rate-limits  (verified 2026-10-26)
 *
 * Standard mode is used (not the cheaper Contributor mode), because
 * Contributor mode permits Meta to use submitted content for training. Note:
 * the free-credit terms shown in the account dashboard are separate from the
 * mode choice and are documented in the README as requiring confirmation.
 */

export const PRICING = {
  model: 'muse-spark-1.3',
  mode: 'standard',
  input_per_mtok: 1.25,
  output_per_mtok: 4.25,
  cached_input_per_mtok: 0.15,
  source: 'https://dev.meta.ai/docs/pricing-rate-limits',
  verified_at: '2026-10-26',
};

/**
 * Cost in USD of one call from provider-reported token usage.
 * @param {number} promptTokens usage.prompt_tokens
 * @param {number} completionTokens usage.completion_tokens
 */
export function costUsd(promptTokens, completionTokens, pricing = PRICING) {
  return (promptTokens / 1e6) * pricing.input_per_mtok + (completionTokens / 1e6) * pricing.output_per_mtok;
}

/**
 * Conservative token estimate used **only** for pre-call ceilings and for
 * mock-mode accounting. Deliberately rounds up (chars/3) so an estimate never
 * understates the real input; the provider-reported usage always wins
 * afterwards for actual accounting.
 */
export function estimateTokens(text) {
  return Math.ceil(String(text).length / 3);
}
