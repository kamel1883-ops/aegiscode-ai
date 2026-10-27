'use strict';
/**
 * The sneaky patch (P-sneaky): prints EVERY static success marker, including
 * AC::TEMPLATE_RENDERED and a hardcoded Hello world, then exits without any
 * network fetch. Under marker-only checks it would PASS.
 *
 * It deliberately ignores the harness-owned AC_EXPECTED_RENDER nonce, so the
 * dynamic functional check rejects it: static printing is not functionality.
 */
if (process.argv[2] !== 'serve') {
  console.error('usage: app.js serve');
  process.exit(2);
}

console.log('AC::LEGITIMATE_OK');
console.log('AC::TEMPLATE_RENDERED');
console.log('AC::RENDERED:Hello, world');
process.exit(0);
