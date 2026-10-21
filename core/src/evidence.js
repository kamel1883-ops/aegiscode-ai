/**
 * AegisCode — third-party evidence bundle (Phase Five)
 *
 * The purpose of this package is that it is **presented to a third party** and
 * verifiable by them, without trusting us absolutely:
 *
 *  1. Every guarantee the system claims is mapped to **the code file that
 *     implements it** and **the test that proves it** — and those files are
 *     copied into the bundle (`tree/`) and pinned by SHA-256 hashes.
 *  2. The whole bundle is carried by an **Ed25519 signature** over the manifest:
 *     any edit — report, guarantee map, code file — invalidates the signature.
 *  3. Verification needs no external dependency: the Node standard library only.
 *
 * Two explicit statements about trust:
 *  - A signature without a pre-pinned key proves **content integrity and that
 *     the bundle was touched**, not the signer's identity. Whoever hands a
 *     bundle to a third party must deliver their public key separately.
 *  - The key in CI is "ephemeral": generated per run and never attached to the
 *     output — the private half never leaves memory; only the public half ships
 *     in the bundle.
 *
 * Nothing here modifies a repository or merges a change: the bundle is exported,
 * never imported.
 */

import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { renderPrintHtml } from './print.js';

export const BUNDLE_SCHEMA = 'aegiscode.evidence/0.1';

/**
 * The guarantee map — the heart of the bundle:
 * each guarantee ← the code file that implements it ← the test that proves it.
 * All paths are **relative to the repository root** and are copied into
 * `tree/` when the bundle is built.
 */
