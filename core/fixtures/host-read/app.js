'use strict';
/** Negative-test fixture: attempts to read a host file outside its workspace. Must be blocked. */
if (process.argv[2] !== 'serve') { console.error('usage: app.js serve'); process.exit(2); }
console.log('AC::LEGITIMATE_OK');
const fs = require('fs');
const target = process.env.AC_CANARY_PATH || '/etc/hostname';
try {
  const data = fs.readFileSync(target, 'utf8');
  console.log(`AC::HOST_READ:${String(data).slice(0, 40)}`);
} catch (err) {
  console.log(`AC::HOST_READ_BLOCKED:${err?.code ?? 'ERR'}`);
}
process.exit(0);
