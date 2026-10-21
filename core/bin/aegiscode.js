#!/usr/bin/env node
/**
 * AegisCode — CLI runner (Phase Zero)
 *
 * Usage:
 *   node bin/aegiscode.js --scenario scenarios/demo-template-fetch.json \
 *        --original fixtures/original --patched fixtures/patch-real \
 *        [--out reports/demo.md] [--json reports/demo.json]
 *
 * It never modifies a repository and never merges anything: it emits the
 * verdict and the evidence only.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { verify } from '../src/index.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

const USAGE = `AegisCode — causal verification of patch efficacy

Usage:
  node bin/aegiscode.js --scenario <scenario.json>
                        --original <original-code-dir>
                        --patched <patched-code-dir>
                        [--out <report.md>] [--json <report.json>]

Other options:
  --help   print this message
`;

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

if (!args.scenario) {
  console.error(USAGE);
  process.exit(2);
}

try {
  const scenarioPath = path.resolve(String(args.scenario));
  const raw = JSON.parse(await readFile(scenarioPath, 'utf8'));

  const subjects = {
    original: path.resolve(String(args.original ?? 'fixtures/original')),
    patched: path.resolve(String(args.patched ?? 'fixtures/patch-real')),
  };

  const result = await verify(raw, subjects);

  if (!result.ok) {
    console.error('Scenario rejected — nothing was run:');
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(2);
  }

  if (args.json) {
    const jsonPath = path.resolve(String(args.json));
    await mkdir(path.dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, `${JSON.stringify(result.report, null, 2)}\n`, 'utf8');
  }

  if (args.out) {
    const outPath = path.resolve(String(args.out));
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${result.markdown}\n`, 'utf8');
    console.log(`Verdict: ${result.verdict}`);
    console.log(`Report:  ${outPath}`);
  } else {
    process.stdout.write(`${result.markdown}\n`);
  }

  // The exit code reflects the verdict: 0 = verdict other than "inconclusive", 1 = inconclusive.
  process.exit(result.verdict === 'inconclusive' ? 1 : 0);
} catch (err) {
  console.error(`Error: ${err?.message ?? err}`);
  process.exit(2);
}
