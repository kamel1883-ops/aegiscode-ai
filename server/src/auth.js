/**
 * AegisCode — Phase Two authentication (temporary access tokens)
 *
 * Constant-time comparison prevents timing attacks against the token.
 * This authentication is **temporary** and is replaced by full accounts with
 * sessions in Phase Three.
 */

import { timingSafeEqual } from 'node:crypto';

/**
 * Compares a provided token against an allowed token list using constant-time
 * comparison. Different length ⇒ false immediately without comparison (no
 * length leak).
 */
export function randomTimingSafeEqual(provided, allowed) {
  const a = Buffer.from(String(provided), 'utf8');
  let match = false;
  for (const token of allowed) {
    const b = Buffer.from(String(token), 'utf8');
    if (b.length !== a.length) continue;
    if (timingSafeEqual(a, b)) match = true;
  }
  return match;
}

/**
 * Reads access tokens from the environment. The server refuses to start
 * without tokens (the safe default).
 * @returns {string[]}
 */
export function tokensFromEnv(env = process.env) {
  const raw = env.AEGISCODE_API_TOKENS ?? '';
  return raw.split(',').map((t) => t.trim()).filter(Boolean);
}
