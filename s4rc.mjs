#!/usr/bin/env node
// s4rc.mjs — S4r GLSL compiler CLI
//
// Usage:
//   node s4rc.mjs [options] [file.s4r]   (reads stdin if no file given)
//
// Options:
//   --ast        Print parse tree as JSON instead of GLSL
//   --tasks      Print task list as JSON instead of full shader
//   --no-common  Skip auto-prepending common.s4r

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parse, compile, toGLSource, transform } from './S4r.js';

const __dir = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const files = args.filter(a => !a.startsWith('--'));

const commonPath = join(__dir, 'common.s4r');
const commonPrefix = (!flags.has('--no-common') && existsSync(commonPath))
  ? readFileSync(commonPath, 'utf8') + '\n'
  : '';

const source = commonPrefix + (
  files.length
    ? readFileSync(files[0], 'utf8')
    : readFileSync('/dev/stdin', 'utf8')
);

// The compiled tree is cyclic (loopVar -> loop -> body -> loopVar).
const safeReplacer = () => {
  const seen = new WeakSet();
  return (k, v) => {
    if (typeof v === 'function') return '[fn]';
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
    }
    return v;
  };
};

try {
  if (flags.has('--ast')) {
    const tree = parse(source);
    process.stdout.write(JSON.stringify(tree, safeReplacer(), 2) + '\n');
    process.exit(0);
  }

  const tasks = transform(source);

  if (flags.has('--tasks')) {
    process.stdout.write(JSON.stringify(tasks, safeReplacer(), 2) + '\n');
    process.exit(0);
  }

  // Default: emit GLSL for the first draw task
  for (const task of tasks) {
    if (task.type === 'draw') {
      const uniformTypes = { t: 'float', aspect: 'float' };
      for (const u of task.uniforms || [])
        uniformTypes[u.name] = u.valueType;
      let uniformDefs = '';
      for (const [name, type] of Object.entries(uniformTypes))
        uniformDefs += `uniform ${type} ${name};\n`;

      const body = `${task.preamble}\ngl_FragColor = ${task.expr};`;
      process.stdout.write([
        '#extension GL_OES_standard_derivatives : enable',
        'precision highp float;',
        'varying vec3 p;',
        'const float PI = asin(1.0) * 2.;',
        uniformDefs,
        '// --- preamble ---',
        body,
      ].join('\n') + '\n');
      process.exit(0);
    }
  }

  process.stderr.write('No draw task found in source.\n');
  process.exit(1);
} catch(e) {
  process.stderr.write((e.message || String(e)) + '\n');
  if (e.infoLog) process.stderr.write(e.infoLog + '\n');
  process.exit(1);
}
