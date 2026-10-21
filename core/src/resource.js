/**
 * AegisCode — synthetic resource + intervention-validity gate (Phase Zero)
 *
 * Isolation principle: the resource listens on **127.0.0.1 only** with a random
 * port, so the experiment never touches the external network.
 *
 * Gate principle: execution evidence is captured **by the coordinator itself**
 * via readiness probes issued before the subject code runs — never derived from
 * the subject's behavior. This distinction is essential: if the evidence came
 * from a request made by the subject code, a patch that *blocks* the connection
 * would fail the gate and be escalated to "inconclusive" — even though it is a
 * correct fix.
 */

import http from 'node:http';

/**
 * Starts a synthetic resource on loopback.
 *
 * @param {object} params
 * @param {{path:string,status:number,body:string}} params.profile
 * @param {string} params.runId run id, logged with every request to keep conditions separable
 * @returns {Promise<{url:string, requests:object[], stop:()=>Promise<void>, close:()=>Promise<void>}>}
 */
export async function startSyntheticResource({ profile, runId }) {
  const requests = [];

  const server = http.createServer((req, res) => {
    const record = {
      ts: new Date().toISOString(),
      run_id: runId,
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      remote_address: req.socket.remoteAddress ?? null,
    };
    requests.push(record);

    // Readiness path — used by the coordinator only, to prove the intervention ran.
    if (req.url === '/__ac_probe') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`AC-PROBE-OK:${runId}`);
      return;
    }

    const matches = req.url === profile.path || req.url?.startsWith(`${profile.path}?`);
    res.writeHead(matches ? profile.status : 404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(matches ? profile.body : 'not found');
  });

  // Loopback only — no external interface, no internet.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    stop: () => closeServer(server),
    close: () => closeServer(server),
  };
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/**
 * Intervention-validity gate.
 *
 * Proves the synthetic resource was **actually executed** in this condition,
 * before the subject code runs and independently of its behavior. If the gate
 * fails, any successful-looking result is blocked and the verdict is
 * "inconclusive".
 *
 * @param {object} resource the object returned by startSyntheticResource
 * @param {{min_probes:number, expect_status:number, expect_body_contains:string}} checks
 * @returns {Promise<{valid:boolean, probes:number, expected_status:number, actual_status:number|null,
 *   body_matched:boolean|null, reason:string}>}
 */
export async function verifyIntervention(resource, checks) {
  let actualStatus = null;
  let body = '';
  let transportError = null;

  try {
    const res = await fetch(`${resource.url}/__ac_probe`);
    actualStatus = res.status;
    body = await res.text();
  } catch (err) {
    transportError = String(err?.message ?? err);
  }

  const statusOk = actualStatus === checks.expect_status;
  const bodyOk = checks.expect_body_contains === '' || body.includes(checks.expect_body_contains);
  // The proof body is kept inside the certificate itself — material evidence, not a description.
  const bodyExcerpt = body.slice(0, 200);

  // Every request that actually reached the resource is recorded with its run id — auditable evidence.
  const probes = resource.requests.filter((r) => r.url === '/__ac_probe').length;

  if (transportError) {
    return {
      valid: false,
      probes,
      expected_status: checks.expect_status,
      actual_status: null,
      body_matched: null,
      body_excerpt: null,
      reason: `Could not reach the synthetic resource: ${transportError}`,
    };
  }

  if (probes < checks.min_probes) {
    return {
      valid: false,
      probes,
      expected_status: checks.expect_status,
      actual_status: actualStatus,
      body_matched: bodyOk,
      body_excerpt: bodyExcerpt,
      reason: `Readiness probes (${probes}) below the required minimum (${checks.min_probes}).`,
    };
  }

  if (!statusOk) {
    return {
      valid: false,
      probes,
      expected_status: checks.expect_status,
      actual_status: actualStatus,
      body_matched: bodyOk,
      body_excerpt: bodyExcerpt,
      reason: `Response status ${actualStatus} does not match the expected ${checks.expect_status}.`,
    };
  }

  if (!bodyOk) {
    return {
      valid: false,
      probes,
      expected_status: checks.expect_status,
      actual_status: actualStatus,
      body_matched: false,
      body_excerpt: bodyExcerpt,
      reason: 'Response body does not contain the expected proof marker.',
    };
  }

  return {
    valid: true,
    probes,
    expected_status: checks.expect_status,
    actual_status: actualStatus,
    body_matched: true,
    body_excerpt: bodyExcerpt,
    reason: 'The synthetic resource was proven to have executed before the subject code ran.',
  };
}
