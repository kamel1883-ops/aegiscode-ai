#!/usr/bin/env node
/**
 * AegisCode — API server entry point (Phase Two)
 *
 * Usage:
 *   AEGISCODE_API_TOKENS="tok1,tok2" node bin/aegiscode-server.js [--port 8080] [--data ./data]
 *
 * Access tokens are mandatory via the environment — the server refuses to
 * start without them (the safe default).
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { Store } from '../src/store.js';
import { Queue } from '../src/queue.js';
import { createApiServer } from '../src/api.js';
import { tokensFromEnv } from '../src/auth.js';
import { AccountStore } from '../src/accounts.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

const USAGE = `AegisCode — causal verification server (Phase Two)

Usage:
  AEGISCODE_API_TOKENS="token1,token2" node bin/aegiscode-server.js [options]

Options:
  --port <number>  port (default 8080)
  --host <host>    address (default 127.0.0.1)
  --data <dir>     storage directory (default ./data)
  --help           print this message

No merge interface and no code modification: adoption is a documented human
decision only.
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const tokens = tokensFromEnv();
if (tokens.length === 0) {
  console.error('No access tokens: set AEGISCODE_API_TOKENS="token1,token2" — the server refuses to start without tokens.');
  process.exit(2);
}

const dataDir = path.resolve(String(args.data ?? './data'));
await mkdir(dataDir, { recursive: true });

const store = new Store(dataDir);
await store.init();

const accounts = new AccountStore(dataDir);
await accounts.init();

const queue = new Queue(store);
const server = createApiServer({ store, queue, tokens, accounts });

const port = Number(args.port ?? 8080);
const host = String(args.host ?? '127.0.0.1');

server.listen(port, host, () => {
  console.log('AegisCode — causal verification server');
  console.log(`UI:   http://${host}:${port}/`);
  console.log(`API:  http://${host}:${port}/api/health`);
  console.log(`Data: ${dataDir}`);
});
