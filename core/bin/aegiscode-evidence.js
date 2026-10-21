#!/usr/bin/env node
/**
 * AegisCode — evidence-bundle CLI (Phase Five)
 *
 *   build   builds a bundle from a real report: hashes + guarantee map +
 *           Ed25519 signature + printable version (report.html).
 *   verify  verifies a bundle received from a third party: the signature, the
 *           hashes and (optionally) the live tree files.
 *
 * Exit codes: 0 = success/valid bundle · 1 = bundle rejected at verification · 2 = usage error
 *
 * Zero dependencies: node:util and node:crypto only.
 */

import { parseArgs } from 'node:util';

import { buildEvidenceBundle, verifyEvidenceBundle } from '../src/evidence.js';

const USAGE = `aegiscode-evidence — a verifiable evidence bundle for third parties

Build:
  node bin/aegiscode-evidence.js build \
      --report-json <report.json> --report-md <report.md> --scenario <scenario.json> \
      --repo <repo-root> --out <bundle-dir> \
      [--audit <audit.jsonl>] [--key <private-key.pem>]

Verify:
  node bin/aegiscode-evidence.js verify --bundle <bundle-dir> [--repo <repo-root>]

Notes:
  Without --key an ephemeral key is used: generated in memory, never written to
  disk, and only the public key ships in the bundle. To issue with a continuous
  trust chain, pass a fresh path — the private key is saved (mode 600) and
  reused on every build.
`;

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    'report-json': { type: 'string' },
    'report-md': { type: 'string' },
    scenario: { type: 'string' },
    repo: { type: 'string' },
    out: { type: 'string' },
    audit: { type: 'string' },
    key: { type: 'string' },
    bundle: { type: 'string' },
    help: { type: 'boolean' },
  },
});

const command = positionals[0];

if (values.help || !command) {
  process.stdout.write(USAGE);
  process.exit(command ? 0 : 2);
}

try {
  if (command === 'build') {
    for (const flag of ['report-json', 'report-md', 'scenario', 'repo', 'out']) {
      if (!values[flag]) fail(`The --${flag} argument is mandatory for the build command.\n\n${USAGE}`);
    }

    const result = await buildEvidenceBundle({
      repoRoot: values.repo,
      outDir: values.out,
      reportJsonPath: values['report-json'],
      reportMdPath: values['report-md'],
      scenarioPath: values.scenario,
      auditPath: values.audit ?? null,
      keyPath: values.key ?? null,
    });

    const signNote =
      result.mode === 'ephemeral'
        ? 'ephemeral key: never written to disk — trust requires delivering public.pem out of band.'
        : result.mode === 'generated'
          ? 'a new key was saved at the given path (mode 600).'
          : 'an existing key was reused (continuous trust chain).';

    process.stdout.write(
      [
        `Bundle written: ${result.outDir}`,
        `  Verdict: ${result.verdict}`,
        `  Hashed files: ${result.fileCount}`,
        `  Signature: Ed25519 · ${signNote}`,
        `  Public-key fingerprint: ${result.keyId}`,
        '',
        `Verify: node bin/aegiscode-evidence.js verify --bundle ${result.outDir}` +
          (values.repo ? ` --repo ${values.repo}` : ''),
        '',
      ].join('\n'),
    );
    process.exit(0);
  }

  if (command === 'verify') {
    if (!values.bundle) fail(`The --bundle argument is mandatory for the verify command.\n\n${USAGE}`);

    const result = await verifyEvidenceBundle(values.bundle, { repoRoot: values.repo ?? null });

    if (result.ok) {
      process.stdout.write(
        [
          'Bundle intact ✓',
          `  Verdict in the bundle: ${result.verdict}`,
          `  Files verified: ${result.checked}` +
            (result.repo_files_checked > 0 ? ` + ${result.repo_files_checked} live repo file(s)` : ''),
          `  Signature: Ed25519 valid · key fingerprint ${result.key_sha256?.slice(0, 16)}… (${result.mode})`,
          '',
        ].join('\n'),
      );
      process.exit(0);
    }

    process.stderr.write('Bundle rejected ✗\n');
    for (const e of result.errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }

  fail(`Unknown command: ${command}\n\n${USAGE}`);
} catch (err) {
  fail(`Error: ${err?.message ?? err}`, 2);
}
