import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verify } from '../src/index.js';
import {
  GUARANTEE_MAP,
  allGuaranteePaths,
  buildEvidenceBundle,
  verifyEvidenceBundle,
  stableStringify,
  loadOrCreateSigningKey,
} from '../src/evidence.js';
import { renderPrintHtml } from '../src/print.js';
import { demoScenario, FIXTURES } from './helpers.js';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE_BIN = path.join(REPO_ROOT, 'core', 'bin');

/**
 * One real verification shared across all tests: the experiment is run once
 * because running the four-condition matrix (4 agent processes) is expensive,
 * and each bundle is built from a copy of it.
 */
let sharedSourcePromise = null;
let sharedSourceDir = null;

function sharedSource() {
  if (!sharedSourcePromise) {
    sharedSourcePromise = (async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ac-evidence-src-'));
      sharedSourceDir = dir;
      const scenario = demoScenario();
      const { ok, report, markdown, verdict } = await verify(scenario, {
        original: FIXTURES.original,
        patched: FIXTURES.patchReal,
      });
      assert.equal(ok, true);
      assert.equal(verdict, 'patch_supported', `verdict: ${report?.reason}`);
      const scenarioPath = path.join(dir, 'scenario.json');
      const reportJsonPath = path.join(dir, 'report.json');
      const reportMdPath = path.join(dir, 'report.md');
      await writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
      await writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      await writeFile(reportMdPath, `${markdown}\n`, 'utf8');
      return { dir, scenarioPath, reportJsonPath, reportMdPath, report, markdown };
    })();
  }
  return sharedSourcePromise;
}

after(async () => {
  if (sharedSourceDir) await rm(sharedSourceDir, { recursive: true, force: true });
});

/** Builds a fresh bundle from the shared source — a fresh outDir for every test that mutates it. */
async function realBundle(dir) {
  const src = await sharedSource();
  const outDir = path.join(dir, 'bundle');
  const built = await buildEvidenceBundle({
    repoRoot: REPO_ROOT,
    outDir,
    reportJsonPath: src.reportJsonPath,
    reportMdPath: src.reportMdPath,
    scenarioPath: src.scenarioPath,
  });
  return { built, outDir, report: src.report, markdown: src.markdown, verdict: built.verdict };
}

// ---------------------------------------------------------------------------
// The guarantee map: every guarantee ↔ code file ↔ test
// ---------------------------------------------------------------------------

test('the guarantee map covers the twelve guarantees — G1 and G9 independent, the rest dependent', () => {
  const ids = GUARANTEE_MAP.map((g) => g.id);
  assert.deepEqual(
    ids,
    Array.from({ length: 12 }, (_, i) => `G${i + 1}`),
  );
  // G1 is an independent method, G9 an independent system, the rest dependent.
  assert.equal(GUARANTEE_MAP[0].kind, 'method');
  assert.equal(GUARANTEE_MAP[8].kind, 'independent');
  for (const g of GUARANTEE_MAP) {
    if (g.id !== 'G1' && g.id !== 'G9') assert.equal(g.kind, 'dependent', g.id);
    assert.ok(['method', 'independent', 'dependent'].includes(g.kind), `unknown kind in ${g.id}`);
  };
  // G1 and G9, which the acceptance condition requires, must each reference
  // several code files and tests.
  assert.ok(GUARANTEE_MAP[0].implements.length >= 4);
  assert.ok(GUARANTEE_MAP[0].verified_by.length >= 3);
  assert.ok(GUARANTEE_MAP[8].implements.length >= 5);
  assert.ok(GUARANTEE_MAP[8].verified_by.length >= 3);
});

test('every code and test file in the map really exists in the repository', () => {
  const refs = allGuaranteePaths();
  assert.ok(refs.length >= 15, 'the map must reference more than 15 files');
  for (const rel of refs) {
    assert.ok(existsSync(path.join(REPO_ROOT, rel)), `referenced path does not exist: ${rel}`);
  }
});

// ---------------------------------------------------------------------------
// A bundle from a real verification: build then verify
// ---------------------------------------------------------------------------

test('an evidence bundle from a real verification builds and verifies without errors', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { built, outDir } = await realBundle(dir);
  assert.equal(built.ok, true);
  assert.equal(built.verdict, 'patch_supported');
  assert.ok(built.fileCount >= 5 + 15, 'the bundle carries the reports, the scenario and the guarantee tree');

  for (const f of ['manifest.json', 'public.pem', 'report.json', 'report.md', 'report.html', 'scenario.json']) {
    assert.ok(existsSync(path.join(outDir, f)), `file missing from the bundle: ${f}`);
  }

  const result = await verifyEvidenceBundle(outDir, { repoRoot: REPO_ROOT });
  assert.deepEqual(result.errors, [], result.errors.join(' | '));
  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'patch_supported');
  assert.equal(result.checked, built.fileCount);
  assert.ok(result.repo_files_checked >= 15, 'verification covered the live repository files');
  assert.equal(result.mode, 'ephemeral');
});

