#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec3 p;
const float PI = asin(1.0) * 2.;
uniform float t;
uniform float aspect;

// --- preamble ---
float var_0 = 1.; float var_0_1 = 1.; for (int i = 0; i < 8; i++) { float var_0_n = var_0_1; float var_0_1_n = (var_0 + var_0_1); var_0 = var_0_n; var_0_1 = var_0_1_n; }

gl_FragColor = vec4(var_0_1);
