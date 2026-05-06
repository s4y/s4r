#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec3 p;
const float PI = asin(1.0) * 2.;
uniform float t;
uniform float aspect;

// --- preamble ---

gl_FragColor = vec4(vec2(p.x, p.y).x);
