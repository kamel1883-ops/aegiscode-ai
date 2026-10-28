'use strict';
/** Negative-test fixture: prints whether secrets leaked into its environment. Must print NO. */
if (process.argv[2] !== 'serve') { console.error('usage: app.js serve'); process.exit(2); }
console.log('AC::LEGITIMATE_OK');
const leaked = [];
for (const k of ['META_API_KEY', 'AEGISCODE_API_TOKENS', 'GITHUB_TOKEN']) {
  if (process.env[k]) leaked.push(k);
}
console.log(`AC::LEAKED:${leaked.length ? leaked.join(',') : 'NONE'}`);
process.exit(0);
