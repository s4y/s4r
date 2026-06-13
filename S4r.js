// S4r.js
// Parses, compiles, and runs S4r stack-language programs as WebGL fragment shaders.
//
// Globals shape expected by S4r class:
//   { framebuffers, midi, pads, audioAnalyser, t,
//     kickstart(), setTimeVelocity(v) }

const glTypeFromBinaryOperationOnTypes = (l, r) => {
  const lBase = l.replace(/\d/, '');
  const rBase = r.replace(/\d/, '');
  switch (lBase) {
    case 'float':
      switch (rBase) {
        case 'float': return l;
        case 'vec':
        case 'mat': return r;
      }
      break;
    case 'vec': return l;
    case 'mat':
      switch (rBase) {
        case 'float': return l;
        case 'vec': return r;
        case 'mat':
          if (l == r) return l;
          break;
      }
      break;
  }
  throw new Error(`Unknown type pair for binary op: ${l}, ${r}`);
};

const wrapFragShader = (body, defs) => `
#extension GL_OES_standard_derivatives : enable
precision highp float;

varying vec3 p;

const float PI = asin(1.0) * 2.;

float easeInOutQuad(float t) {
  return t<.5 ? 2.*t*t : -1.+(4.-2.*t)*t;
}

// https://stackoverflow.com/questions/15095909/from-rgb-to-hsv-in-opengl-glsl
vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));

    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c)
{
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}


mat4 perspectiveProj(float fov, float aspect, float near, float far) {
  float f = 1.0 / tan(fov/2.0);
  return mat4(
    f / aspect, 0.0, 0.0, 0.0,
    0.0, f, 0.0, 0.0,
    0.0, 0.0, (far + near) / (far - near), 1.0,
    0.0, 0.0, (2.0 * far * near) / (near - far), 0.0
  );
}

// https://iquilezles.org/www/articles/distfunctions/distfunctions.htm
float sdBoundingBox( vec3 p, vec3 b, float e )
{
       p = abs(p  )-b;
  vec3 q = abs(p+e)-e;
  return min(min(
      length(max(vec3(p.x,q.y,q.z),0.0))+min(max(p.x,max(q.y,q.z)),0.0),
      length(max(vec3(q.x,p.y,q.z),0.0))+min(max(q.x,max(p.y,q.z)),0.0)),
      length(max(vec3(q.x,q.y,p.z),0.0))+min(max(q.x,max(q.y,p.z)),0.0));
}

// https://www.iquilezles.org/www/articles/bandlimiting/bandlimiting.htm
float fsin(float x) {
 float w = fwidth(x);
 return sin(x) * sin(0.5*w)/(0.5*w);
}


${defs || ""}

void main() {
${body}
}
`;

// getToken: returns a parsed token object for a raw text chunk.
// Note: operators (+, -, *, /) are returned as 'word' tokens so they
// can be overridden via defs in compile().
const getToken = text => {
  let tok = {};
  if (/'.+/.test(text)) {
    const idx = text.indexOf("'");
    tok.tag = text.substr(idx + 1);
    text = text.substr(0, idx);
  }
  if (/\s+/.test(text))
    return Object.assign({ type: 'whitespace', breaksLine: text.indexOf('\n') != -1, text }, tok);
  const numberValue = +text;
  if (/^bail\b/.test(text))
    return Object.assign({ type: 'bail' }, tok);
  if (/^\.\./.test(text))
    return Object.assign({ type: 'index', i: text.substr(2) }, tok);
  if (!isNaN(numberValue))
    return Object.assign({ type: 'number', value: numberValue }, tok);
  if (text[0] === ':')
    return Object.assign({ type: 'directive', value: text.substr(1) }, tok);
  if (/^\./.test(text))
    return Object.assign({ type: 'swizzle', components: text.substr(1) }, tok);
  if (/^=/.test(text))
    return Object.assign({ type: 'assign', name: text.substr(1) }, tok);
  return Object.assign({ type: 'word', value: text }, tok);
};

