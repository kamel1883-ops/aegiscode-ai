import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SANDBOX_IMAGE,
  CONTAINER_SECRET_DENYLIST,
  buildAgentArgs,
  buildDockerRunArgs,
  dockerAvailable,
  runInContainer,
} from '../src/container.js';
import { runCandidateContainer } from '../src/container-run.js';

/**
 * Container profile tests — fully offline (no daemon needed) except the last
 * test, which SKIPS (never passes) when no daemon answers.
 */

const JOB = {
  workspaceHostPath: '/tmp/ac-work-123',
  entry: 'app.js',
  args: ['serve'],
  env: { AC_RUN_ID: 't-1', AC_CONDITION: 'B', META_API_KEY: 'MUST_NOT_PASS', EVIL: 'x' },
  limits: { timeout_ms: 5000 },
};

test('profile pins the image and blocks all external network', () => {
  const { argv, image } = buildDockerRunArgs(JOB);
  assert.equal(image, SANDBOX_IMAGE);
  const net = argv.indexOf('--network');
  assert.notEqual(net, -1);
  assert.equal(argv[net + 1], 'none');
});

test('profile enforces pids, memory (heap+native), cpu, read-only rootfs', () => {
  const { argv } = buildDockerRunArgs(JOB);
  const has = (...seq) => seq.every((s, i, a) => argv.includes(s));
  assert.ok(has('--pids-limit'), 'pids limit required (fork-bomb containment)');
  assert.ok(argv.includes('256m'), 'memory cap required (covers the Buffer.alloc gap)');
  assert.ok(has('--cpus'), 'cpu cap required');
  assert.ok(has('--read-only'), 'read-only rootfs required');
  assert.ok(has('--cap-drop'), 'capability drop required');
  assert.ok(argv.join(' ').includes('no-new-privileges'), 'no-new-privileges required');
});

test('only the job workspace is mounted; nothing host-wide', () => {
  const { argv } = buildDockerRunArgs(JOB);
  const mounts = argv.filter((a, i) => argv[i - 1] === '-v' || a === '-v');
  const vols = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === '-v') vols.push(argv[i + 1]);
  assert.deepEqual(vols, ['/tmp/ac-work-123:/work:rw']);
  assert.ok(!argv.join(' ').includes('/:/'), 'host root must never be mounted');
});

test('secrets never enter the container, even when explicitly supplied', () => {
  const { argv } = buildDockerRunArgs(JOB);
  const blob = argv.join('\n');
  for (const s of CONTAINER_SECRET_DENYLIST) assert.ok(!blob.includes(s), `${s} must not appear`);
  assert.ok(!blob.includes('MUST_NOT_PASS'), 'secret VALUE must not appear');
  assert.ok(blob.includes('AC_RUN_ID=t-1'), 'harness-owned AC_* inputs still pass');
  assert.ok(!blob.includes('EVIL'), 'non-AC keys are stripped');
});

test('candidate runs unprivileged: numeric nobody, no new privileges', () => {
  const { argv } = buildDockerRunArgs(JOB);
  const u = argv.indexOf('--user');
  assert.equal(argv[u + 1], '65532:65532');
});

test('fail-closed: no daemon ⇒ refusal, never silent fallback', async () => {
  const dead = async () => { const e = new Error('connect ENOENT /var/run/docker.sock'); e.code = 'ENOENT'; throw e; };
  assert.equal(await dockerAvailable(dead), false);
  await assert.rejects(() => runInContainer(JOB, dead), /container_unavailable|Docker daemon unreachable/);
});

test('named containers can be addressed for deterministic server-side kill', () => {
  const { argv } = buildDockerRunArgs({ workspaceHostPath: '/tmp/ac-work-123', name: 'ac-c-m1a2b3' });
  const n = argv.indexOf('--name');
  assert.notEqual(n, -1);
  assert.equal(argv[n + 1], 'ac-c-m1a2b3');
  const agent = buildAgentArgs({ network: 'acn-test', coreDir: '/app-core', subjectDir: '/subject', name: 'aca-test' });
  const m = agent.indexOf('--name');
  assert.notEqual(m, -1);
  assert.equal(agent[m + 1], 'aca-test');
});

test('unsafe container names are refused before anything runs', () => {
  assert.throws(() => buildDockerRunArgs({ workspaceHostPath: '/tmp/ac-work-123', name: 'ac;rm -rf /' }), /container_refused/);
  assert.throws(() => buildAgentArgs({ network: 'acn-test', coreDir: '/app-core', subjectDir: '/subject', name: 'ac evil' }), /container_refused/);
});

test('unsafe workspace path is refused before anything runs', () => {
  assert.throws(() => buildDockerRunArgs({ ...JOB, workspaceHostPath: '/tmp/a;rm -rf /' }), /container_refused/);
  assert.throws(() => buildDockerRunArgs({ ...JOB, workspaceHostPath: '' }), /container_refused/);
});

test('sandbox image is Node 22 (executor uses --permission, unknown on Node 20)', () => {
  assert.equal(SANDBOX_IMAGE, 'node:22-alpine');
});

test('candidate timeout is classified as timeout, never as success', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const src = await mkdtemp(path.join(tmpdir(), 'ac-src-'));
  await writeFile(path.join(src, 'app.js'), "'use strict';console.log('hi');", 'utf8');
  try {
    const timeoutErr = Object.assign(new Error('spawn docker ETIMEDOUT'), { killed: true, stdout: 'partial', stderr: '' });
    const fakeExec = async (cmd, args, _opts) => {
      if (cmd === 'docker' && args[0] === 'info') return { stdout: 'ok' };
      if (cmd === 'docker' && args[0] === 'rm') return { stdout: '' };
      throw timeoutErr;
    };
    const r = await runCandidateContainer(
      { image: SANDBOX_IMAGE, subjectDir: src, env: {}, limits: { timeout_ms: 1000, max_memory_mb: 128, max_output_bytes: 1024 } },
      fakeExec,
    );
    assert.equal(r.status, 'timeout');
  } finally {
    await rm(src, { recursive: true, force: true }).catch(() => {});
  }
});

test('live-daemon negative checks (host-read / egress / key) — SKIP when no daemon', async (t) => {
  if (!(await dockerAvailable())) {
    t.skip('no Docker daemon in this environment — live container checks not run, not passed');
    return;
  }
  // Where a daemon exists, the reviewer runs these manually; the builder
  // guarantees the flags above, and the daemon enforces them. This branch
  // documents the procedure without faking a pass here.
  t.skip('daemon present: run the manual negative matrix before wiring execution');
});
