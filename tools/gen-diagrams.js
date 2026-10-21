#!/usr/bin/env node
/**
 * AegisCode AI — diagram generator (SVG, zero dependencies)
 *
 * Generates three English figures into ../assets/:
 *   fig1-the-problem.svg     The problem: a passing test that hides a live vulnerability
 *   fig2-causal-matrix.svg   The four-condition causal matrix and the four verdicts
 *   fig3-workflow-loop.svg   The end-to-end workflow loop
 *
 * Plain SVG text output — no rendering libraries, no font embedding.
 * SVG renders crisply in any browser and on GitHub.
 *
 * Usage: node tools/gen-diagrams.js
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets');

const C = {
  ink: '#0F172A',
  line: '#334155',
  muted: '#64748B',
  paper: '#FFFFFF',
  teal: '#0D9488',
  tealSoft: '#CCFBF1',
  red: '#B91C1C',
  redSoft: '#FEE2E2',
  amber: '#B45309',
  amberSoft: '#FEF3C7',
  green: '#15803D',
  greenSoft: '#DCFCE7',
  slateSoft: '#F1F5F9',
};

function esc(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Multi-line <text> from an array of lines. */
function textBlock(x, y, lines, { size = 14, weight = 400, fill = C.ink, anchor = 'start', gap = 1.35 } = {}) {
  return lines
    .map((l, i) => `<text x="${x}" y="${y + i * size * gap}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" font-family="Segoe UI, Arial, sans-serif">${esc(l)}</text>`)
    .join('\n  ');
}

function box(x, y, w, h, { fill = C.slateSoft, stroke = C.line, rx = 10, dash = null, sw = 1.5 } = {}) {
  const d = dash ? ` stroke-dasharray="${dash}"` : '';
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${d}/>`;
}

function arrow(x1, y1, x2, y2, { color = C.line, dash = null, sw = 2 } = {}) {
  const d = dash ? ` stroke-dasharray="${dash}"` : '';
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${sw}"${d} marker-end="url(#arrow-${color.slice(1)})"/>`;
}

function arrowDefs() {
  const colors = [C.line, C.teal, C.red, C.amber, C.green];
  return `<defs>\n${colors.map((c) => `<marker id="arrow-${c.slice(1)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${c}"/></marker>`).join('\n')}\n</defs>`;
}