test('the bundle hashes cover every guarantee-tree path', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { outDir } = await realBundle(dir);
  const manifest = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8'));
  for (const rel of allGuaranteePaths()) {
    assert.ok(
      typeof manifest.payload.files[`tree/${rel}`] === 'string',
      `missing hash for tree file: ${rel}`,
    );
  }
  assert.equal(manifest.payload.guarantees.length, 12);
  assert.ok(manifest.signature.value.length > 0);
  assert.equal(manifest.signature.alg, 'ed25519');
});

// ---------------------------------------------------------------------------
// Sabotage: any change must invalidate the bundle
// ---------------------------------------------------------------------------

test('editing the report inside the bundle ⇒ full rejection', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { outDir } = await realBundle(dir);

  const reportPath = path.join(outDir, 'report.json');
  const raw = await readFile(reportPath, 'utf8');
  const tampered = raw.replace('"patch_supported"', '"environment_masked"');
  assert.notEqual(tampered, raw, 'the simulated attack must actually change something');
  await writeFile(reportPath, tampered, 'utf8');

  const result = await verifyEvidenceBundle(outDir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('report.json')), result.errors.join(' | '));
});

test('editing a code file inside the bundle tree ⇒ rejection, and the signed verdict does not change', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { outDir } = await realBundle(dir);

  const clsPath = path.join(outDir, 'tree', 'core', 'src', 'classify.js');
  await writeFile(clsPath, `${await readFile(clsPath, 'utf8')}\n// edited after issuance`, 'utf8');

  const result = await verifyEvidenceBundle(outDir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('classify.js')), result.errors.join(' | '));
});

test('editing the manifest itself (the guarantee map) ⇒ signature broken', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { outDir } = await realBundle(dir);

  const mPath = path.join(outDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(mPath, 'utf8'));
  // Swap the code file referenced by G1 — a false chain from a guarantee to
  // code that does not implement it.
  manifest.payload.guarantees[0].implements[0] = 'README.md';
  await writeFile(mPath, JSON.stringify(manifest, null, 2), 'utf8');

  const result = await verifyEvidenceBundle(outDir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('Invalid signature')), result.errors.join(' | '));
});

test('deleting a file from the bundle ⇒ explicit rejection naming the file', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { outDir } = await realBundle(dir);
  await rm(path.join(outDir, 'scenario.json'));

  const result = await verifyEvidenceBundle(outDir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('scenario.json')), result.errors.join(' | '));
});

test('a bundle without manifest.json at all ⇒ clear rejection, not a crash', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-evidence-empty-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = await verifyEvidenceBundle(dir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('manifest.json')));
});

test('verification against a live tree: a file changed on disk after issuance is exposed', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-evidence-repo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // A miniature tree carrying every path the guarantee map references.
  const fakeRepo = path.join(dir, 'repo');
  for (const rel of allGuaranteePaths()) {
    const abs = path.join(fakeRepo, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, `// ${rel}\n`, 'utf8');
  }

  const scenarioPath = path.join(dir, 'scenario.json');
  const reportJsonPath = path.join(dir, 'report.json');
  const reportMdPath = path.join(dir, 'report.md');
  const src = await sharedSource();
  await writeFile(scenarioPath, JSON.stringify(demoScenario()), 'utf8');
  await writeFile(reportJsonPath, JSON.stringify(src.report), 'utf8');
  await writeFile(reportMdPath, src.markdown, 'utf8');

  const outDir = path.join(dir, 'bundle');
  await buildEvidenceBundle({ repoRoot: fakeRepo, outDir, reportJsonPath, reportMdPath, scenarioPath });

  // Before any edit: intact.
  const okFirst = await verifyEvidenceBundle(outDir, { repoRoot: fakeRepo });
  assert.equal(okFirst.ok, true, okFirst.errors.join(' | '));

  // After editing a live code file: the tampering is exposed.
  await writeFile(path.join(fakeRepo, 'core', 'src', 'classify.js'), '// tampered after issuance\n', 'utf8');
  const bad = await verifyEvidenceBundle(outDir, { repoRoot: fakeRepo });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('changed after the bundle was issued')), bad.errors.join(' | '));
});

// ---------------------------------------------------------------------------
// Keys and the canonical form
// ---------------------------------------------------------------------------