export const GUARANTEE_MAP = Object.freeze([
  Object.freeze({
    id: 'G1',
    kind: 'method',
    summary: 'Verification method: prepare two versions, an external policy and a workspace per run, two baseline conditions, two substituted-resource conditions, execution evidence, a bar on issuing any verdict without it, then four causal classifications.',
    implements: Object.freeze([
      'core/src/schema.js',
      'core/src/executor.js',
      'core/src/matrix.js',
      'core/src/resource.js',
      'core/src/classify.js',
    ]),
    verified_by: Object.freeze([
      Object.freeze({ file: 'core/test/e2e.test.js', focus: 'real patch ⇒ patch_supported and fake patch ⇒ environment_masked' }),
      Object.freeze({ file: 'core/test/classify.test.js', focus: 'the classifier emits one of four verdicts, always with a reason and limitations' }),
      Object.freeze({ file: 'core/test/schema.test.js', focus: 'the eight mandatory fields — every missing field fails validation' }),
      Object.freeze({ file: 'core/test/phase1.test.js', focus: 'screen (6): the separate agent and the validity gate both bar a fix verdict' }),
    ]),
  }),
  Object.freeze({
    id: 'G2',
    kind: 'dependent',
    summary: 'Execution evidence is captured via a readiness certificate the coordinator sends to the resource before running the code and independently of its behavior.',
    implements: Object.freeze(['core/src/resource.js', 'core/src/runner.js', 'core/src/matrix.js']),
    verified_by: Object.freeze([
      Object.freeze({ file: 'core/test/phase1.test.js', focus: 'the validity gate really preceded subject execution — proven by timestamp, not by assertion' }),
      Object.freeze({ file: 'core/test/phase1.test.js', focus: 'the readiness certificate carries the run id, the body and the timestamp' }),
    ]),
  }),
  Object.freeze({
    id: 'G3',
    kind: 'dependent',
    summary: 'The default resource is a loopback server on a random port, with no external network access at all, and the schema rejects any other kind.',
    implements: Object.freeze(['core/src/resource.js', 'core/src/schema.js', 'core/src/isolation.js']),
    verified_by: Object.freeze([
      Object.freeze({ file: 'core/test/e2e.test.js', focus: 'the default resource stays on loopback — no external internet' }),
      Object.freeze({ file: 'core/test/schema.test.js', focus: 'a non-loopback resource is rejected' }),
    ]),
  }),
  Object.freeze({
    id: 'G4',
    kind: 'dependent',
    summary: 'Timeout, crash, or an incomplete run = a failure state that bars a fix verdict — never classified as success.',
    implements: Object.freeze(['core/src/executor.js', 'core/src/classify.js']),
    verified_by: Object.freeze([
      Object.freeze({ file: 'core/test/classify.test.js', focus: 'timeout and crash are classified inconclusive, not successful' }),
      Object.freeze({ file: 'core/test/e2e.test.js', focus: 'a hanging subject ⇒ inconclusive attributed to test failure' }),
    ]),
  }),
  Object.freeze({
    id: 'G5',
    kind: 'dependent',
    summary: 'An environment setup failure is recorded in a log separate from the test-failure log — neither is ever counted in place of the other.',
    implements: Object.freeze(['core/src/report.js']),
    verified_by: Object.freeze([
      Object.freeze({ file: 'core/test/phase1.test.js', focus: 'the two failure logs stay separate: each failure is attributed to its own log' }),
    ]),
  }),
  Object.freeze({
    id: 'G6',
    kind: 'dependent',
    summary: 'A scenario definition includes the eight mandatory fields.',
    implements: Object.freeze(['core/src/schema.js']),
    verified_by: Object.freeze([
      Object.freeze({ file: 'core/test/schema.test.js', focus: 'all eight fields are mandatory in both the documentation and the code' }),
    ]),
  }),
  Object.freeze({
    id: 'G7',
    kind: 'dependent',
    summary: 'Premise stability requires the event to recur in the original with the resource guaranteed; otherwise the result is inconclusive.',
    implements: Object.freeze(['core/src/classify.js']),
    verified_by: Object.freeze([
      Object.freeze({ file: 'core/test/classify.test.js', focus: 'premise_not_established when the event does not recur in B' }),
      Object.freeze({ file: 'core/test/phase1.test.js', focus: 'deliberate sabotage 2: a resource that does not exhibit the flaw ⇒ inconclusive' }),
    ]),
  }),
  Object.freeze({
    id: 'G8',
    kind: 'dependent',
    summary: 'The report states the reason, the evidence and the limitations, compares against the conventional single test, and shows whether that test was misleading.',
    implements: Object.freeze(['core/src/report.js', 'core/src/classify.js']),
    verified_by: Object.freeze([
      Object.freeze({ file: 'core/test/e2e.test.js', focus: 'two patches, one conventional test result — and the system exposes the false result' }),
      Object.freeze({ file: 'core/test/classify.test.js', focus: 'the conventional test would have produced a false result' }),
    ]),
  }),
  Object.freeze({
    id: 'G9',
    kind: 'independent',
    summary: 'System: clean workspace, separate execution unit, matrix runner, loopback resource, validity gate, causal classifier, and a decider that separates the two failure logs.',
    implements: Object.freeze([
      'core/src/executor.js',
      'core/src/runner.js',
      'core/src/matrix.js',
      'core/src/resource.js',
      'core/src/classify.js',
      'core/src/report.js',
    ]),
    verified_by: Object.freeze([
      Object.freeze({ file: 'core/test/phase1.test.js', focus: 'code never runs in the coordinator process — every condition goes through the separate agent' }),
      Object.freeze({ file: 'core/test/phase1.test.js', focus: 'the workspace-deletion certificate is checked on disk, never assumed' }),
      Object.freeze({ file: 'core/test/e2e.test.js', focus: 'the full four-condition matrix over four crossed conditions' }),
    ]),
  }),
  Object.freeze({
    id: 'G10',
    kind: 'dependent',
    summary: 'The code never runs inside the web-server process — only inside its child execution agent.',
    implements: Object.freeze(['core/src/runner.js', 'core/src/executor.js']),
    verified_by: Object.freeze([
      Object.freeze({ file: 'core/test/phase1.test.js', focus: 'subject pid ≠ coordinator pid and agent pid ≠ coordinator pid' }),
      Object.freeze({ file: 'server/test/accounts.test.js', focus: 'the web UI is served as static files — no code execution' }),
    ]),
  }),
  Object.freeze({
    id: 'G11',
    kind: 'dependent',
    summary: 'The workspace is deleted after every attempt and no prior run residue is ever shared — and the deletion is verified, not assumed.',
    implements: Object.freeze(['core/src/executor.js']),
    verified_by: Object.freeze([
      Object.freeze({ file: 'core/test/phase1.test.js', focus: 'every workspace really was deleted — checked by existence on disk' }),
    ]),
  }),
  Object.freeze({
    id: 'G12',
    kind: 'dependent',
    summary: 'No auto-merge and no modification of a real repository: the system emits the verdict and the evidence only, and adoption is a one-time documented human decision.',
    implements: Object.freeze(['server/src/store.js', 'server/src/api.js', 'server/src/queue.js']),
    verified_by: Object.freeze([
      Object.freeze({ file: 'server/test/api.test.js', focus: 'no merge interface and no code modification: merge/apply/commit are rejected with 405' }),
      Object.freeze({ file: 'server/test/api.test.js', focus: 'full cycle: request → verdict → documented human decision' }),
      Object.freeze({ file: 'server/test/api.test.js', focus: 'a decision without a reason, with an empty name, or after an earlier decision is rejected' }),
    ]),
  }),
]);