function svg(w, h, title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
  ${arrowDefs()}
  <rect width="${w}" height="${h}" fill="${C.paper}"/>
  ${textBlock(30, 46, [title], { size: 24, weight: 700 })}
  <line x1="30" y1="62" x2="${w - 30}" y2="62" stroke="${C.ink}" stroke-width="2"/>
  ${body}
</svg>
`;
}

/* ------------------------------------------------------------------ */
/* Figure 1 — the problem                                             */
/* ------------------------------------------------------------------ */

function fig1() {
  const W = 960; const H = 520;
  let b = '';
  b += textBlock(30, 95, ['Two situations look identical to a single test — but only one is actually fixed'], { size: 15, fill: C.muted });

  // Left column: real fix
  b += box(40, 130, 410, 160, { fill: C.greenSoft, stroke: C.green });
  b += textBlock(60, 165, ['Real fix', 'The patch removed the exploit path.'], { size: 16, weight: 700, fill: C.green });
  b += textBlock(60, 215, ['Single test says: PASS', 'Reality: the vulnerability is gone.'], { size: 14 });

  // Right column: environment mask
  b += box(510, 130, 410, 160, { fill: C.redSoft, stroke: C.red });
  b += textBlock(530, 165, ['Environment mask', 'The test environment withheld the resource.'], { size: 16, weight: 700, fill: C.red });
  b += textBlock(530, 215, ['Single test says: PASS', 'Reality: the vulnerability is fully alive.'], { size: 14 });

  b += arrow(480, 210, 480, 210, {});
  // Merge arrows into the "same signal" bar
  b += arrow(450, 210, 505, 210, { color: C.line });

  b += box(40, 330, 880, 70, { fill: C.slateSoft });
  b += textBlock(480, 360, ['Both produce the same conventional signal: "the unsafe event stopped recurring"'], { size: 16, weight: 600, anchor: 'middle' });
  b += textBlock(480, 385, ['…so a single test cannot tell them apart — and the masked case ships a broken product with false confidence.'], { size: 13, fill: C.muted, anchor: 'middle' });

  b += arrow(480, 400, 480, 440, { color: C.teal });
  b += box(240, 440, 480, 56, { fill: C.tealSoft, stroke: C.teal });
  b += textBlock(480, 474, ['AegisCode AI separates them with a causal experiment'], { size: 16, weight: 700, fill: C.teal, anchor: 'middle' });

  return svg(W, H, 'The problem: two identical-looking outcomes', b);
}

/* ------------------------------------------------------------------ */
/* Figure 2 — the four-condition causal matrix                         */
/* ------------------------------------------------------------------ */

function fig2() {
  const W = 1040; const H = 640;
  let b = '';
  b += textBlock(30, 95, ['Two factors crossed: code version × resource availability (the controlled variable)'], { size: 15, fill: C.muted });

  const x0 = 60; const y0 = 140;
  const colW = 420; const rowH = 130;
  const gap = 14;

  // Column headers
  b += textBlock(x0 + colW / 2, y0 - 14, ['a: baseline (resource withheld)'], { size: 15, weight: 700, anchor: 'middle' });
  b += textBlock(x0 + colW + gap + colW / 2, y0 - 14, ['b: substituted resource (guaranteed)'], { size: 15, weight: 700, anchor: 'middle', fill: C.teal });
  // Row headers
  b += textBlock(x0 - 14, y0 + rowH / 2 - 8, ['Original S'], { size: 15, weight: 700, anchor: 'end' });
  b += textBlock(x0 - 14, y0 + rowH + gap + rowH / 2 - 8, ['Patched P'], { size: 15, weight: 700, anchor: 'end' });

  const cells = [
    { key: 'A', x: x0, y: y0, fill: C.slateSoft, stroke: C.line, lines: ['A — flaw does NOT recur', 'the resource is withheld,', 'so the path was never tested'] },
    { key: 'B', x: x0 + colW + gap, y: y0, fill: C.redSoft, stroke: C.red, lines: ['B — flaw RECURS', 'the resource is guaranteed:', 'the premise is established'] },
    { key: 'C', x: x0, y: y0 + rowH + gap, fill: C.slateSoft, stroke: C.line, lines: ['C — does NOT recur', 'the ambiguous success a', 'single test would report'] },
    { key: 'D', x: x0 + colW + gap, y: y0 + rowH + gap, fill: C.greenSoft, stroke: C.green, lines: ['D — does NOT recur', 'with the resource guaranteed:', 'the fix actually holds'] },
  ];
  for (const c of cells) {
    b += box(c.x, c.y, colW, rowH, { fill: c.fill, stroke: c.stroke });
    b += textBlock(c.x + 20, c.y + 38, [c.lines[0]], { size: 16, weight: 700, fill: c.stroke });
    b += textBlock(c.x + 20, c.y + 68, c.lines.slice(1), { size: 13, fill: C.ink });
  }

  // Premise note under B
  const yPremise = y0 + rowH + gap + rowH + 40;
  b += arrow(x0 + colW + gap + colW / 2, y0 + rowH + gap + rowH, x0 + colW + gap + colW / 2, yPremise - 6, { color: C.red, dash: '6 5' });
  b += box(60, yPremise, 920, 46, { fill: C.redSoft, stroke: C.red, dash: '6 5' });
  b += textBlock(520, yPremise + 29, ['Premise gate: if B does not recur, no fix verdict is possible — the result is inconclusive.'], { size: 14, weight: 600, fill: C.red, anchor: 'middle' });

  // Verdicts
  const yV = yPremise + 46 + 44;
  b += arrow(520, yPremise + 46, 520, yV - 8, { color: C.teal });
  b += textBlock(60, yV + 20, ['Verdicts over C and D (all gates must pass first: completion, legitimate behavior, validity proof):'], { size: 14, weight: 600 });

  const verdicts = [
    { fill: C.greenSoft, stroke: C.green, title: 'patch_supported', sub: 'no recurrence in C and D' },
    { fill: C.redSoft, stroke: C.red, title: 'environment_masked', sub: 'recurs in D (or both)' },
    { fill: C.amberSoft, stroke: C.amber, title: 'interaction_dependent', sub: 'recurs in C, not D' },
    { fill: C.slateSoft, stroke: C.muted, title: 'inconclusive', sub: 'any gate failed' },
  ];
  const vw = 220; const vgap = 16;
  verdicts.forEach((v, i) => {
    const vx = 60 + i * (vw + vgap);
    const vy = yV + 40;
    b += box(vx, vy, vw, 74, { fill: v.fill, stroke: v.stroke });
    b += textBlock(vx + vw / 2, vy + 32, [v.title], { size: 15, weight: 700, fill: v.stroke, anchor: 'middle' });
    b += textBlock(vx + vw / 2, vy + 56, [v.sub], { size: 12, fill: C.ink, anchor: 'middle' });
  });

  return svg(W, H, 'The four-condition causal matrix', b);
}

/* ------------------------------------------------------------------ */
/* Figure 3 — the workflow loop                                        */
/* ------------------------------------------------------------------ */

function fig3() {
  const W = 1040; const H = 560;
  let b = '';
  b += textBlock(30, 95, ['Submit → isolated experiment → causal verdict → human decision → back to submit'], { size: 15, fill: C.muted });

  const steps = [
    { x: 60, lines: ['1. Submit', 'scenario + original', '+ patched code'], fill: C.slateSoft, stroke: C.line },
    { x: 270, lines: ['2. Isolated run', '4 conditions, 4', 'separate agents'], fill: C.tealSoft, stroke: C.teal },
    { x: 480, lines: ['3. Validity gates', 'completion · behavior', '· intervention proof'], fill: C.amberSoft, stroke: C.amber },
    { x: 690, lines: ['4. Causal verdict', 'one of four verdicts', '+ evidence'], fill: C.greenSoft, stroke: C.green },
    { x: 900 - 40, lines: ['5. Human decision', 'approve / reject,', 'recorded once'], fill: C.slateSoft, stroke: C.line },
  ];

  const y = 170; const w = 180; const h = 130;
  for (const s of steps) {
    b += box(s.x, y, w, h, { fill: s.fill, stroke: s.stroke });
    b += textBlock(s.x + 16, y + 34, [s.lines[0]], { size: 15, weight: 700, fill: s.stroke });
    b += textBlock(s.x + 16, y + 64, s.lines.slice(1), { size: 12.5 });
  }
  for (let i = 0; i < steps.length - 1; i += 1) {
    b += arrow(steps[i].x + w + 4, y + h / 2, steps[i + 1].x - 4, y + h / 2, { color: C.line });
  }

  // Loop back
  const loopY = y + h + 70;
  b += arrow(steps[4].x + w / 2, y + h + 4, steps[4].x + w / 2, loopY, { color: C.line });
  b += `<path d="M ${steps[4].x + w / 2} ${loopY} L ${steps[0].x + w / 2} ${loopY}" stroke="${C.line}" stroke-width="2" fill="none"/>`;
  b += arrow(steps[0].x + w / 2, loopY, steps[0].x + w / 2, y + h + 4, { color: C.line });

  b += textBlock(steps[2].x + w / 2, loopY + 30, ['approved → next patch iteration · rejected → back to the author'], { size: 13, fill: C.muted, anchor: 'middle' });

  // Hard rules
  const rY = loopY + 70;
  b += box(60, rY, 920, 120, { fill: C.paper, stroke: C.ink, dash: '7 6' });
  b += textBlock(80, rY + 32, ['Hard rules enforced by design:'], { size: 15, weight: 700 });
  b += textBlock(80, rY + 60, ['• timeout / crash / incomplete run = failure, never success'], { size: 13.5 });
  b += textBlock(80, rY + 84, ['• setup failures and test failures are logged separately — never counted in place of each other'], { size: 13.5 });
  b += textBlock(80, rY + 108, ['• no merge/apply/commit interface exists: adoption stays a documented human decision'], { size: 13.5 });

  return svg(W, H, 'The AegisCode workflow loop', b);
}

/* ------------------------------------------------------------------ */

const figures = [
  ['fig1-the-problem.svg', fig1],
  ['fig2-causal-matrix.svg', fig2],
  ['fig3-workflow-loop.svg', fig3],
];

await mkdir(OUT, { recursive: true });
for (const [name, gen] of figures) {
  const file = path.join(OUT, name);
  await writeFile(file, gen(), 'utf8');
  console.log(`wrote ${path.relative(ROOT, file)}`);
}
console.log('done — open the SVGs in any browser or view them on GitHub.');
