// The WebGL2 effect pass: uploads a layer as a texture, runs the chroma key and colour adjustment in
// a fragment shader (the same maths as fx-math.ts, which is the reference) and hands back a canvas
// to draw with drawImage. The compositor itself stays Canvas 2D; this is a per-clip pass. Returns
// null when WebGL2 is unavailable, and the caller falls back to the CPU path.
import type { ChromaParams, ColourParams } from './fx-math';

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform bool u_chroma;
uniform vec2 u_keyCbCr;
uniform vec3 u_keyDir;
uniform float u_t0;
uniform float u_softWidth;
uniform float u_spill;
uniform bool u_colour;
uniform float u_offset;
uniform float u_contrast;
uniform float u_saturation;
uniform mat3 u_hue;
uniform vec3 u_tint;
uniform float u_tintAmount;
in vec2 v_uv;
out vec4 o;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
void main() {
  vec4 p = texture(u_tex, v_uv);
  float a = p.a;
  vec3 c = a > 0.0 ? clamp(p.rgb / a, 0.0, 1.0) : vec3(0.0);
  if (u_chroma) {
    vec2 cc = vec2(dot(c, vec3(-0.169, -0.331, 0.5)), dot(c, vec3(0.5, -0.419, -0.081)));
    float d = distance(cc, u_keyCbCr);
    float k = clamp((d - u_t0) / max(u_softWidth, 1e-4), 0.0, 1.0);
    k = k * k * (3.0 - 2.0 * k);
    a *= k;
    if (u_spill > 0.0) {
      float w = 1.0 - clamp((d - u_t0) / (u_softWidth + 0.5), 0.0, 1.0);
      float amount = max(0.0, dot(c - vec3(dot(c, LUMA)), u_keyDir));
      c = clamp(c - u_keyDir * (amount * u_spill * w), 0.0, 1.0);
    }
  }
  if (u_colour) {
    c = clamp(c + u_offset, 0.0, 1.0);
    c = clamp((c - 0.5) * u_contrast + 0.5, 0.0, 1.0);
    float l = dot(c, LUMA);
    c = clamp(vec3(l) + (c - vec3(l)) * u_saturation, 0.0, 1.0);
    c = clamp(u_hue * c, 0.0, 1.0);
    if (u_tintAmount > 0.0) {
      l = dot(c, LUMA);
      vec3 target = l < 0.5 ? u_tint * (l * 2.0) : mix(u_tint, vec3(1.0), (l - 0.5) * 2.0);
      c = mix(c, target, u_tintAmount);
    }
  }
  o = vec4(c * a, a);
}`;

interface GlState {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  texture: WebGLTexture;
  uniforms: Record<string, WebGLUniformLocation | null>;
  texW: number;
  texH: number;
  lost: boolean;
}

let state: GlState | null = null;
let failed = false;
let allowed = true;

const UNIFORMS = [
  'u_tex', 'u_chroma', 'u_keyCbCr', 'u_keyDir', 'u_t0', 'u_softWidth', 'u_spill',
  'u_colour', 'u_offset', 'u_contrast', 'u_saturation', 'u_hue', 'u_tint', 'u_tintAmount',
] as const;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader failed');
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader compile failed');
  return sh;
}

function init(): GlState | null {
  const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(2, 2) : document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
  if (!gl) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link failed');
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.useProgram(program);
  const loc = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.disable(gl.BLEND);
  const uniforms: GlState['uniforms'] = {};
  for (const name of UNIFORMS) uniforms[name] = gl.getUniformLocation(program, name);
  const s: GlState = { canvas, gl, program, texture, uniforms, texW: 0, texH: 0, lost: false };
  canvas.addEventListener?.('webglcontextlost', (e: Event) => {
    e.preventDefault();
    s.lost = true;
  });
  return s;
}

/** True when the WebGL2 pass can be used (and has not been switched off or failed). */
export function glAvailable(): boolean {
  if (!allowed || failed) return false;
  if (state && (state.lost || state.gl.isContextLost())) return false;
  if (!state) {
    try {
      state = init();
    } catch {
      state = null;
    }
    if (!state) failed = true;
  }
  return !!state;
}

/** Tests and the "use CPU" fallback: switch the WebGL2 pass off (false) or back on (true). */
export function setGlEnabled(on: boolean): void {
  allowed = on;
}

/** Which path effects run on right now. */
export function effectsBackend(): 'webgl2' | 'cpu' {
  return glAvailable() ? 'webgl2' : 'cpu';
}

export interface GlResult {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  /** Top row of the result inside `canvas`; it is `width` x `height` from (0, sy). */
  sy: number;
}

/**
 * Runs the colour and chroma pass over `source` (a canvas of `width` x `height`, straight or
 * premultiplied, whatever the 2D canvas holds). Returns null if WebGL2 is not usable.
 */
export function runGlPass(source: CanvasImageSource, width: number, height: number, colour: ColourParams | null, chroma: ChromaParams | null): GlResult | null {
  if (!glAvailable() || !state) return null;
  const s = state;
  const { gl, canvas, uniforms: u } = s;
  try {
    if (canvas.width < width || canvas.height < height) {
      canvas.width = Math.max(canvas.width, width);
      canvas.height = Math.max(canvas.height, height);
    }
    gl.viewport(0, 0, width, height);
    gl.bindTexture(gl.TEXTURE_2D, s.texture);
    if (s.texW === width && s.texH === height) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
    else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
      s.texW = width;
      s.texH = height;
    }
    gl.useProgram(s.program);
    gl.uniform1i(u.u_tex, 0);
    gl.uniform1i(u.u_chroma, chroma ? 1 : 0);
    if (chroma) {
      gl.uniform2f(u.u_keyCbCr, chroma.keyCbCr[0], chroma.keyCbCr[1]);
      gl.uniform3f(u.u_keyDir, chroma.keyDir[0], chroma.keyDir[1], chroma.keyDir[2]);
      gl.uniform1f(u.u_t0, chroma.t0);
      gl.uniform1f(u.u_softWidth, chroma.softWidth);
      gl.uniform1f(u.u_spill, chroma.spill);
    }
    gl.uniform1i(u.u_colour, colour ? 1 : 0);
    if (colour) {
      gl.uniform1f(u.u_offset, colour.offset);
      gl.uniform1f(u.u_contrast, colour.contrast);
      gl.uniform1f(u.u_saturation, colour.saturation);
      const h = colour.hue;
      // GLSL matrices are column-major; ours is row-major.
      gl.uniformMatrix3fv(u.u_hue, false, new Float32Array([h[0], h[3], h[6], h[1], h[4], h[7], h[2], h[5], h[8]]));
      gl.uniform3f(u.u_tint, colour.tint[0], colour.tint[1], colour.tint[2]);
      gl.uniform1f(u.u_tintAmount, colour.tintAmount);
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL error');
    // The viewport sits at the bottom-left of the GL canvas, which is the bottom of the picture.
    return { canvas, sy: canvas.height - height };
  } catch {
    failed = true;
    return null;
  }
}
