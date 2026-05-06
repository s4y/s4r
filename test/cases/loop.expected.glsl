#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec3 p;
const float PI = asin(1.0) * 2.;
uniform float t;
uniform float aspect;

// --- preamble ---
float var_0 = 0.; for (int i = 0; i < 10; i++) var_0 = (var_0 + 1.);
; 

gl_FragColor = vec4(var_0);
