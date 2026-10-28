import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inspectNetworkEvidence,
  parseEgressOutput,
  probeExternalEgress,
  EGRESS_PROBE_SCRIPT,
} from '../src/container-run.js';

/**
 * Network-evidence unit tests — fully offline (injected execFn, no daemon).
 * Covers: inspect parsing incl. Internal flag + attached containers,
 * inspect failure carrying its reason, and egress output classification.
 */

const NET_JSON = JSON.stringify([{
  Id: 'net-abc123',
  Name: 'acn-test',
  Internal: true,
  Labels: { 'ac.job': 'job-1', 'ac.condition': 'B', 'ac.run': 'ac-run-1' },
  Containers: {
    deadbeef: { Name: 'aca-test', IPv4Address: '10.0.0.2/24' },
    cafef00d: { Name: 'acr-test', IPv4Address: '10.0.0.3/24' },
  },
}]);

test('inspect records id, Internal flag, labels, and attached containers', async () => {
  const fakeExec = async () => ({ stdout: NET_JSON });
  const ev = await inspectNetworkEvidence(fakeExec, 'acn-test');
  assert.equal(ev.network_id, 'net-abc123');
  assert.equal(ev.internal, true);
  assert.deepEqual(ev.labels['ac.job'], 'job-1');
  assert.deepEqual(ev.attached.sort(), ['aca-test', 'acr-test']);
  assert.ok(!('inspect_error' in ev), 'no error field on success');
});

test('inspect failure records its reason instead of a bare null', async () => {
  const fakeExec = async () => { const e = new Error('simulated: dial unix /var/run/docker.sock: connect: no such file'); throw e; };
  const ev = await inspectNetworkEvidence(fakeExec, 'acn-test');
  assert.equal(ev.network_id ?? null, null);
  assert.match(ev.inspect_error, /no such file/);
});

test('egress output classification: blocked, open, unrecognized', () => {
  assert.equal(parseEgressOutput('noise\nEGRESS_BLOCKED:fetch failed\n').blocked, true);
  const open = parseEgressOutput('EGRESS_OPEN:200');
  assert.equal(open.blocked, false);
  assert.equal(parseEgressOutput('something else').blocked, null);
});

test('probe script is bounded and self-contained', () => {
  assert.ok(EGRESS_PROBE_SCRIPT.length < 8000, 'fits the isolated-probe limit');
  assert.ok(EGRESS_PROBE_SCRIPT.includes('EGRESS_BLOCKED') && EGRESS_PROBE_SCRIPT.includes('EGRESS_OPEN'));
});

test('probeExternalEgress maps daemon output and probe-container failure', async () => {
  const okExec = async () => ({ stdout: 'EGRESS_BLOCKED:fetch failed' });
  assert.equal((await probeExternalEgress(okExec, { image: 'img', network: 'net' })).blocked, true);
  const deadExec = async () => { throw new Error('simulated: container failed to start'); };
  const unknown = await probeExternalEgress(deadExec, { image: 'img', network: 'net' });
  assert.equal(unknown.checked, false);
  assert.equal(unknown.blocked, null);
});
