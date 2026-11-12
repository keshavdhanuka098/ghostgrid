import { useEffect, useRef } from 'react';

/**
 * The hero backdrop: the real Earth at night, seen from orbit, turning continuously.
 *
 * Surface = NASA night-lights map (`public/earth-night.jpg`, equirectangular) wrapped on a sphere by one fragment
 * shader (WebGL2, no meshes, no libraries). City lights are boosted with a soft bloom (a blurred mip of the same
 * texture) and a blue atmosphere hugs the limb.
 *
 * Performance design (this sits behind a scroll-driven page, so it must stay cheap):
 *  - Stars are NOT in the shader. They are two static 2D canvases (one fades slowly via a CSS opacity animation).
 *  - The shader canvas only covers the bottom GLOBE_FRAC of the screen, where the planet and its glow live.
 *  - One render per display frame (60fps). When the GPU is busy only the RESOLUTION gives way (adaptive scale with a
 *    pixel budget and a ceiling), never the frame rate. Per-frame maths (radius, sin/cos of the roll) is done on the CPU,
 *    empty sky is skipped early, and heavy textures upload one per task so the main thread never freezes.
 *  - Scrolling "sinks" the planet by translating that canvas on the compositor. The shader's output is premultiplied
 *    alpha, so space shows the stars through.
 *  - Rendering pauses entirely once the story is scrolled past, or when the tab is hidden.
 * `progress` (0..1, a ref) drives the sink and a little extra spin. If WebGL2 is unavailable, `onFail` is called.
 */
type Props = { progress: { current: number }; reduced: boolean; onFail: () => void };

const GLOBE_FRAC = 0.72; // fraction of the viewport height the shader canvas covers (must match .cosmos.globe in CSS)
const SINK = 0.1;  // how far the planet sinks over the whole story, as a fraction of viewport height

const VERT = `#version 300 es
in vec2 a; void main(){ gl_Position = vec4(a, 0., 1.); }`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform float uScreenH, uTime, uP, uFade; uniform sampler2D uTex, uDay, uCloud, uSpec;
uniform vec3 uHas;
uniform float uR;   // planet radius (screen-height units), computed once per frame on the CPU
uniform vec2 uCS;   // cos / sin of the roll angle, computed once per frame on the CPU instead of per pixel // x: day map loaded, y: cloud map loaded, z: specular map loaded
out vec4 o;

vec3 rotY(vec3 v,float a){ float c=cos(a), s=sin(a); return vec3(v.x*c-v.z*s, v.y, v.x*s+v.z*c); }

// equirectangular lookup that stays seamless across the date line (no mip-level spike where atan wraps)
vec2 equirect(vec3 w){
  float u0 = atan(w.x, w.z)/6.2831853 + .5;
  float u1 = fract(u0), u2 = fract(u0+.5)-.5;
  float u = fwidth(u1) <= fwidth(u2)+1e-4 ? u1 : u2;
  return vec2(u, asin(clamp(w.y,-1.,1.))/3.14159265 + .5);
}

