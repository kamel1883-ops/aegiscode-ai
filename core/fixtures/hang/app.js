'use strict';
/**
 * Deliberately hanging code (for experiments): prints the legitimate behavior,
 * then hangs forever.
 *
 * Its purpose in the experiment: prove the strict rule — a timeout is recorded
 * as **timeout = failure**, and is never classified as "the vulnerability did
 * not recur" or as a fix.
 */
if (process.argv[2] !== 'serve') {
  console.error('usage: app.js serve');
  process.exit(2);
}

console.log('AC::LEGITIMATE_OK');

// No output and no exit — waits forever.
setInterval(() => {}, 1000);
