'use strict';
/**
 * The stub patch (P-stub): the exact degenerate candidate produced by the
 * live Meta run. It removes the fetch AND the feature: it prints
 * AC::LEGITIMATE_OK + AC::NO_RESOURCE and exits, without rendering any
 * template.
 *
 * Security: passes (no UNSAFE_EVENT even with resource).
 * Functional: FAILS (no AC::TEMPLATE_RENDERED, no template output).
 * This fixture exists so regression tests prove the harness rejects it as
 * a functionality-preserving repair.
 */
if (process.argv[2] !== 'serve') {
  console.error('usage: app.js serve');
  process.exit(2);
}

console.log('AC::LEGITIMATE_OK');
console.log('AC::NO_RESOURCE');
process.exit(0);