// cheap 3D value noise + fbm: used for a faint cloud layer so the planet reads as a real, living surface
float h3(vec3 p){ p = fract(p*.3183099 + .1); p *= 17.; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vn(vec3 x){
  vec3 i = floor(x), f = fract(x); f = f*f*(3.-2.*f);
  return mix(mix(mix(h3(i), h3(i+vec3(1,0,0)), f.x), mix(h3(i+vec3(0,1,0)), h3(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i+vec3(0,0,1)), h3(i+vec3(1,0,1)), f.x), mix(h3(i+vec3(0,1,1)), h3(i+vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p){ float a = .5, s = 0.; for (int i = 0; i < 5; i++) { s += a*vn(p); p = p*2.03 + 7.1; a *= .5; } return s; }

void main(){
  // uv is in "full screen" units (height = 1, origin at screen centre); the canvas is bottom-aligned on the screen
  vec2 uv = vec2(gl_FragCoord.x - .5*uRes.x, gl_FragCoord.y - .5*uScreenH) / uScreenH;

  // Radius follows the screen aspect so the horizon runs edge to edge: the circle meets the left/right screen
  // edges only sag below the top of the limb (a wide, shallow curve, like the view from the ISS).
  float R = uR;
  float limb = -.06;
  vec2 p = uv - vec2(0., limb - R);
  float d = length(p);

  // atmosphere against space (clamped: exp() of a large positive number inside the disc is +inf, and inf*0 = NaN):
  // a razor-thin bright rim, a blue shoulder, a wide soft haze and a faint green airglow band like real orbital photos
  float ho = max(d-R, 0.);
  if (ho > .32) { o = vec4(0.); return; }   // empty sky: skip all the glow maths (most of the canvas on wide screens)
  float rim = exp(-ho*520.)*1.25;
  float halo = exp(-ho*26.)*.5 + exp(-ho*120.)*.9 + rim;
  vec3 hc = vec3(.14,.40,1.) * halo;
  hc += vec3(.55,.85,1.) * rim * .8;                                  // white-blue core of the rim
  float ag = (ho-.018)*70.;
  hc += vec3(.10,.55,.38) * exp(-ag*ag) * .22;                       // airglow band
  if (uHas.x > .5) {
    // sunlit limb is bright and blue-white, the night limb is dim, and the line between them glows orange (sunrise)
    vec3 sun = normalize(vec3(.80, .10, .32));
    float ls = dot(vec3(normalize(p), 0.), sun);
    hc *= mix(.28, 1.15, smoothstep(-.5, .5, ls));
    float l4 = ls*4.;
    hc += vec3(1., .46, .16) * exp(-l4*l4) * rim * .55;
  }
  hc = min(hc, vec3(1.));
  float ha = max(hc.r, max(hc.g, hc.b));
  vec4 outc = d >= R ? vec4(hc, ha) : vec4(0.);

  if (d < R) {
    float z = sqrt(R*R - d*d);
    vec3 n = vec3(p, z)/R;

    // VERTICAL rotation: the planet rolls about the horizontal (screen X) axis, so the surface travels up the screen,
    // over the pole and down the far side, instead of spinning left/right. Time gives a slow idle roll, scroll adds more.
    // Angles are divided by R so the on-screen surface speed stays the same whatever the screen width.
    vec3 m = vec3(n.x, n.y*uCS.x - n.z*uCS.y, n.y*uCS.y + n.z*uCS.x);
    vec3 w = rotY(m, -1.15);                      // keep the Middle East / India meridian on the rolling track
    vec2 tuv = equirect(w);

    vec3 t = texture(uTex, tuv).rgb;
    vec3 blur = textureLod(uTex, tuv, 3.2).rgb;

    // clouds: a separate layer that drifts a little against the ground
    vec3 wc = rotY(m, -1.15 + uTime*.004);
    float cl = 0.;
    if (uHas.y < .5) cl = smoothstep(.50, .78, fbm(wc*3.4 + vec3(0., uTime*.003, 0.)));   // procedural clouds only when there is no cloud map

    // split the map into city light (warm) and terrain (cool blue)
    float warm = max(t.r - t.b*.55, 0.);
    float warmB = max(blur.r - blur.b*.55, 0.);
    vec3 base;
    if (uHas.x < .5) {
    vec3 lights = vec3(1.,.72,.36) * (warm*17.) + vec3(1.,.55,.20) * (warmB*14.);
    lights *= 0.9 + 0.1*sin(uTime*1.3 + tuv.x*900. + tuv.y*700.);        // faint shimmer
    lights *= 1. - .75*cl;                                               // cities glow dimly through cloud

    // ocean is deep navy, land is lifted and contrasted so continents read clearly
    float land = smoothstep(.05, .22, dot(t, vec3(.3,.45,.25)));
    vec3 ocean = vec3(.008,.03,.085) + t*1.4;
    vec3 terrain = mix(ocean, pow(t, vec3(.72))*vec3(.95,1.15,1.55)*.78, land);

    // moonlit sheen on the ocean + soft haze of the atmosphere over the surface
    float sheen = pow(max(n.y*.8 + n.z*.35, 0.), 5.) * (1. - land);
    base = terrain + vec3(.06,.16,.36)*sheen*.5 + lights;
    base = mix(base, vec3(.16,.24,.40)*(.55 + .6*cl) + base*.25, cl*.55);  // cloud deck, faintly lit

    float fres = pow(1. - n.z, 2.4);
    base *= mix(1., .62, pow(1. - n.z, 1.4));
    base += vec3(.05,.20,.62) * fres * .95;                              // blue limb haze
    base += vec3(.55,.82,1.) * pow(1. - n.z, 8.) * .75;                  // bright rim just inside the edge
    } else {
      // ===== REAL EARTH: sun fixed in camera space, the planet rolls underneath it =====
      vec3 sun = normalize(vec3(.80, .10, .32));
      float ndl = dot(n, sun);
      float dayAmt = smoothstep(-.06, .18, ndl);
      float diff = pow(max(ndl, 0.), .8);

      vec3 dayTex = pow(texture(uDay, tuv).rgb, vec3(2.2));
      float oceanM = uHas.z > .5 ? texture(uSpec, tuv).r : smoothstep(.0, .10, dayTex.b - dayTex.r - .01);

      // clouds (real map if present, otherwise procedural), with a soft shadow cast onto the ground
      float cm = cl, shadow = 0.;
      if (uHas.y > .5) {
        vec2 cuv = equirect(wc);
        cm = texture(uCloud, cuv).r;
        shadow = texture(uCloud, tuv + vec2(.0016, -.0010)).r;
      }

      vec3 lit = dayTex * (1. - .18*oceanM) * (.03 + 1.35*diff);
      vec3 hv = normalize(sun + vec3(0., 0., 1.));
      lit += vec3(1., .92, .78) * pow(max(dot(n, hv), 0.), 110.) * oceanM * (1. - cm) * 1.8;   // sun glint on water
      lit *= 1. - .42*shadow*(1. - cm);
      lit = mix(lit, vec3(1.) * (.03 + 1.25*diff), cm*.9);                                      // sunlit cloud tops

      // night side: city lights (dimmed under cloud) and faint moonlit relief
      vec3 city = vec3(1., .72, .36) * (warm*17.) + vec3(1., .55, .20) * (warmB*14.);
      city *= 0.9 + 0.1*sin(uTime*1.3 + tuv.x*900. + tuv.y*700.);
      vec3 nightSide = dayTex*.014 + city*(1. - .8*cm) + vec3(.01,.02,.05)*cm;

      vec3 col = lit + nightSide*(1. - dayAmt);

      // twilight band along the terminator
      float tx = ndl*7.;
      col += vec3(.95, .42, .18) * exp(-tx*tx) * .14 * (.45 + .55*cm);

      // atmosphere seen through: Rayleigh blue haze, strongest toward the limb and on the lit side
      float fr = pow(1. - n.z, 2.2);
      col += vec3(.20, .46, 1.) * fr * (.16 + 1.05*smoothstep(-.3, .5, ndl));
      col += vec3(.55, .80, 1.) * pow(1. - n.z, 8.) * (.25 + .8*dayAmt);

      // filmic tone-map + gamma
      base = pow(1. - exp(-col*1.25), vec3(1./2.2));
    }

    float edge = 1. - smoothstep(R-.0035, R, d);
    outc = vec4(mix(hc, base*uFade, edge), mix(ha, 1., edge));
  }
  o = outc; // premultiplied alpha: space is transparent, the glow is additive
}`;

const BASE = import.meta.env.BASE_URL;
const TEX_URL = `${BASE}earth-night.jpg`;      // required: city lights (and the fallback look when no day map exists)
const DAY_URL = `${BASE}earth-day.jpg`;        // optional: 8K colour map  -> real day side, terminator, ocean glint
const CLOUD_URL = `${BASE}earth-clouds.jpg`;   // optional: 8K cloud map   -> real clouds with shadows
const SPEC_URL = `${BASE}earth-specular.jpg`;  // optional: ocean mask     -> sun glint on water

/** Draws a static starfield into two canvases. The second holds brighter stars and is twinkled by a CSS opacity animation. */
function drawSpace(bg: HTMLCanvasElement, tw: HTMLCanvasElement) {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const W = bg.clientWidth, H = bg.clientHeight;
  for (const cv of [bg, tw]) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = bg.getContext('2d')!;
  g.scale(dpr, dpr);
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#01030a'); grad.addColorStop(0.7, '#030816'); grad.addColorStop(1, '#050c1f');
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);
  const n = Math.round((W * H) / 5200);
  for (let i = 0; i < n; i++) {
    g.fillStyle = `rgba(215,230,255,${rnd(0.2, 0.8).toFixed(2)})`;
    const r = rnd(0.35, 1.1);
    g.fillRect(rnd(0, W), rnd(0, H), r, r);
  }
  const t = tw.getContext('2d')!;
  t.scale(dpr, dpr);
  const m = Math.round((W * H) / 26000);
  for (let i = 0; i < m; i++) {
    const x = rnd(0, W), y = rnd(0, H), r = rnd(0.8, 1.5);
    const rg = t.createRadialGradient(x, y, 0, x, y, r * 3);
    rg.addColorStop(0, 'rgba(235,242,255,.95)'); rg.addColorStop(1, 'rgba(235,242,255,0)');
    t.fillStyle = rg; t.beginPath(); t.arc(x, y, r * 3, 0, 6.2832); t.fill();
  }
}

export default function Globe({ progress, reduced, onFail }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const bgRef = useRef<HTMLCanvasElement>(null);
  const twRef = useRef<HTMLCanvasElement>(null);

  // static stars (drawn once, redrawn on a debounced resize)
  useEffect(() => {
    const bg = bgRef.current!, tw = twRef.current!;
    drawSpace(bg, tw);
    let rt = 0;
    const onResize = () => { clearTimeout(rt); rt = window.setTimeout(() => drawSpace(bg, tw), 200); };
    window.addEventListener('resize', onResize);
    return () => { clearTimeout(rt); window.removeEventListener('resize', onResize); };
  }, []);

  useEffect(() => {
    const cv = ref.current!;
    const gl = cv.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
    if (!gl) { onFail(); return; }
    const sh = (t: number, src: string) => {
      const s = gl.createShader(t)!; gl.shaderSource(s, src); gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
    const pr = gl.createProgram()!;
    if (!vs || !fs) { onFail(); return; }
    gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { onFail(); return; }
    gl.useProgram(pr);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = (n: string) => gl.getUniformLocation(pr, n);
    const uR = U('uR'), uCS = U('uCS'), uRes = U('uRes'), uScreenH = U('uScreenH'), uTime = U('uTime'), uP = U('uP'), uFade = U('uFade');
    gl.uniform1i(U('uTex'), 0);
    gl.useProgram(pr);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);

    let alive = true, raf = 0, visible = true, loaded = false, loadedAt = 0;
    let lastRender = -1e9, lastP = -1, ema = 16.7, slow = 0, calm = 0;
    const dprCap = Math.min(window.devicePixelRatio || 1, 1.5);
    const MAX_PIXELS = 2.4e6; // hard budget for the shader canvas: keeps 4K / retina screens smooth, the browser upscales the rest
    let ceiling = dprCap;      // never climb back above a scale that already proved too slow (stops resolution flip-flopping)
    let scale = dprCap; // adaptive render scale
    const t0 = performance.now();

    // Textures: unit 0 night lights (required), 1 day colour, 2 clouds, 3 ocean mask (all optional, 8K recommended).
    // Each unit starts as a 1x1 black texel so the sampler is always complete. The globe fades in once every texture
    // has either arrived or failed, so there is no pop.
    const has = [0, 0, 0];
    const uHas = U('uHas');
    gl.uniform1i(U('uDay'), 1); gl.uniform1i(U('uCloud'), 2); gl.uniform1i(U('uSpec'), 3);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const blank = () => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      return t;
    };
    let pending = 4;
    const settle = () => { if (--pending === 0 && alive) { loaded = true; loadedAt = performance.now(); lastRender = -1e9; ema = 16.7; slow = 0; calm = -60; start(); } };
    // Uploading + mip-mapping an 8K texture takes ~100 ms of main-thread time. Doing them one per task (with a gap)
    // keeps the intro animation and scrolling responsive while the textures arrive; the globe is still invisible then.
    const jobs: (() => void)[] = []; let pumping = false;
    const pump = () => { const j = jobs.shift(); if (!j || !alive) { pumping = false; return; } j(); setTimeout(pump, 60); };
    const enqueue = (j: () => void) => { jobs.push(j); if (!pumping) { pumping = true; setTimeout(pump, 0); } };
    const load = (unit: number, url: string, mono: boolean, flag: number, required: boolean) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      const tex = blank();
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => { enqueue(() => {
        if (!alive) return;
        let src: TexImageSource = img;
        if (img.width > maxTex) { // small GPUs: downscale to something they can hold
          const c = document.createElement('canvas'); c.width = maxTex; c.height = maxTex / 2;
          c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height); src = c;
        }
        gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
        if (mono) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, src); // one channel: a quarter of the memory
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number));
        if (flag >= 0) { has[flag] = 1; gl.uniform3f(uHas, has[0], has[1], has[2]); }
        settle();
      }); };
      img.onerror = () => { if (!alive) return; if (required) onFail(); else settle(); };
      img.src = url;
    };
    gl.uniform3f(uHas, 0, 0, 0);
    load(0, TEX_URL, false, -1, true);
    load(1, DAY_URL, false, 0, false);
    load(2, CLOUD_URL, true, 1, false);
    load(3, SPEC_URL, true, 2, false);

    const render = (now: number) => {
      const cw = cv.clientWidth, chh = cv.clientHeight;
      const sc = Math.min(scale, Math.sqrt(MAX_PIXELS / Math.max(cw * chh, 1)));
      const W = Math.max(1, Math.round(cw * sc)), H = Math.max(1, Math.round(chh * sc));
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      gl.viewport(0, 0, W, H);
      const screenH = (chh / GLOBE_FRAC) * sc;
      const t = 2 + (now - t0) / 1000 * (reduced ? 0.5 : 1); // always turning from the first frame (gently under reduced motion)
      const P = Math.min(Math.max(progress.current, 0), 1);
      // radius follows the aspect so the horizon runs edge to edge; the roll angle's sin/cos are done once here, not per pixel
      const hw = 0.5 * W / screenH * 1.04, sag = 0.24;
      const R = Math.max((hw * hw + sag * sag) / (2 * sag), 1.6);
      const roll = 0.5 + t * 0.085 / R + P * 2.6 / R;
      gl.uniform1f(uR, R);
      gl.uniform2f(uCS, Math.cos(roll), Math.sin(roll));
      gl.uniform2f(uRes, W, H);
      gl.uniform1f(uScreenH, screenH);
      gl.uniform1f(uTime, t);
      gl.uniform1f(uP, P);
      gl.uniform1f(uFade, loaded ? Math.min((now - loadedAt) / 700, 1) : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    // One render per display frame (60 fps; every 2nd frame on 120/144 Hz panels). Resolution is the only thing that
    // gives way when the GPU is busy, so motion stays fluid instead of dropping to a steppy 30 fps.
    const GATE = reduced ? 33 : 12;
    const frame = (now: number) => {
      raf = 0; if (!alive) return;
      const p = Math.min(Math.max(progress.current, 0), 1);

      // sink the planet on the compositor (cheap, 60fps)
      if (Math.abs(p - lastP) > 1e-4) {
        lastP = p;
        cv.style.transform = `translate3d(0,${(p * SINK * (cv.clientHeight / GLOBE_FRAC)).toFixed(1)}px,0)`;
      }

      const fading = loaded && now - loadedAt < 800;
      const done = p >= 0.999 && !fading; // story is behind us: nothing to animate
      if (!done && loaded && now - lastRender >= GATE) {
        const dt = now - lastRender; lastRender = now;
        render(now);
        if (dt < 250) ema = ema * 0.9 + dt * 0.1; // time between our own renders: grows only if the GPU / main thread can't keep up
        if (ema > 22 && scale > 0.5) { if (++slow > 12) { scale = Math.max(0.5, scale * 0.85); ceiling = Math.min(ceiling, scale * 1.06); slow = 0; ema = 16.7; } } else slow = 0;
        if (ema < 17.5 && scale < ceiling) { if (++calm > 300) { scale = Math.min(ceiling, scale * 1.08); calm = 0; } } else if (calm > 0) calm = 0;
      } else if (!loaded && !done) {
        lastRender = now; // nothing to draw yet (textures still arriving); keep the clock fresh so the first frame isn't a long one
      }
      if (visible && !done) raf = requestAnimationFrame(frame);
    };
    function start() { if (!raf && alive) { raf = requestAnimationFrame(frame); } }
    const onVis = () => { visible = !document.hidden; if (visible) start(); };
    const onLost = (e: Event) => { e.preventDefault(); onFail(); };
    document.addEventListener('visibilitychange', onVis);
    cv.addEventListener('webglcontextlost', onLost);
    window.addEventListener('resize', start);
    const onScroll = () => start();
    window.addEventListener('scroll', onScroll, { passive: true });
    start();
    return () => {
      alive = false; cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
      cv.removeEventListener('webglcontextlost', onLost);
      window.removeEventListener('resize', start); window.removeEventListener('scroll', onScroll);
    };
  }, [progress, reduced, onFail]);

  return (
    <>
      <canvas ref={bgRef} className="cosmos space" aria-hidden="true" />
      <canvas ref={twRef} className="cosmos space tw" aria-hidden="true" />
      <canvas ref={ref} className="cosmos globe" aria-hidden="true" />
    </>
  );
}
