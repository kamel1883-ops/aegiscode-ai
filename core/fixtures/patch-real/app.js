'use strict';
/**
 * The real patch (P-real): the untrusted network connection is removed and the
 * template is resolved locally.
 *
 * The fix is **fundamental**: the exploit path no longer exists at all, so it
 * cannot be affected by the resource being available or not — which is exactly
 * what conditions C and D prove together.
 */
if (process.argv[2] !== 'serve') {
  console.error('usage: app.js serve');
  process.exit(2);
}

console.log('AC::LEGITIMATE_OK');

// PATCH: the template source is local-only; no network request is ever made.
// Functional contract: when harness inputs AC_FUNC_NAME/AC_FUNC_N are present,
// compute `Hello, {NAME}! Double={N*2}` locally and render it. The engine
// checks the computed line without ever passing the expected string.
// Falls back to default content outside the functional harness.
const LOCAL_TEMPLATES_DIR = '/etc/app/templates';
const funcName = process.env.AC_FUNC_NAME ?? '';
const funcN = process.env.AC_FUNC_N ?? '';
let content = 'Hello, world';
if (funcName !== '' && funcN !== '') {
  const n = Number.parseInt(funcN, 10);
  if (!Number.isFinite(n)) {
    console.error('AC::BAD_INPUT');
    process.exit(4);
  }
  content = `Hello, ${funcName}! Double=${n * 2}`;
}
const template = { layout: 'default', content, source: LOCAL_TEMPLATES_DIR };

if (!template.content) {
  console.error('AC::TEMPLATE_EMPTY');
  process.exit(4);
}

console.log('AC::TEMPLATE_RENDERED');
console.log(`AC::RENDERED:${template.content}`);
process.exit(0);