test('the ephemeral key is never written, and a fresh path is saved with mode 600', async (t) => {
  const eph = await loadOrCreateSigningKey(null);
  assert.equal(eph.mode, 'ephemeral');
  assert.match(eph.privateKeyPem, /BEGIN PRIVATE KEY/);
  assert.match(eph.publicKeyPem, /BEGIN PUBLIC KEY/);

  const dir = await mkdtemp(path.join(tmpdir(), 'ac-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const keyPath = path.join(dir, 'signing.pem');
  const first = await loadOrCreateSigningKey(keyPath);
  assert.equal(first.mode, 'generated');
  const again = await loadOrCreateSigningKey(keyPath);
  assert.equal(again.mode, 'persisted');
  assert.equal(again.keyId, first.keyId, 'reuse preserves the same chain');

  const { statSync } = await import('node:fs');
  const mode = statSync(keyPath).mode & 0o777;
  assert.equal(mode, 0o600, `the private-key mode must be 600, was ${mode.toString(8)}`);
});

test('the canonical form is unaffected by key order — and the signature proves it', async () => {
  const a = { z: 1, a: { y: 2, b: [3, null, 'x'] } };
  const b = { a: { b: [3, null, 'x'], y: 2 }, z: 1 };
  assert.equal(stableStringify(a), stableStringify(b));

  const key = await loadOrCreateSigningKey(null);
  const { signPayload, verifyPayloadSignature } = await import('../src/evidence.js');
  const sig = signPayload(a, key.privateKeyPem);
  assert.equal(verifyPayloadSignature(b, sig, key.publicKeyPem), true, 'key reordering does not break the signature');
  assert.equal(verifyPayloadSignature({ ...b, z: 2 }, sig, key.publicKeyPem), false, 'a changed value does break it');
});

// ---------------------------------------------------------------------------
// The printable version
// ---------------------------------------------------------------------------

test('the printable version carries the verdict, the limitations, the LTR direction and the bundle stamp', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-print-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { outDir } = await realBundle(dir);
  const html = await readFile(path.join(outDir, 'report.html'), 'utf8');
  const report = JSON.parse(await readFile(path.join(outDir, 'report.json'), 'utf8'));

  assert.match(html, /<html lang="en" dir="ltr">/);
  assert.match(html, /<h2>Verdict limitations<\/h2>/);
  assert.ok(html.includes('Patch supported'), 'the human-readable label appears, not just the raw code');
  assert.ok(html.includes(report.reason), 'the verdict reason is carried verbatim');
  assert.ok(html.includes('@media print'), 'print-ready styles for Print → Save as PDF');
  assert.ok(html.includes('Public-key fingerprint'), 'the bundle stamp appears in the printed document');

  // Same inputs ⇒ same page (reproducible).
  const again = renderPrintHtml(report, { keyId: 'k', created: 'c', bundleName: 'b' });
  const once = renderPrintHtml(report, { keyId: 'k', created: 'c', bundleName: 'b' });
  assert.equal(once, again);
});

// ---------------------------------------------------------------------------
// The published interface: the CLI exactly as a third party would use it
// ---------------------------------------------------------------------------

test('built on another machine: build via CLI then verify via CLI succeed — and sabotage exits with code 1', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const scenario = { ...demoScenario() };
  const src = await sharedSource();

  const scenarioPath = path.join(dir, 'scenario.json');
  const reportJsonPath = path.join(dir, 'report.json');
  const reportMdPath = path.join(dir, 'report.md');
  await writeFile(scenarioPath, JSON.stringify(scenario), 'utf8');
  await writeFile(reportJsonPath, JSON.stringify(src.report), 'utf8');
  await writeFile(reportMdPath, `${src.markdown}\n`, 'utf8');

  const outDir = path.join(dir, 'bundle');
  const { stdout: buildOut } = await execFileAsync(process.execPath, [
    path.join(CORE_BIN, 'aegiscode-evidence.js'),
    'build',
    '--report-json', reportJsonPath,
    '--report-md', reportMdPath,
    '--scenario', scenarioPath,
    '--repo', REPO_ROOT,
    '--out', outDir,
  ]);
  assert.match(buildOut, /Bundle written/);
  assert.match(buildOut, /patch_supported/);

  const { stdout: verifyOut } = await execFileAsync(process.execPath, [
    path.join(CORE_BIN, 'aegiscode-evidence.js'),
    'verify',
    '--bundle', outDir,
    '--repo', REPO_ROOT,
  ]);
  assert.match(verifyOut, /Bundle intact/);

  // Sabotage: inject text into a report inside the bundle, then expect a
  // rejection with exit code 1.
  await writeFile(path.join(outDir, 'report.md'), `${src.markdown}\ninjected text`, 'utf8');

  let exitCode = 0;
  try {
    await execFileAsync(process.execPath, [
      path.join(CORE_BIN, 'aegiscode-evidence.js'),
      'verify',
      '--bundle', outDir,
    ]);
  } catch (err) {
    exitCode = err.code;
  }
  assert.equal(exitCode, 1, 'a compromised bundle must exit with code 1, not crash');

  // And a command without mandatory arguments exits with code 2 and a usage message.
  let usageCode = 0;
  try {
    await execFileAsync(process.execPath, [path.join(CORE_BIN, 'aegiscode-evidence.js'), 'verify']);
  } catch (err) {
    usageCode = err.code;
  }
  assert.equal(usageCode, 2);
});