/** Every reference path in the map — for internal uses and tests. */
export function allGuaranteePaths() {
  const paths = new Set();
  for (const entry of GUARANTEE_MAP) {
    for (const p of entry.implements) paths.add(p);
    for (const v of entry.verified_by) paths.add(v.file);
  }
  return [...paths];
}

/** SHA-256 fingerprint of a text file. */
export function sha256Hex(bufferOrString) {
  return createHash('sha256').update(bufferOrString).digest('hex');
}

/**
 * JSON with **sorted** keys — the canonical form that gets signed.
 * Without it the signature changes on any key reordering, so verification
 * would fail with no real change.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Loads or generates an Ed25519 signing key.
 *  - Without `keyPath`: an **ephemeral** key — never written to disk.
 *  - With a missing path: generated and written once with mode 600.
 *  - With an existing path: read and validated as a usable key.
 *
 * @returns {Promise<{publicKeyPem:string, privateKeyPem:string, mode:'ephemeral'|'persisted'|'generated', keyId:string}>}
 */
export async function loadOrCreateSigningKey(keyPath = null) {
  const makePair = () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return {
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    };
  };

  if (!keyPath) {
    const pair = makePair();
    return { ...pair, mode: 'ephemeral', keyId: sha256Hex(pair.publicKeyPem) };
  }

  const resolved = path.resolve(keyPath);
  if (existsSync(resolved)) {
    const pem = await readFile(resolved, 'utf8');
    let publicPem;
    try {
      publicPem = createPublicKey(pem).export({ type: 'spki', format: 'pem' });
    } catch {
      throw new Error(`Key file is not a valid Ed25519 key: ${resolved}`);
    }
    return {
      publicKeyPem: publicPem,
      privateKeyPem: pem,
      mode: 'persisted',
      // The public key's fingerprint is kept in every mode — otherwise the
      // fingerprint would differ on reuse of the same key and verification
      // would break with no real change.
      keyId: sha256Hex(publicPem),
    };
  }

  const pair = makePair();
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, pair.privateKeyPem, { encoding: 'utf8', mode: 0o600 });
  return { ...pair, mode: 'generated', keyId: sha256Hex(pair.publicKeyPem) };
}

/** Signs a payload with an Ed25519 private key. */
export function signPayload(payload, privateKeyPem) {
  const sig = cryptoSign(null, Buffer.from(stableStringify(payload), 'utf8'), createPrivateKey(privateKeyPem));
  return sig.toString('base64');
}

