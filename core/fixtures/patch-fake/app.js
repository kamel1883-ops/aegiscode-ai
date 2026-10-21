'use strict';
/**
 * The fake patch (P-fake): a **superficial** change — logging and input
 * sanitization are added — but the exploit path remains fully intact: the
 * unvalidated external fetch is still there.
 *
 * This is precisely what the four-condition matrix exposes: a single test
 * declares "success" in the baseline while the vulnerability is perfectly
 * alive when the resource is available.
 */
if (process.argv[2] !== 'serve') {
  console.error('usage: app.js serve');
  process.exit(2);
}

console.log('AC::LEGITIMATE_OK');

// The "patch": logging and sanitizing only — the dangerous path is untouched.
const sanitized = String(process.env.AC_RUN_ID ?? '').trim();
if (sanitized) {
  console.log(`AC::PATCH_APPLIED run=${sanitized}`);
}

const resourceUrl = process.env.AC_RESOURCE_URL;

if (!resourceUrl) {
  // Baseline: no resource ⇒ no recurrence ⇒ the conventional test reports a false success.
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
    console.error(`AC::RESOURCE_FETCH_FAILED ${err?.message ?? err}`);
    process.exit(3);
  });
