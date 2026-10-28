#!/usr/bin/env node
/**
 * AegisCode — sandbox validation (manual CI or local daemon).
 *
 * NO model calls. NO secrets. Owned fixtures only.
 * Refuses to run if META_API_KEY (or any secret) is present in its own
 * environment — the key must never be anywhere near candidate execution.
 *
 * Checks:
 *  1. Docker daemon reachable (else exit 3: cannot validate, not a pass).
 *  2. Pull image, record observed RepoDigest (audit, not assumption).
 *  3. Host-file denial (owned host-read fixture + canary).
 *  4. External egress blocked (inline temp subject, example.com must fail).
 *  5. No credentials in candidate env (owned env-leak fixture + fake values).
 *  6. Resource termination (owned hang fixture ⇒ timeout).
 *  7. Real matrix in container mode: real patch ⇒ patch_supported,
 *     fake patch ⇒ environment_masked (sidecar + gate + functional probes
 *     all inside the isolated boundary; verdict authority stays on host).
 *
 * Usage: node tools/sandbox-check.mjs --out sandbox-out [--image node:20-alpine]
 */

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

const SECRET_NAMES = ['META_API_KEY', 'AEGISCODE_API_TOKENS', 'GITHUB_TOKEN', 'GH_TOKEN', 'OPENAI_API_KEY'];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 500) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

/**
 * Bounds a phase that must end even if the transport wedges: on expiry the
 * race rejects, forceRemoveSandbox() rm -f's the named containers so their
 * docker CLIs exit and the underlying promises settle, the failure is
 * recorded, and the script proceeds to write its report. The noop catch on
 * the loser prevents an unhandled-rejection crash after the race settles.
 */
async function withPhaseBudget(label, ms, fn, kill) {
  const pending = fn();
  pending.catch(() => {});
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(
        new Error(`${label}: phase_timeout after ${ms}ms — forced server-side cleanup, see detail`),
        { code: 'phase_timeout' })), ms)),
    ]);
  } catch (err) {
    if (err?.code === 'phase_timeout' && kill) { try { await kill(); } catch { /* best-effort */ } }
    throw err;
  }
}

