'use strict';
/** Negative-test fixture: exhausts V8 heap with retained objects. Must crash, never complete. */
if (process.argv[2] !== 'serve') { console.error('usage: app.js serve'); process.exit(2); }
console.log('AC::LEGITIMATE_OK');
const hold = [];
// ~2M small objects with 1KB strings each: far beyond a 64MB heap cap.
for (let i = 0; i < 2000000; i += 1) hold.push({ i, s: 'x'.repeat(1024) });
console.log(`AC::HELD:${hold.length}`);
process.exit(0);
