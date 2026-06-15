#!/usr/bin/env node
// test/run.mjs — S4r language unit test runner
//
// For each test/cases/<name>.s4r, runs s4rc.mjs and diffs output against
// test/cases/<name>.expected.glsl. Then runs the programmatic checks below,
// which cover behaviour the single-draw .expected.glsl files can't (e.g. how
// uniforms attach to draws past the first). Exits nonzero if any test fails.

import { readdirSync, readFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import { transform } from '../S4r.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const casesDir = join(__dir, 'cases');
const s4rc = join(__dir, '..', 's4rc.mjs');

const files = readdirSync(casesDir).filter(f => f.endsWith('.s4r')).sort();

let passed = 0;
let failed = 0;

const declared = task => new Set(['t', 'aspect', ...(task.uniforms || []).map(u => u.name)]);
const used = task => new Set(
  [...`${task.preamble} ${task.expr}`.matchAll(/\b(?:fb_|u_)[A-Za-z0-9_]+\b/g)].map(m => m[0]));

const check = (name, fn) => {
  try {
    fn();
    console.log(`ok    ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL  ${name}`);
    console.error('  ', e.message);
    failed++;
  }
};

const common = readFileSync(join(__dir, '..', 'common.s4r'), 'utf8') + '\n';
const compileDraws = src => transform(common + src).filter(t => t.type === 'draw');

const assertUniformsResolve = (label, src) => {
  const draws = compileDraws(src);
  draws.forEach((task, i) => {
    const have = declared(task);
    const missing = [...used(task)].filter(u => !have.has(u));
    if (missing.length)
      throw new Error(`${label}: draw #${i} references undeclared uniform(s): ${missing.join(', ')}`);
  });
};

for (const file of files) {
  const inputPath = join(casesDir, file);
  const expectedPath = join(casesDir, file.replace(/\.s4r$/, '.expected.glsl'));
  const name = basename(file, '.s4r');

  if (!existsSync(expectedPath)) {
    console.log(`SKIP  ${name}  (no .expected.glsl)`);
    continue;
  }

  const result = spawnSync(process.execPath, [s4rc, inputPath], { encoding: 'utf8' });
  const expected = readFileSync(expectedPath, 'utf8');
  const actual = result.stdout;

  if (result.status !== 0 || actual !== expected) {
    console.log(`FAIL  ${name}`);
    if (result.stderr) console.error('  stderr:', result.stderr.trim());
    if (actual !== expected) {
      const aLines = actual.split('\n');
      const eLines = expected.split('\n');
      const maxLen = Math.max(aLines.length, eLines.length);
      for (let i = 0; i < maxLen; i++) {
        if (aLines[i] !== eLines[i]) {
          console.log(`  line ${i+1} expected: ${JSON.stringify(eLines[i])}`);
          console.log(`  line ${i+1} actual:   ${JSON.stringify(aLines[i])}`);
        }
      }
    }
    failed++;
  } else {
    console.log(`ok    ${name}`);
    passed++;
  }
}

const fbAcrossDraw = [
  "fb'f uv tex =prev",
  "p .x drawto'f",
  "prev draw",
].join('\n');

const loopFeedbackAcrossDraw = [
  "fb'f uv tex .x =seed",
  "seed",
  ":loop 4 dup cdist + sin",
  "=acc",
  "acc drawto'f",
  "acc draw",
].join('\n');

check('uniform survives draw boundary', () => {
  assertUniformsResolve('fb-across-draw', fbAcrossDraw);
});

check('loopVar+uniform survive draw boundary', () => {
  assertUniformsResolve('loop-feedback-across-draw', loopFeedbackAcrossDraw);
});

check('draw declares only the uniforms it uses', () => {
  const draws = compileDraws(fbAcrossDraw);
  const names = i => (draws[i].uniforms || []).map(u => u.name);
  if (names(0).includes('fb_f'))
    throw new Error(`first draw should not declare fb_f; got ${names(0).join(', ') || '(none)'}`);
  if (!names(1).includes('fb_f'))
    throw new Error(`second draw should declare fb_f; got ${names(1).join(', ') || '(none)'}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