export const parse = s => {
  const ops = [];
  const line = [];
  let inComment = false;
  let inDirective = false;
  for (const [chunk] of (s + '\n').matchAll(/(\s+|#|\S+)/g)) {
    if (chunk === '#') {
      inComment = true;
      continue;
    }
    const tok = getToken(chunk);
    if (inComment) {
      if (tok.breaksLine)
        inComment = false;
      else
        continue;
    }
    if (tok.type === 'bail')
      break;
    if (tok.type === 'whitespace') {
      if (tok.breaksLine && (!inDirective || /\n$/.test(tok.text))) {
        if (line.length && line[0].type == 'directive') {
          if (line[0].value === 'def') {
            ops.push({
              type: 'define',
              name: line[1].value,
              ops: line.slice(2),
            });
          } else if (line[0].value === 'fn') {
            if (line.length < 3)
              throw new Error("`:fn` used with wrong number of arguments. Expected name, arity, and (optional) return type.");
            const name = line[1].value;
            const glName = name.match(/^[^.]+/)[0];
            const arity = line[2].value;
            const type = line[3] && line[3].value;
            ops.push({
              type: 'define',
              name,
              ops: [{ type: 'native', fn: stack => {
                const args = stack.splice(stack.length-arity, arity);
                stack.push({
                  type: 'invocation',
                  glName,
                  dataType: type || args[0].dataType,
                  const: args.reduce((acc, arg) => acc && arg.const, true),
                  args,
                });
              }}],
            });
          } else if (line[0].value === 'loop') {
            const count = line[1].value;
            ops.push({
              type: 'loop',
              count,
              ops: line.slice(2),
            });
          } else if (line[0].value === 'freeze') {
            const varType = line[1].value;
            const word = line[2].value;
            ops.push({
              type: 'freeze',
              varType,
              word,
            });
          } else {
            throw new Error('bad directive');
          }
        } else {
          ops.push(...line);
        }
        line.length = 0;
        inDirective = false;
      }
    } else {
      if (tok.type == 'directive')
        inDirective = true;
      line.push(tok);
    }
  }
  return ops;
};

class ShittyJSONStringifier {
  constructor() {
    this.cache = new Map();
  }

  stringifyImpl(obj) {
    if (Array.isArray(obj)) {
      return `[${obj.map(obj => this.stringify(obj)).join(',')}]`;
    } else if (typeof obj == 'object') {
      return `{${Object.keys(obj).map(k => `${JSON.stringify(k)}:${this.stringify(obj[k])}`).join(',')}`;
    } else {
      return JSON.stringify(obj);
    }
  }

  stringify(obj) {
    let c = this.cache.get(obj);
    if (!c)
      this.cache.set(obj, c = this.stringifyImpl(obj));
    return c;
  }
}

const optimizeTree = tree => {
  const buildMetadata = node => {
    const loopStack = [];
    const metadata = new Map();
    const traverse = (node, parent) => {
      let taint = false;
      if (node.type == 'literal')
        return;
      if (node.type == 'symbol')
        return;

      let meta = metadata.get(node);
      if (!meta) {
        metadata.set(node, meta = {
          parents: [],
          children: [],
        });
        if (node.type == 'loop') {
          loopStack.push(node);
        } else if (node.type == 'loopVar') {
          meta.loop = loopStack[loopStack.length-1];
          taint = true;
        }
        for (const k in node) {
          const v = node[k];
          if (Array.isArray(v)) {
            for (const child of v) {
              meta.children.push(child);
              taint = traverse(child, node) || taint;
            }
          } else if (typeof v == 'object') {
            meta.children.push(v);
            taint = traverse(v, node) || taint;
          }
        }
        if (node.type == 'loop')
          loopStack.pop();
      }
      if (parent)
        meta.parents.push(parent);
      if (taint && node.type != 'loop')
        meta.taint = true;
      return meta.taint;
    };
    traverse(node);
    return metadata;
  };
  const metadata = buildMetadata(tree);

  const optimize = tree => {
    let extracted = [];
    let visitedNodes = new Set();
    let nextToVisit = [tree];
    const visit = node => {
      if (visitedNodes.has(node))
        return;
      visitedNodes.add(node);
      const meta = metadata.get(node);
      if (!meta)
        return;
      nextToVisit.splice(0, 0, ...meta.children);
      if (meta.taint) {
      } else if (node.type == 'loop' || meta.parents.length >= 2) {
        meta.id = extracted.push(node) - 1;
      }
    };

    while (nextToVisit.length) {
      let toVisit = nextToVisit;
      nextToVisit = [];
      for (const node of toVisit)
        visit(node);
    }

    return extracted;
  };
  const extracted = optimize(tree);

  const rebuild = tree => {
    const traverse = (node, skip) => {
      const meta = metadata.get(node);
      if (!meta)
        return node;
      if (!skip && meta.id !== undefined) {
        return {
          type: "reference",
          id: meta.id,
          const: node.const,
          selfref: meta.loop !== undefined,
        };
      }
      const ret = {};
      for (const k in node) {
        const v = node[k];
        if (Array.isArray(v)) {
          ret[k] = v.map(v => traverse(v));
        } else if (typeof v == 'object') {
          ret[k] = traverse(v);
        } else {
          ret[k] = v;
        }
      }
      return ret;
    };
    return traverse(tree, true);
  };

  return { extracted: extracted.map(rebuild), tree: rebuild(tree) };
};

export const toGLSource = tree => {
  let decls = "";
  let loop_stack = [];
  let cur_loop = null;
  let references = [];
  let depsMet = {};
  let depFail = false;
  const serialize = node => {
    switch(node.type) {
      case "invocation":
        return `${node.glName}(${node.args.map(serialize).join(', ')})`;
      case "operator":
        return `(${serialize(node.left)} ${node.value} ${serialize(node.right)})`;
      case "index":
        return `${serialize(node.value)}[${node.i}]`;
      case "swizzle":
        return `${serialize(node.value)}.${node.components}`;
      case "literal": {
        let ns = node.value.toString();
        if (ns.indexOf('.') === -1)
          ns += '.';
        return ns;
      }
      case "symbol":
        return node.value;
      case "reference":
        if (!depsMet[node.id])
          depFail = true;
        return references[node.id];
      case "loopVar":
        if (cur_loop === null)
          throw new Error('tried to loopVar outside a loop');
        return references[loop_stack[loop_stack.length-1]];
      case "loop": {
        const loop_var = references[loop_stack[loop_stack.length-1]];
        cur_loop = loop_stack[loop_stack.length-1];
        try {
          return `${serialize(node.initialValue)}; for (int i = 0; i < ${node.count}; i++) ${loop_var} = ${serialize(node.body)};\n`;
        } finally {
          cur_loop = null;
        }
      }
      default:
        throw new Error(`Unknown AST node type: ${node.type}`);
    }
  };
  const optimized = optimizeTree(tree);
  for (let i = 0; i < optimized.extracted.length; i++) {
    references.push(`var_${i}`);
  }
  for (;;) {
    let didEmit = false;
    for (let i = optimized.extracted.length - 1; i >= 0; i--) {
      if (depsMet[i])
        continue;
      const expr = optimized.extracted[i];
      loop_stack.push(i);
      depFail = false;
      const nPre = `${expr.const ? "const " : ""}${expr.dataType} ${references[i]} = ${serialize(expr)}; \n`;
      loop_stack.pop();
      if (depFail)
        continue;
      decls += nPre;
      depsMet[i] = true;
      didEmit = true;
    }
    if (!didEmit)
      break;
  }
  for (let i = 0; i < optimized.extracted.length; i++) {
    if (!depsMet[i])
      throw new Error("Failed to meet all deps.");
  }
  const expr = serialize(optimized.tree);
  return { preamble: decls, expr };
};

// Walks an expression tree, collecting the unique uniform descriptors carried
// by its symbol nodes. A uniform travels with the value that references it, so
// each draw declares and binds exactly the uniforms it actually uses — even
// when a value (e.g. a captured `fb'…` sample) is reused in a later draw.
const collectUniforms = tree => {
  const out = new Map();
  const visit = node => {
    if (!node || typeof node != 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node.uniform)
      out.set(node.uniform.name, node.uniform);
    for (const k in node) {
      if (k != 'uniform')
        visit(node[k]);
    }
  };
  visit(tree);
  return [...out.values()];
};

// gl may be null for headless/CLI use — directives that allocate GPU resources are no-ops.
const createFB = (gl, w, h) => {
  if (!gl) return { tex: null, fb: null, w: w||0, h: h||0, draw() {}, attach() {}, drawInto(f) { f(); } };
  if (!w) w = gl.drawingBufferWidth;
  if (!h) h = gl.drawingBufferHeight;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return {
    tex, fb, w, h,
    draw() {},
    attach(id) {
      gl.activeTexture(gl['TEXTURE' + id]);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    },
    drawInto(f) {
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        f();
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
    },
  };
};

const createFBPair = (gl, w, h) => {
  if (!gl) return { w: w||0, h: h||0, get tex() { return null; }, draw() {}, drawInto(f) { f(); } };
  const fbs = [createFB(gl, w, h), createFB(gl, w, h)];
  return {
    w: fbs[0].w,
    h: fbs[0].h,
    get tex() { return fbs[0].tex; },
    draw() { return fbs[0].draw(); },
    drawInto(f) {
      fbs.reverse();
      fbs[0].drawInto(f);
    },
  };
};

// Compiles a parse tree into a flat list of tasks.
// gl may be null for headless use; GPU-allocating directives become no-ops.
export const compile = (gl, parseTree, globals) => {
  const binaryOp = sym => ({
    [sym]: [{ type: 'native', fn: stack => {
      const right = stack.pop();
      const left = stack.pop();
      if (!left || !right)
        throw new Error(`Null argument to operator: ${left} ${sym} ${right}`);
      if (!left.dataType || !right.dataType)
        throw new Error(`Unexpected stack items for '${sym}': ${JSON.stringify(left)}, ${JSON.stringify(right)}`);
      stack.push({
        type: 'operator',
        value: sym,
        left, right,
        dataType: glTypeFromBinaryOperationOnTypes(left.dataType, right.dataType),
        const: left.const && right.const,
      });
    }}],
  });

  const symbol = (value, dataType, isConst = false) => ({
    [value]: [{ type: 'native', fn: stack => { stack.push({
      type: 'symbol',
      dataType,
      const: isConst,
      value,
    }); }}],
  });

  // A symbol node backed by a runtime uniform. The descriptor rides along on
  // the node so the uniform is declared/bound for whichever draw uses it.
  const uniformSymbol = (name, dataType, valueType, getValue) => ({
    type: 'symbol',
    dataType,
    const: false,
    value: name,
    uniform: { name, valueType, get value() { return getValue(); } },
  });

  // A sampler2D uniform fed from an audio byte buffer. Uploading the latest
  // samples happens when the uniform is bound, so the sampler the shader reads
  // and the texture that gets refreshed are one and the same.
  const audioTexture = (name, key, getData) => {
    if (gl && !globals.framebuffers[key])
      globals.framebuffers[key] = createFB(gl, getData().length, 1);
    return uniformSymbol(name, 'sampler2D', 'sampler2D', () => globals.framebuffers[key] ? {
      get tex() { return globals.framebuffers[key].tex; },
      draw() {
        if (!gl) return;
        const data = getData();
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, data.length, 1, 0,
          gl.LUMINANCE, gl.UNSIGNED_BYTE, data);
      },
    } : null);
  };

  let uniform_seq = 0;
  let tasks = [];
  let stack = [];
  let defs = {
    ...binaryOp('+'),
    ...binaryOp('-'),
    ...binaryOp('*'),
    ...binaryOp('/'),
    ...symbol('t', 'float'),
    ...symbol('p', 'vec3'),
    ...symbol('PI', 'float', true),
    aspect: [{ type: 'native', fn: (stack, tag) => {
      if (!tag) {
        stack.push({ type: 'symbol', dataType: 'float', const: false, value: 'aspect' });
        return;
      }
      const u_name = `u_aspect_${tag}`;
      stack.push(uniformSymbol(u_name, 'float', 'float', () => {
        const fb = globals.framebuffers[tag];
        if (!fb || !fb.h) return 1;
        return fb.w / fb.h;
      }));
    }}],
    midi: [{ type: 'native', fn: (stack, tag) => {
      const u_name = `u_${uniform_seq++}`;
      stack.push(uniformSymbol(u_name, 'float', 'float',
        () => (globals.midi && globals.midi[tag]) || 0));
    }}],
    fb: [{ type: 'native', fn: (stack, tag) => {
      if (gl && !globals.framebuffers[tag])
        globals.framebuffers[tag] = createFBPair(gl);
      const u_name = `fb_${tag}`;
      stack.push(uniformSymbol(u_name, 'sampler2D', 'sampler2D',
        () => globals.framebuffers[tag]));
    }}],
    dims: [{ type: 'native', fn: stack => {
      stack.push(uniformSymbol('u_dims', 'vec2', 'vec2',
        () => gl ? [gl.drawingBufferWidth, gl.drawingBufferHeight] : [0, 0]));
    }}],
    draw: [{ type: 'native', fn: stack => {
      const frag = stack.pop();
      tasks.push({ type: 'draw', frag, uniforms: collectUniforms(frag) });
    }}],
    drawto: [{ type: 'native', fn: (stack, tag) => {
      const target = globals.framebuffers[tag] || (globals.framebuffers[tag] = createFBPair(gl));
      const frag = stack.pop();
      tasks.push({ type: 'draw', target, frag, uniforms: collectUniforms(frag) });
    }}],
    tvel: [{ type: 'native', fn: stack => {
      const v = +stack.pop().value;
      if (isNaN(v)) return;
      globals.setTimeVelocity && globals.setTimeVelocity(v);
      globals.kickstart && globals.kickstart();
    }}],
    st: [{ type: 'native', fn: stack => {
      if (!globals.audioAnalyser && globals.createAudioAnalyser)
        globals.audioAnalyser = globals.createAudioAnalyser();
      const {audioAnalyser} = globals;
      if (!audioAnalyser) return;
      if (typeof stack[stack.length-1].value != 'number') {
        stack.push(uniformSymbol('u_audio_zero_crossing_time', 'float', 'float', () => {
          const {byteTimeData} = audioAnalyser;
          for (let i = 1; i < byteTimeData.length; i++) {
            if (byteTimeData[i-1] < 127 && byteTimeData[i] >= 127)
              return i / byteTimeData.length;
          }
          return 0;
        }));
        doOps(parse(`+ 2 / 0 vec2`));
        stack.push(audioTexture('u_audio_time', 'st', () => audioAnalyser.byteTimeData));
        doOps(parse(`swap texture2D .x`));
      } else {
        const bucket = stack.pop();
        const bucketNumber = Math.floor(+bucket.value * audioAnalyser.byteTimeData.length);
        const u_name = `u_${uniform_seq++}`;
        stack.push(uniformSymbol(u_name, 'float', 'float',
          () => audioAnalyser.byteTimeData[bucketNumber]/255));
      }
    }}],
    sf: [{ type: 'native', fn: stack => {
      if (!globals.audioAnalyser && globals.createAudioAnalyser)
        globals.audioAnalyser = globals.createAudioAnalyser();
      const {audioAnalyser} = globals;
      if (!audioAnalyser) return;
      doOps(parse(`2 pow 0 vec2`));
      stack.push(audioTexture('u_freq', 'sf', () => audioAnalyser.byteFreqData));
      doOps(parse(`swap texture2D .x`));
    }}],
    fsf: [{ type: 'native', fn: stack => {
      if (!globals.audioAnalyser && globals.createAudioAnalyser)
        globals.audioAnalyser = globals.createAudioAnalyser();
      const {audioAnalyser} = globals;
      if (!audioAnalyser) return;
      doOps(parse(`2 pow 0 vec2`));
      stack.push(audioTexture('u_fast_freq', 'fsf', () => audioAnalyser.byteFreqDataFast));
      doOps(parse(`swap texture2D .x`));
    }}],
    ssf: [{ type: 'native', fn: stack => {
      if (!globals.audioAnalyser && globals.createAudioAnalyser)
        globals.audioAnalyser = globals.createAudioAnalyser();
      const {audioAnalyser} = globals;
      if (!audioAnalyser) return;
      doOps(parse(`2 pow 0 vec2`));
      stack.push(audioTexture('u_slow_freq', 'ssf', () => audioAnalyser.byteFreqDataSlow));
      doOps(parse(`swap texture2D .x`));
    }}],
    pause: [{ type: 'native', fn: stack => {
      globals.setTimeVelocity && globals.setTimeVelocity(0);
    }}],
    pad_x: [{ type: 'native', fn: stack => {
      const which = +stack.pop().value;
      const u_name = `u_${uniform_seq++}`;
      if (!isNaN(which))
        stack.push(uniformSymbol(u_name, 'float', 'float',
          () => (globals.pads && globals.pads[which] && globals.pads[which].x) || 0));
      else
        stack.push({ type: 'symbol', dataType: 'float', const: false, value: u_name });
    }}],
    pad_y: [{ type: 'native', fn: stack => {
      const which = +stack.pop().value;
      const u_name = `u_${uniform_seq++}`;
      if (!isNaN(which))
        stack.push(uniformSymbol(u_name, 'float', 'float',
          () => (globals.pads && globals.pads[which] && globals.pads[which].y) || 0));
      else
        stack.push({ type: 'symbol', dataType: 'float', const: false, value: u_name });
    }}],
    pad: [{ type: 'native', fn: stack => {
      const which = +stack.pop().value;
      const u_name = `u_${uniform_seq++}`;
      if (!isNaN(which)) {
        let interpVal = (globals.pads && globals.pads[which] && globals.pads[which].pressed) ? 1 : 0;
        stack.push(uniformSymbol(u_name, 'float', 'float', () => {
          const target = (globals.pads && globals.pads[which] && globals.pads[which].pressed) ? 1 : 0;
          interpVal += (target - interpVal) * 0.1;
          return interpVal;
        }));
      } else {
        stack.push({ type: 'symbol', dataType: 'float', const: false, value: u_name });
      }
    }}],
    '{': [{ type: 'native', fn: stack => { defs = Object.create(defs); }}],
    '}': [{ type: 'native', fn: stack => { defs = Object.getPrototypeOf(defs); }}],
    '[': [{ type: 'native', fn: stack => { stack.push({ type: 'vecSentinel' }); }}],
    ']': [{ type: 'native', fn: stack => {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].type != 'vecSentinel') continue;
        const vec = stack.splice(i + 1, stack.length - i - 1);
        stack.pop();
        stack.push({
          type: 'invocation',
          glName: `vec${vec.length}`,
          dataType: `vec${vec.length}`,
          const: vec.reduce((c, x) => c && x.const, true),
          args: vec,
        });
        return;
      }
      throw new Error("Unmatched ']'");
    }}],
  };

  const doOps = (ops, tag) => {
    for (const op of ops) {
      if (op.type === 'define') {
        defs[op.name] = op.ops;
      } else if (op.type === 'loop') {
        const { count, ops: loopOps } = op;
        const initialValue = stack.pop();
        stack.push({ type: "loopVar", dataType: initialValue.dataType, const: false });
        doOps(loopOps);
        const body = stack.pop();
        stack.push({ type: "loop", dataType: initialValue.dataType, initialValue, count, body });
      } else if (op.type === 'freeze') {
        // no-op
      } else if (op.type === 'number') {
        stack.push({ type: 'literal', dataType: 'float', const: true, value: op.value });
      } else if (op.type === 'word') {
        const def = defs[op.value];
        if (def) {
          doOps(def, op.tag);
        } else {
          throw new Error(`"${op.value}" is not defined.`);
        }
      } else if (op.type === 'native') {
        op.fn(stack, tag);
      } else if (op.type === 'index') {
        const value = stack.pop();
        stack.push({
          type: 'index',
          dataType: value.dataType.split('[')[0],
          const: value.const,
          i: op.i,
          value,
        });
      } else if (op.type === 'swizzle') {
        const components = op.components;
        const value = stack.pop();
        const dataType = components.length > 1 ? `vec${components.length}` : 'float';
        stack.push({ type: 'swizzle', dataType, const: value.const, components, value });
      } else if (op.type === 'assign') {
        const v = stack.pop();
        defs[op.name] = [{ type: 'native', fn: stack => { stack.push(v); }}];
      } else {
        throw new Error('idk what this thing is: ' + JSON.stringify(op));
      }
    }
  };

  doOps(parseTree);
  return tasks;
};

