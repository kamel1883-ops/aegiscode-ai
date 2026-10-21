'use strict';
/**
 * The original code (S) — contains a vulnerability: it fetches a template from
 * an external resource without validating its source.
 *
 * Subject-code protocol:
 *   - Run with: `app.js serve`
 *   - Prints `AC::LEGITIMATE_OK` after its legitimate behavior completes
 *   - Prints `AC::UNSAFE_EVENT` if the unsafe event recurred
 *   - Receives the synthetic resource via `AC_RESOURCE_URL` (injected only in
 *     the two substituted conditions)
 */
if (process.argv[2] !== 'serve') {
  console.error('usage: app.js serve');
  process.exit(2);
}

console.log('AC::LEGITIMATE_OK');

const resourceUrl = process.env.AC_RESOURCE_URL;

if (!resourceUrl) {
  // Baseline: no resource, so the path is never reached — and that is exactly
  // what a single conventional test hides.
  console.log('AC::NO_RESOURCE');
  process.exit(0);
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 4000);

fetch(`${resourceUrl}/template`, { signal: controller.signal })
  .then(async (res) => {
    clearTimeout(timer);
    const body = await res.text();
    if (body.includes('AC-RESOURCE-MARKER')) {
      console.log('AC::UNSAFE_EVENT');
    }
    process.exit(0);
  })
  .catch((err) => {
    clearTimeout(timer);
    // A failed resource fetch is a run failure, not a success.
    console.error(`AC::RESOURCE_FETCH_FAILED ${err?.message ?? err}`);
    process.exit(3);
  });
