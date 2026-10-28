/**
 * AegisCode — public API (Phase Zero)
 *
 * Workflow:
 *   validate scenario → run the four-condition matrix → causal classification → report
 *
 * Nothing here modifies a repository or auto-merges any change: the output is a
 * verdict plus evidence, and adoption stays human.
 */

import { validateScenario } from './schema.js';
import { classify, VERDICTS, CONDITIONS } from './classify.js';
import { runMatrix } from './matrix.js';
import { buildReport } from './report.js';

export { validateScenario, classify, runMatrix, buildReport, VERDICTS, CONDITIONS };

/**
 * Runs a full causal-verification experiment.
 *
 * @param {object} rawScenario scenario schema with its eight mandatory fields
 * @param {{original:string, patched:string}} subjects paths to the original and patched code directories
 * @returns {Promise<{ok:boolean, errors?:string[], verdict?:string, report?:object, markdown?:string}>}
 */
export async function verify(rawScenario, subjects, opts = {}) {
  const { ok, errors, scenario } = validateScenario(rawScenario);
  if (!ok) {
    return { ok: false, errors };
  }
  if (!subjects || typeof subjects.original !== 'string' || typeof subjects.patched !== 'string') {
    return { ok: false, errors: ['Both the original and the patched code paths must be provided.'] };
  }

  const jobId = typeof opts?.jobId === 'string' ? opts.jobId : null;
  const transports = opts?.transports ?? null;
  let matrixOut;
  try {
    matrixOut = await runMatrix({ scenario, subjects, jobId, transports });
  } catch (err) {
    // Infrastructure refusal (unknown sandbox, no daemon) is a rejection of
    // the job — never a silent fallback and never a candidate verdict.
    if (String(err?.message ?? '').startsWith('sandbox_refused') || err?.code === 'container_unavailable') {
      return { ok: false, errors: [String(err?.message ?? err)], infra_refused: true };
    }
    throw err;
  }
  const { observations, conditions, isolation } = matrixOut;
  const classification = classify(observations);
  const { report, markdown } = buildReport({ scenario, classification, conditions, observations, isolation });

  return { ok: true, verdict: classification.verdict, report, markdown };
}
