#!/usr/bin/env node
// test/run.mjs — S4r language unit test runner
//
// For each test/cases/<name>.s4r, runs s4rc.mjs and diffs output against
// test/cases/<name>.expected.glsl. Exits nonzero if any test fails.

import { readdirSync, readFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const casesDir = join(__dir, 'cases');
const s4rc = join(__dir, '..', 's4rc.mjs');

const files = readdirSync(casesDir).filter(f => f.endsWith('.s4r')).sort();

let passed = 0;
let failed = 0;

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
