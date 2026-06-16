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
import { parse, compile, transform, toGLSource } from '../S4r.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const casesDir = join(__dir, 'cases');
const s4rc = join(__dir, '..', 's4rc.mjs');
const common = readFileSync(join(__dir, '..', 'common.s4r'), 'utf8') + '\n';

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

const g = { framebuffers: {}, midi: {}, pads: {}, audioAnalyser: null, t: 0, kickstart() {}, setTimeVelocity() {} };
const firstDraw = src => {
  const task = compile(null, parse(common + src), g).find(t => t.type === 'draw');
  return toGLSource(task.frag);
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const throws = (re, fn) => {
  try { fn(); } catch (e) { assert(re.test(e.message), `wrong error: ${e.message}`); return; }
  throw new Error('expected an error');
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
  ":loop 4 cdist + sin",
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

check('single-value loop unchanged', () => {
  const { preamble } = firstDraw("0\n:loop 5 1 +\nvec4.1 draw");
  assert(/float var_0 = 0\.; for \(int i = 0; i < 5; i\+\+\) var_0 = \(var_0 \+ 1\.\);/.test(preamble), preamble);
  assert(!/var_0_1/.test(preamble), `should not declare a 2nd accumulator: ${preamble}`);
});

check('two-value loop threads both accumulators', () => {
  const { preamble, expr } = firstDraw("1 1\n:loop 8 =b =a b a b +\n+ vec4.1 draw");
  assert(/float var_0 = 1\.; float var_0_1 = 1\.;/.test(preamble), preamble);
  assert(/var_0 = var_0_n; var_0_1 = var_0_1_n;/.test(preamble), preamble);
  assert(/\(var_0 \+ var_0_1\)/.test(expr), expr);
});

check('loop preserves context below accumulators', () => {
  const { expr } = firstDraw("7 1 1\n:loop 3 =b =a b a b +\n+ + vec4.1 draw");
  assert(/7\./.test(expr), `context value missing: ${expr}`);
});

check('unbalanced loop body is rejected (dup 1 +)', () => {
  throws(/as deep as it found it/, () => firstDraw("0\n:loop 5 dup 1 +\nvec4.1 draw"));
});

check('loop body that consumes without replacing is rejected', () => {
  throws(/as deep as it found it/, () => firstDraw("1\n:loop 3 =x\nvec4.1 draw"));
});

check('no-op loop body is rejected', () => {
  throws(/update at least one value/, () => firstDraw("1\n:loop 3\n\nvec4.1 draw"));
});

check('builtin with too few arguments is rejected', () => {
  throws(/needs 2 argument\(s\), but only 1 available/, () => firstDraw("1 pow\nvec4.1 draw"));
});

check('only used builtins are injected', () => {
  const [task] = compileDraws('p .xyz rgb2hsv hsv2rgb 1 vec4.2 draw');
  assert(/vec3 rgb2hsv\(/.test(task.builtins), `rgb2hsv should be injected: ${task.builtins}`);
  assert(/vec3 hsv2rgb\(/.test(task.builtins), `hsv2rgb should be injected: ${task.builtins}`);
  assert(!/sdBoundingBox/.test(task.builtins), `unused sdBoundingBox should be absent: ${task.builtins}`);
  assert(!/fsin/.test(task.builtins), `unused fsin should be absent: ${task.builtins}`);
});

check('no builtins injected when none used', () => {
  const [task] = compileDraws('t vec4.1 draw');
  assert(task.builtins === '', `expected empty builtins, got: ${JSON.stringify(task.builtins)}`);
});

check('custom builtins supplied via globals are injected', () => {
  const src = ':fn myHelper 1 vec3\np .xyz myHelper 1 vec4.2 draw';
  const source = 'vec3 myHelper(vec3 c) { return c * 2.0; }';
  const draws = transform(common + src, { builtins: { myHelper: { source } } })
    .filter(t => t.type === 'draw');
  assert(/vec3 myHelper\(/.test(draws[0].builtins), `custom builtin should be injected: ${draws[0].builtins}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
