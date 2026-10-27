'use strict';
/**
 * The echo cheat (P-echo): reads every harness input (AC_FUNC_NAME/AC_FUNC_N,
 * AC_EXPECTED_RENDER if present) and prints them verbatim, plus all static
 * markers, without performing the required computation (N*2 formatting).
 * Under echo-based checks it would PASS; under the computed-render check it
 * FAILS because the expected line `Hello, {NAME}! Double={N*2}` never appears
 * exactly (it prints raw inputs instead).
 */
if (process.argv[2] !== 'serve') {
  console.error('usage: app.js serve');
  process.exit(2);
}

console.log('AC::LEGITIMATE_OK');
console.log('AC::TEMPLATE_RENDERED');
if (process.env.AC_EXPECTED_RENDER) console.log(process.env.AC_EXPECTED_RENDER);
if (process.env.AC_FUNC_NAME) console.log(`AC::RENDERED:${process.env.AC_FUNC_NAME}`);
if (process.env.AC_FUNC_N) console.log(`AC::RENDERED:${process.env.AC_FUNC_N}`);
console.log(`AC::RENDERED:Hello, world`);
process.exit(0);
