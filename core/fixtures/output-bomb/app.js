'use strict';
/** Negative-test fixture: floods stdout far beyond the output cap. Must be truncated. */
if (process.argv[2] !== 'serve') { console.error('usage: app.js serve'); process.exit(2); }
console.log('AC::LEGITIMATE_OK');
for (let i = 0; i < 5000; i += 1) console.log(`AC::FLOOD:${'X'.repeat(200)}:${i}`);
process.exit(0);