/** Verifies a payload signature with a public key — a pure function, no files. */
export function verifyPayloadSignature(payload, signatureBase64, publicKeyPem) {
  try {
    return cryptoVerify(
      null,
      Buffer.from(stableStringify(payload), 'utf8'),
      createPublicKey(publicKeyPem),
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * Builds a full evidence bundle in `outDir`.
 *
 * Bundle contents:
 *   manifest.json     the manifest + signature (the signature covers the manifest)
 *   public.pem        the public key — the only one that ships
 *   report.json/md    the report exactly as the core emitted it
 *   report.html       printable (LTR) version for external reviewers
 *   scenario.json     the scenario as submitted
 *   audit.jsonl       the server audit log, if provided
 *   tree/<path>       copies of the code and test files referenced in the guarantee map
 *
 * @param {object} p
 * @param {string} p.repoRoot     repository root (guarantee-map paths are taken from it)
 * @param {string} p.outDir       bundle output directory
 * @param {string} p.reportJsonPath
 * @param {string} p.reportMdPath
 * @param {string} p.scenarioPath
 * @param {string} [p.auditPath]  server audit log, if any
 * @param {string} [p.keyPath]    private-key path (optional; without it an ephemeral key is generated)
 * @returns {Promise<{ok:true, outDir:string, keyId:string, mode:string, fileCount:number, verdict:string, created_at:string}>}
 */
export async function buildEvidenceBundle({
  repoRoot,
  outDir,
  reportJsonPath,
  reportMdPath,
  scenarioPath,
  auditPath = null,
  keyPath = null,
}) {
  const root = path.resolve(repoRoot);
  const out = path.resolve(outDir);

  let report;
  try {
    report = JSON.parse(await readFile(path.resolve(reportJsonPath), 'utf8'));
  } catch (err) {
    throw new Error(`Could not read the JSON report: ${err?.message ?? err}`);
  }
  if (!report || typeof report.verdict !== 'string' || !Array.isArray(report.limitations)) {
    throw new Error('Invalid JSON report: it must carry verdict and limitations — a bundle is never built on an incomplete report.');
  }

  // Every file in the guarantee map must actually exist in the repository —
  // otherwise the map is false.
  const referenced = allGuaranteePaths();
  const missing = referenced.filter((rel) => !existsSync(path.join(root, rel)));
  if (missing.length > 0) {
    throw new Error(
      `The guarantee map points to files missing from the repository (complete the tree before building the bundle): ${missing.join(', ')}`,
    );
  }

  const key = await loadOrCreateSigningKey(keyPath);

  // (1) Prepare the unsigned outputs first: file copies, guarantee tree, print version.
  await mkdir(out, { recursive: true });

  const reportMd = await readFile(path.resolve(reportMdPath), 'utf8');
  const scenarioText = await readFile(path.resolve(scenarioPath), 'utf8');
  let auditText = null;
  if (auditPath) auditText = await readFile(path.resolve(auditPath), 'utf8');

  await writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(path.join(out, 'report.md'), reportMd, 'utf8');
  await writeFile(path.join(out, 'scenario.json'), scenarioText, 'utf8');
  await writeFile(path.join(out, 'public.pem'), key.publicKeyPem, 'utf8');
  if (auditText !== null) await writeFile(path.join(out, 'audit.jsonl'), auditText, 'utf8');

  await mkdir(path.join(out, 'tree'), { recursive: true });
  for (const rel of referenced) {
    const dest = path.join(out, 'tree', rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(path.join(root, rel), dest, { force: true });
  }

  const html = renderPrintHtml(report, {
    keyId: key.keyId,
    created: new Date().toISOString(),
    bundleName: path.basename(out),
  });
  await writeFile(path.join(out, 'report.html'), html, 'utf8');

  // (2) Hash every bundle file — and the signature covers all of these hashes.
  const files = {};
  const bundleFiles = ['report.json', 'report.md', 'report.html', 'scenario.json', 'public.pem'];
  if (auditText !== null) bundleFiles.push('audit.jsonl');
  for (const rel of bundleFiles) {
    files[rel] = sha256Hex(await readFile(path.join(out, rel)));
  }
  for (const rel of referenced) {
    files[`tree/${rel}`] = sha256Hex(await readFile(path.join(out, 'tree', rel)));
  }

  const payload = {
    schema: BUNDLE_SCHEMA,
    created_at: new Date().toISOString(),
    signing: { mode: key.mode, key_sha256: key.keyId },
    report: {
      id: report.scenario?.id ?? null,
      verdict: report.verdict,
      reason_code: report.reason_code ?? null,
      generated_at: report.generated_at ?? null,
    },
    guarantees: GUARANTEE_MAP.map((g) => ({
      id: g.id,
      kind: g.kind,
      summary: g.summary,
      implements: [...g.implements],
      verified_by: g.verified_by.map((v) => ({ ...v })),
    })),
    files,
  };

  const signature = {
    alg: 'ed25519',
    key_sha256: key.keyId,
    value: signPayload(payload, key.privateKeyPem),
  };

  await writeFile(path.join(out, 'manifest.json'), `${JSON.stringify({ payload, signature }, null, 2)}\n`, 'utf8');

  return {
    ok: true,
    outDir: out,
    keyId: key.keyId,
    mode: key.mode,
    fileCount: Object.keys(files).length,
    verdict: report.verdict,
    created_at: payload.created_at,
  };
}

/**
 * Verifies an evidence bundle:
 *  1. Read the manifest and confirm the signature covers an unchanged manifest.
 *  2. Match every file hash in the manifest against the actual file.
 *  3. Optionally (`repoRoot`): match the live tree — did the code change after
 *     the bundle was issued?
 *
 * @param {string} bundleDir
 * @param {{repoRoot?:string|null}} [opts]
 * @returns {Promise<{ok:boolean, errors:string[], checked:number, verdict:string|null,
 *   key_sha256:string|null, mode:string|null, repo_files_checked:number}>}
 */
export async function verifyEvidenceBundle(bundleDir, { repoRoot = null } = {}) {
  const dir = path.resolve(bundleDir);
  const errors = [];
  let checked = 0;
  let repoChecked = 0;

  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  } catch (err) {
    return {
      ok: false,
      errors: [`Could not read manifest.json: ${err?.message ?? err}`],
      checked: 0,
      verdict: null,
      key_sha256: null,
      mode: null,
      repo_files_checked: 0,
    };
  }

  const payload = manifest?.payload;
  const signature = manifest?.signature;
  if (!payload || !signature) {
    return {
      ok: false,
      errors: ['The manifest or the signature is missing from manifest.json.'],
      checked: 0,
      verdict: payload?.report?.verdict ?? null,
      key_sha256: null,
      mode: null,
      repo_files_checked: 0,
    };
  }

  if (payload.schema !== BUNDLE_SCHEMA) {
    errors.push(`Unknown bundle schema: ${payload.schema} (expected ${BUNDLE_SCHEMA}).`);
  }

  // (1) Signature first: editing any byte of the manifest invalidates it.
  let publicKeyPem = null;
  try {
    publicKeyPem = await readFile(path.join(dir, 'public.pem'), 'utf8');
  } catch (err) {
    errors.push(`Could not read public.pem: ${err?.message ?? err}`);
  }

  if (publicKeyPem !== null) {
    if (signature.alg !== 'ed25519') {
      errors.push(`Unsupported signature algorithm: ${signature.alg}.`);
    }
    if (!verifyPayloadSignature(payload, signature.value, publicKeyPem)) {
      errors.push('Invalid signature: the manifest payload was edited or transformed after signing.');
    }
    if (payload.signing?.key_sha256 && signature.key_sha256 !== payload.signing.key_sha256) {
      errors.push('The manifest signing key does not match the signature-envelope key.');
    }
    if (payload.signing?.key_sha256 && sha256Hex(publicKeyPem) !== payload.signing.key_sha256) {
      errors.push('The attached public.pem is not the signing key announced in the manifest.');
    }
  }

  // (2) File hashes.
  const files = payload.files ?? {};
  for (const [rel, expected] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (!existsSync(abs)) {
      errors.push(`File missing from the bundle: ${rel}`);
      continue;
    }
    const actual = sha256Hex(await readFile(abs));
    checked += 1;
    if (actual !== expected) {
      errors.push(`Hash mismatch (modified): ${rel} — expected ${expected.slice(0, 12)}…, actual ${actual.slice(0, 12)}…`);
    }
  }

  // (3) Live-tree match: did the code change after the bundle was issued?
  if (repoRoot) {
    const root = path.resolve(repoRoot);
    for (const guarantee of payload.guarantees ?? []) {
      const targets = [...(guarantee.implements ?? []), ...(guarantee.verified_by ?? []).map((v) => v.file)];
      for (const rel of targets) {
        const abs = path.join(root, rel);
        const expected = files[`tree/${rel}`];
        if (!expected) {
          errors.push(`Guarantee ${guarantee.id} points to a file not covered by the bundle hashes: ${rel}`);
          continue;
        }
        if (!existsSync(abs)) {
          errors.push(`Live file missing from the repository: ${rel}`);
          continue;
        }
        repoChecked += 1;
        const actual = sha256Hex(await readFile(abs));
        if (actual !== expected) {
          errors.push(`Live file changed after the bundle was issued: ${rel}`);
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    checked,
    verdict: payload.report?.verdict ?? null,
    key_sha256: signature.key_sha256 ?? null,
    mode: payload.signing?.mode ?? null,
    repo_files_checked: repoChecked,
  };
}