// Compiles a S4r source string and returns GLSL draw tasks.
// gl may be null for headless use.
export function transform(source, globals = {}) {
  const g = {
    framebuffers: {},
    midi: {},
    pads: {},
    audioAnalyser: null,
    t: 0,
    kickstart() {},
    setTimeVelocity() {},
    ...globals,
  };
  const tasks = compile(null, parse(source), g);
  return tasks.map(task => {
    if (task.type !== 'draw') return task;
    const { preamble, expr } = toGLSource(task.frag);
    return { ...task, preamble, expr };
  });
}

const defaultMeshData = new Float32Array([-1,1,0,-1,-1,0,1,1,0,1,-1,0]);

const compileFragShader = (gl, s) => {
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, s);
  gl.compileShader(fs);
  if (gl.getShaderParameter(fs, gl.COMPILE_STATUS))
    return fs;
  const err = new Error('Fragment shader compile error');
  err.infoLog = gl.getShaderInfoLog(fs);
  err.shaderSource = s;
  throw err;
};

const buildRuntimeTasks = (gl, vs, buffer, tasks, globals) => {
  const newRuntimeTasks = [];

  // The always-present built-ins, plus the uniforms this particular draw's
  // expression references (collected at compile time).
  const drawUniforms = task => {
    const uniforms = {
      t: {
        valueType: 'float',
        get value() { return globals.t || 0; }
      },
      aspect: {
        valueType: 'float',
        get value() { return gl.drawingBufferWidth / gl.drawingBufferHeight; }
      },
    };
    for (const u of task.uniforms || [])
      uniforms[u.name] = u;
    return uniforms;
  };

  for (const task of tasks) {
    if (task.type == 'draw') {
      const uniforms = drawUniforms(task);

      let uniformDefs = "";
      for (const k in uniforms) {
        uniformDefs += `uniform ${uniforms[k].valueType} ${k};\n`;
      }

      const { preamble, expr: exprText } = toGLSource(task.frag);
      const progText = `${preamble}\ngl_FragColor = ${exprText};`;
      const shaderText = wrapFragShader(progText, uniformDefs);

      let fs;
      try {
        fs = compileFragShader(gl, shaderText);
      } catch(e) {
        console.error(e.infoLog);
        console.error(e.shaderSource);
        throw e;
      }

      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const err = new Error('Shader link error');
        err.infoLog = gl.getProgramInfoLog(prog);
        throw err;
      }

      newRuntimeTasks.push(() => {
        gl.useProgram(prog);

        let textures = [];
        for (const k in uniforms) {
          const u = uniforms[k];
          const loc = gl.getUniformLocation(prog, k);
          const v = u.value;
          if (u.valueType === 'sampler2D') {
            const fb = v;
            if (!fb) continue;
            let id = textures.indexOf(fb.tex);
            if (id < 0) id = textures.length;
            textures.push(fb.tex);
            gl.activeTexture(gl['TEXTURE' + id]);
            gl.bindTexture(gl.TEXTURE_2D, fb.tex);
            fb.draw && fb.draw();
            gl.uniform1i(loc, id);
          } else if (!loc) {
            continue;
          } else if (u.valueType === 'vec2') {
            gl.uniform2f(loc, ...v);
          } else if (u.valueType === 'mat4') {
            gl.uniformMatrix4fv(loc, false, v);
          } else if (u.valueType.indexOf('[') != -1) {
            gl.uniform1fv(loc, v);
          } else {
            gl.uniform1f(loc, v);
          }
        }

        const pLoc = gl.getAttribLocation(prog, "p_in");
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(pLoc);
        gl.vertexAttribPointer(pLoc, 3, gl.FLOAT, false, 0, 0);

        const doDraw = () => {
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, defaultMeshData.length / 3);
        };
        if (task.target)
          task.target.drawInto(doDraw);
        else
          doDraw();
      });
    }
  }
  return newRuntimeTasks;
};

export default class S4r {
  constructor(gl, globals) {
    this._gl = gl;
    this._globals = globals;
    this._runtimeTasks = [];
    this._error = null;

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, defaultMeshData, gl.STATIC_DRAW);
    this._buffer = buffer;

    const vs = this._vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, `
attribute vec3 p_in;
varying vec3 p;

void main() {
  p = p_in;
  gl_Position = vec4(p_in, 1.);
}
`);
    gl.compileShader(vs);
  }

  update(source) {
    try {
      const tasks = compile(this._gl, parse(source), this._globals);
      this._runtimeTasks = buildRuntimeTasks(this._gl, this._vs, this._buffer, tasks, this._globals);
      this._error = null;
    } catch(e) {
      this._error = e;
    }
  }

  draw() {
    for (const task of this._runtimeTasks)
      task();
  }

  get error() { return this._error; }
}
