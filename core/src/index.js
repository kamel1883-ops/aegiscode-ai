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
export async function verify(rawScenario, subjects) {
  const { ok, errors, scenario } = validateScenario(rawScenario);
  if (!ok) {
    return { ok: false, errors };
  }
  if (!subjects || typeof subjects.original !== 'string' || typeof subjects.patched !== 'string') {
    return { ok: false, errors: ['Both the original and the patched code paths must be provided.'] };
  }

  const { observations, conditions, isolation } = await runMatrix({ scenario, subjects });
  const classification = classify(observations);
  const { report, markdown } = buildReport({ scenario, classification, conditions, observations, isolation });

  return { ok: true, verdict: classification.verdict, report, markdown };
}