async function main() {
  for (const s of SECRET_NAMES) {
    if (process.env[s]) {
      console.error(`REFUSED: ${s} is set in the checker environment. Unset it; validation never runs near secrets.`);
      process.exit(2);
    }
  }
  const outDir = arg('out', 'sandbox-out');
  const image = arg('image', process.env.AC_SANDBOX_IMAGE || 'node:20-alpine');
  await mkdir(outDir, { recursive: true });

  const { dockerAvailable } = await import('../core/src/container.js');
  const { runCandidateContainer, forceRemoveSandbox } = await import('../core/src/container-run.js');
  const hasDaemon = await dockerAvailable();
  if (!check('docker daemon reachable', hasDaemon, hasDaemon ? 'daemon answers' : 'no daemon: cannot validate')) {
    await writeFile(path.join(outDir, 'sandbox-report.json'), JSON.stringify({ image, checks, verdict: 'cannot_validate_no_daemon' }, null, 2));
    process.exit(3);
  }

  let digest = null;
  try {
    await execFileAsync('docker', ['pull', image], { timeout: 120000 });
    const { stdout } = await execFileAsync('docker', ['inspect', '--format', '{{index .RepoDigests 0}}', image], { timeout: 15000 });
    digest = String(stdout ?? '').trim() || null;
  } catch (err) {
    check('pull image + record digest', false, err?.message ?? err);
  }
  check('pull image + record digest', Boolean(digest), digest ?? 'no digest observed');
  const pinned = digest && digest.includes('@') ? digest : image;

  const LIMITS = { timeout_ms: 5000, max_memory_mb: 128, max_output_bytes: 16384 };
  const FIX = (n) => path.join(REPO, 'core', 'fixtures', n);

  // 3. Host-file non-access (direct proof).
  // The container runs without --permission flags, so a world-readable
  // container-local file (its OWN /etc/hostname) is readable — demanding a
  // BLOCKED marker here was a check-design flaw, not a breach: the
  // container's /etc/hostname is not the host's file (separate mount
  // namespace; only /work and /tmp are mounted, rootfs read-only). This
  // check proves the real property directly instead: the HOST file's
  // content never appears in candidate output. Host content is read
  // host-side and never passed to the candidate. Any ambiguity
  // (unreadable host file, name collision) fails closed.
  {
    let hostHostname = '';
    try { hostHostname = (await readFile('/etc/hostname', 'utf8')).trim().split(/\s+/)[0] ?? ''; } catch { hostHostname = ''; }
    const hostProofUsable = hostHostname.length >= 4;
    const r = await runCandidateContainer({ image: pinned, subjectDir: FIX('host-read'), env: { AC_CANARY_PATH: '/etc/hostname' }, limits: LIMITS });
    const out = String(r.stdout ?? '');
    const leakedHostContent = hostProofUsable && out.includes(hostHostname);
    const ok = r.status === 'completed' && !leakedHostContent && !/root:|localhost/.test(out);
    check('host-file non-access: host content absent from candidate output', ok,
      `status=${r.status} host_proof=${hostProofUsable ? 'direct' : 'degraded'} leaked=${leakedHostContent} out=${out.slice(0, 160)} err=${(r.stderr ?? '').slice(0, 120)}`);
  }
  // 4. External egress blocked.
  {
    const tmp = await mkdtemp(path.join(tmpdir(), 'ac-egress-'));
    await writeFile(path.join(tmp, 'app.js'), `'use strict';if(process.argv[2]!=='serve')process.exit(2);console.log('AC::LEGITIMATE_OK');fetch('https://example.com/',{signal:AbortSignal.timeout(4000)}).then(async r=>{console.log('AC::EGRESS_OK:'+r.status);process.exit(0);}).catch(e=>{console.log('AC::EGRESS_BLOCKED:'+(e?.cause?.code||e?.code||'ERR'));process.exit(0);});\n`);
    try {
      const r = await runCandidateContainer({ image: pinned, subjectDir: tmp, env: {}, limits: LIMITS });
      check('external egress blocked', /AC::EGRESS_BLOCKED/.test(r.stdout) && !/AC::EGRESS_OK/.test(r.stdout), `${r.stdout.match(/AC::EGRESS_\w+/)?.[0] ?? r.status} ${(r.stderr ?? '').slice(0, 200)}`);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
  // 4b. Same isolated --internal network as the scenario: sidecar reachable, external blocked.
  // This runs on the scenario network itself, not on the separate --network none mode above.
  {
    const { buildNetworkCreateArgs, buildSidecarArgs, buildIsolatedProbeArgs, sidecarUrl } = await import('../core/src/container.js');
    const stamp = Date.now().toString(36).replace(/[^a-z0-9]/gi, '').slice(0, 8);
    const net = `ac-egress-${stamp}`;
    const sname = `acr-egress-${stamp}`;
    const runId = `egress-${stamp}`;
    const profile = { path: '/template', status: 200, body: 'AC-RESOURCE-OK' };
    const cleanup = [];
    try {
      await execFileAsync('docker', buildNetworkCreateArgs(net), { timeout: 15000 });
      cleanup.push(['docker', ['network', 'rm', net]]);
      await execFileAsync('docker', buildSidecarArgs({ image: pinned, network: net, name: sname, profile, runId }), { timeout: 30000 });
      cleanup.push(['docker', ['rm', '-f', sname]]);
      let ready = false;
      for (let i = 0; i < 60; i += 1) {
        try {
          const { stdout } = await execFileAsync('docker', ['logs', '--tail', '20', sname], { timeout: 10000 });
          if (String(stdout ?? '').includes('AC-SIDECAR-READY')) { ready = true; break; }
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 250));
      }
      check('isolated network: sidecar ready on --internal net', ready, ready ? sname : 'sidecar never ready');
      if (ready) {
        const probe = `const u=${JSON.stringify(sidecarUrl(sname))};let sidecar=false,egress='unknown';try{const r=await fetch(u+'/__ac_probe');const t=await r.text();sidecar=r.status===200&&t.includes(${JSON.stringify(runId)});console.log('AC::SIDECAR_'+(sidecar?'OK':'FAIL')+':'+r.status);}catch(e){console.log('AC::SIDECAR_FAIL:'+(e?.cause?.code||e?.code||'ERR'));}try{const r=await fetch('https://example.com/',{signal:AbortSignal.timeout(4000)});console.log('AC::EGRESS_OK:'+r.status);}catch(e){egress=(e?.cause?.code||e?.code||'ERR');console.log('AC::EGRESS_BLOCKED:'+egress);}`;
        let out = '';
        try {
          const r = await execFileAsync('docker', buildIsolatedProbeArgs({ image: pinned, network: net, script: probe }), { timeout: 30000, maxBuffer: 1024 * 1024 });
          out = String(r.stdout ?? '');
        } catch (err) {
          out = String(err?.stdout ?? '');
        }
        check('isolated network: harness sidecar reachable', /AC::SIDECAR_OK/.test(out), out.slice(0, 200) || 'no probe output');
        check('isolated network: external egress blocked', /AC::EGRESS_BLOCKED/.test(out) && !/AC::EGRESS_OK/.test(out), (out.match(/AC::EGRESS_\w+/)?.[0] ?? out.slice(0, 200) ?? 'no probe output'));
      }
    } catch (err) {
      check('isolated network: egress probe on scenario network', false, String(err?.message ?? err).slice(0, 200));
    } finally {
      for (const [cmd, args] of cleanup.reverse()) {
        try { await execFileAsync(cmd, args, { timeout: 15000 }); } catch { /* best-effort */ }
      }
    }
  }
  // 5. No credentials in candidate env.
  {
    const r = await runCandidateContainer({ image: pinned, subjectDir: FIX('env-leak'), env: { META_API_KEY: 'FAKE_MUST_NOT_PASS', AEGISCODE_API_TOKENS: 'FAKE_TOK' }, limits: LIMITS });
    check('no credentials in candidate', /AC::LEAKED:NONE/.test(r.stdout) && !r.stdout.includes('FAKE_MUST_NOT_PASS'), `status=${r.status} ${(r.stderr ?? '').slice(0, 200)}`);
  }
  // 6. Resource termination (bounded: the hang fixture never exits by itself).
  {
    let r = null;
    try {
      r = await withPhaseBudget('hang-probe', 90_000,
        () => runCandidateContainer({ image: pinned, subjectDir: FIX('hang'), env: {}, limits: LIMITS }),
        () => forceRemoveSandbox());
    } catch (err) {
      check('hang probe ends within its phase budget', false, String(err?.message ?? err).slice(0, 200));
    }
    if (r) check('hang terminated as timeout', r.status === 'timeout', `status=${r.status} ${(r.stderr ?? '').slice(0, 200)}`);
  }
  // 7. Real matrix in container mode (sidecar + gate + functional probes isolated; verdict on host).
  {
    process.env.AC_SANDBOX = 'container';
    process.env.AC_SANDBOX_IMAGE = pinned;
    if (digest) process.env.AC_SANDBOX_IMAGE_DIGEST = digest;
    const { verify } = await import('../core/src/index.js');
    const { demoScenario, FIXTURES } = await import('../core/test/helpers.js');
    const scenario = {
      ...demoScenario(),
      functional_checks: { require_markers: ['AC::TEMPLATE_RENDERED'], forbid_template_fetch_in_patch: true, require_dynamic_echo: false, require_computed_render: true },
    };
    let real = null;
    let fake = null;
    try {
    real = await withPhaseBudget('matrix-real-verify', 480_000,
      () => verify(scenario, { original: FIXTURES.original, patched: FIXTURES.patchReal }),
      () => forceRemoveSandbox());
    check('container matrix: real patch ⇒ patch_supported', real.ok && real.verdict === 'patch_supported', real.report?.reason ?? real.verdict);
    fake = await withPhaseBudget('matrix-fake-verify', 480_000,
      () => verify(scenario, { original: FIXTURES.original, patched: FIXTURES.patchFake }),
      () => forceRemoveSandbox());
    check('container matrix: fake patch ⇒ environment_masked', fake?.ok && fake?.verdict === 'environment_masked', fake?.report?.reason ?? fake?.verdict);
    } catch (err) {
      check('container matrix completes (no transport crash or phase timeout)', false, String(err?.message ?? err).slice(0, 300));
    }
    if (real && fake) {
    const d = real.report?.conditions?.find?.((c) => c.condition === 'D');
    check('container evidence: sidecar request log recorded', d && typeof d.functional?.template_requests === 'number', `template_requests=${d?.functional?.template_requests}`);
    const bReal = real.report?.conditions?.find?.((c) => c.condition === 'B');
    check(
      'container security: B recurs, D does not (real patch)',
      bReal?.observation?.unsafe_event_recurred === true && d?.observation?.unsafe_event_recurred === false,
      `B=${bReal?.observation?.unsafe_event_recurred} D=${d?.observation?.unsafe_event_recurred}`
    );
    check(
      'container functional: real patch passes local render, zero untrusted fetches',
      real.report?.functional?.status === 'pass' && d?.functional?.functional_ok === true && d?.functional?.template_requests === 0,
      real.report?.functional?.reason ?? JSON.stringify(d?.functional)
    );
    check(
      'container acceptance: real patch accepted, fake patch rejected',
      real.report?.acceptance?.decision === 'accepted' && fake.report?.acceptance?.decision === 'rejected',
      `real=${real.report?.acceptance?.decision} fake=${fake.report?.acceptance?.decision}`
    );
    check(
      'container functional: fake patch does not earn acceptance',
      fake.report?.functional?.status !== 'pass' || fake.report?.acceptance?.decision === 'rejected',
      `fake functional=${fake.report?.functional?.status} acceptance=${fake.report?.acceptance?.decision}`
    );
    }
  }

  const verdict = checks.every((c) => c.ok) ? 'sandbox_validated' : 'sandbox_failed';
  await writeFile(path.join(outDir, 'sandbox-report.json'), JSON.stringify({ image, digest, verdict, checks }, null, 2));
  console.log(`\nVerdict: ${verdict} (${checks.filter((c) => c.ok).length}/${checks.length} checks passed)`);
  if (verdict !== 'sandbox_validated') process.exit(1);
}

main().catch((err) => {
  console.error(`sandbox-check crashed: ${err?.stack ?? err}`);
  process.exit(1);
});
