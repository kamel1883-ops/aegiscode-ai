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
const LOCAL_TEMPLATES_DIR = '/etc/app/templates';
const template = { layout: 'default', content: 'Hello, world', source: LOCAL_TEMPLATES_DIR };

if (!template.content) {
  console.error('AC::TEMPLATE_EMPTY');
  process.exit(4);
}

console.log('AC::TEMPLATE_RENDERED');
process.exit(0);
