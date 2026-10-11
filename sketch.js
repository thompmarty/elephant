/* ────────────────────────────────────────────────────────────────
   Lava — ambient blob simulator
   Dark-mode, mobile-first. Blobs drift under tilt gravity, fuse
   via a WebGL metaball shader with lava-lamp lighting, and respond
   to touch (hole · slice · spawn · reset).
   ──────────────────────────────────────────────────────────────── */

/* ======================= CONFIG ======================= */
const MAX_BLOBS   = 14;
const MAX_HOLES   = 4;
const START_BLOBS = 7;

// Physics
const GRAVITY_SCALE   = 0.18;
const GRAVITY_SMOOTH  = 0.07;
const DAMPING         = 0.97;
const WALL_BOUNCE     = 0.5;
const SEPARATION      = 0.035;   // soft push between non-merged blobs
const BUOY_AMP        = 0.06;    // random thermal drift amplitude
const BUOY_RATE       = 0.0009;  // thermal oscillation rate

// Sizes
const MIN_R           = 46;
const MAX_R           = 170;
const SPAWN_R_MIN     = 42;
const SPAWN_R_MAX     = 78;

// Merge / split
const MERGE_OVERLAP   = 0.55;
const SPLIT_MIN_R     = 72;

// Touch
const HOLE_RADIUS     = 92;
const HOLE_STRENGTH   = 1.45;
const HOLE_PUSH       = 0.5;
const HOLE_PUSH_REACH = HOLE_RADIUS * 1.9;
const SLICE_SPEED     = 1.6;     // px / ms
const SLICE_DIST      = 0.42;    // segment-blob distance as fraction of r
const SLICE_COOLDOWN  = 180;     // ms per blob to avoid double-slice
const TAP_MAX_DUR     = 160;     // ms
const TAP_MAX_MOVE    = 8;       // px
const DOUBLE_TAP_MS   = 320;

// Rendering
const METABALL_LO     = 0.95;
const METABALL_HI     = 1.08;

/* ======================= PALETTE ======================= */
// Rich jewel tones, intentionally medium saturation so lighting reads cleanly.
const PALETTE = [
  [0.165, 0.616, 0.561],  // teal        #2A9D8F
  [0.784, 0.275, 0.357],  // burnt rose  #C8465B
  [0.878, 0.604, 0.259],  // amber       #E09A42
  [0.545, 0.361, 0.965],  // violet      #8B5CF6
  [0.851, 0.478, 0.588],  // dusty pink  #D97A96
  [0.251, 0.333, 0.722],  // indigo      #4055B8
  [0.251, 0.733, 0.671],  // mint-teal   #40BBAB
  [0.937, 0.388, 0.502],  // rose glow   #EF6380
];

/* ======================= STATE ======================= */
let blobs = [];
let holes = [];
let metaShader;

let tiltG   = { x: 0, y: 0 };    // smoothed gravity direction (unit-ish)
let rawG    = { x: 0, y: 1 };    // raw tilt input
let useSensor = false;

let startMs = 0;

// Primary pointer tracking for slice/tap gestures
let pointer = {
  active: false,
  x: 0, y: 0,
  prevX: 0, prevY: 0,
  startX: 0, startY: 0,
  startMs: 0,
  vx: 0, vy: 0,         // px/ms
  slicedBlobKeys: new Map(), // blobKey -> lastSlicedAtMs
};
let blobKeyCounter = 1;
let lastTapMs = 0;

let hintEl = null;
let hintHidden = false;

/* ======================= SHADERS ======================= */
const VERT_SRC = `
precision highp float;
attribute vec3 aPosition;
attribute vec2 aTexCoord;
varying vec2 vTexCoord;
void main() {
  vTexCoord = aTexCoord;
  vec4 pos = vec4(aPosition, 1.0);
  pos.xy = pos.xy * 2.0 - 1.0;
  gl_Position = pos;
}
`;

const FRAG_SRC = `
precision highp float;

#define MAX_BLOBS 14
#define MAX_HOLES 4

uniform vec2  uResolution;
uniform int   uBlobCount;
uniform vec4  uBlobs[MAX_BLOBS];   // xy=pos, z=radius, w=wobble phase 0..1
uniform vec3  uColors[MAX_BLOBS];
uniform int   uHoleCount;
uniform vec3  uHoles[MAX_HOLES];   // xy=pos, z=radius
uniform float uHoleStrength;
uniform vec2  uGravityDir;         // unit-ish, points "down" in screen space
uniform float uTime;

varying vec2 vTexCoord;

float hash12(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  // vTexCoord [0,1]; flip Y so pixel space matches JS (origin top-left)
  vec2 p = vec2(vTexCoord.x, 1.0 - vTexCoord.y) * uResolution;

  float F = 0.0;
  vec3  accumColor = vec3(0.0);
  float weightSum  = 0.0;

  // Track the single dominant blob at this pixel for lighting
  float bestContrib = 0.0;
  vec2  bestD = vec2(0.0);
  float bestR = 1.0;

  for (int i = 0; i < MAX_BLOBS; i++) {
    if (i >= uBlobCount) break;
    vec2  bp = uBlobs[i].xy;
    float br = uBlobs[i].z;
    float ph = uBlobs[i].w;
    vec2  d  = p - bp;

    // Per-blob angular wobble so edges breathe organically
    float ang = atan(d.y, d.x);
    float wobble = 1.0
      + 0.065 * sin(ang * 3.0 + ph * 6.2831 + uTime * 1.00)
      + 0.040 * sin(ang * 5.0 - ph * 3.1416 + uTime * 0.63);
    float effR = br * wobble;

    float dd = dot(d, d) + 2.0;
    float contrib = (effR * effR) / dd;

    F          += contrib;
    accumColor += uColors[i] * contrib;
    weightSum  += contrib;

    if (contrib > bestContrib) {
      bestContrib = contrib;
      bestD       = d;
      bestR       = br;
    }
  }

  // Holes carve negative field — pixels fall below threshold
  for (int j = 0; j < MAX_HOLES; j++) {
    if (j >= uHoleCount) break;
    vec2  hp = uHoles[j].xy;
    float hr = uHoles[j].z;
    vec2  d  = p - hp;
    float dd = dot(d, d) + 2.0;
    F -= uHoleStrength * (hr * hr) / dd;
  }

  vec3 baseColor = (weightSum > 0.0) ? (accumColor / weightSum) : vec3(0.3);

  // Gooey isosurface mask
  float mask = smoothstep(${METABALL_LO.toFixed(3)}, ${METABALL_HI.toFixed(3)}, F);

  // Lighting: treat the dominant blob as a disc, derive a pseudo-normal from
  // offset to its center. Light sits opposite gravity ("the lamp above").
  vec2 N = bestR > 0.0 ? (bestD / bestR) : vec2(0.0);
  float nLen = length(N);
  N = nLen > 0.001 ? N / nLen : vec2(0.0);

  vec2 lightDir = -uGravityDir + vec2(0.18, 0.0);
  float ll = length(lightDir);
  lightDir = ll > 0.0001 ? lightDir / ll : vec2(0.0, -1.0);

  float ndl  = dot(N, lightDir);
  float diff = 0.5 + 0.5 * ndl;                 // half-lambert
  float spec = pow(max(ndl, 0.0), 10.0);        // tight specular

  // Core/edge gradient — brighter near interior, darker near rim
  float core = smoothstep(1.15, 2.4, F);
  float edge = 1.0 - smoothstep(0.98, 1.25, F); // rim factor

  vec3 lit = baseColor * (0.55 + 0.55 * diff);
  lit = mix(lit, lit * 1.18, core);
  lit = mix(lit, lit * 0.72, edge * 0.55);      // slight rim darkening
  lit += vec3(spec * 0.85);                     // white highlight on top

  // Outer glow in blob color just below the threshold
  float glow = smoothstep(0.35, ${METABALL_LO.toFixed(3)}, F) * (1.0 - mask);

  // Background: subtle radial gradient + dither to kill banding
  vec2 uv  = vTexCoord - 0.5;
  float r2 = dot(uv, uv);
  vec3 bg  = mix(vec3(0.016, 0.021, 0.040), vec3(0.001, 0.002, 0.008), r2 * 1.9);
  bg += (hash12(gl_FragCoord.xy + uTime) - 0.5) * 0.004;

  vec3 outColor = mix(bg, lit, mask) + 0.28 * glow * baseColor;

  // Vignette
  float vig = smoothstep(0.85, 0.22, length(uv));
  outColor *= mix(0.78, 1.0, vig);

  // Mild gamma
  outColor = pow(outColor, vec3(0.95));

  gl_FragColor = vec4(outColor, 1.0);
}
`;

/* ======================= p5 LIFECYCLE ======================= */
function setup() {
  const c = createCanvas(windowWidth, windowHeight, WEBGL);
  c.elt.style.display  = 'block';
  c.elt.style.position = 'absolute';
  c.elt.style.top      = '0';
  c.elt.style.left     = '0';
  pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
  noStroke();

  metaShader = createShader(VERT_SRC, FRAG_SRC);
  startMs    = millis();

  spawnInitialBlobs();
  initMotion();

  hintEl = document.getElementById('hint');
  // Hide hint on first interaction or after 6s
  const hideHint = () => {
    if (!hintEl || hintHidden) return;
    hintHidden = true;
    hintEl.classList.add('hidden');
  };
  setTimeout(hideHint, 6000);
  window.addEventListener('pointerdown', hideHint, { once: true });

  requestWakeLock();
}

function draw() {
  clear();

  const dt = Math.min(deltaTime / 16.667, 2.2);
  const now = millis();

  updatePointer(now);
  updateHoles();
  updateGravity();
  stepPhysics(dt, now);
  mergeBlobs();

  renderBlobs(now);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

/* ======================= INIT / SPAWN ======================= */
function spawnInitialBlobs() {
  blobs = [];
  for (let i = 0; i < START_BLOBS; i++) {
    blobs.push(makeBlob(
      random(width  * 0.18, width  * 0.82),
      random(height * 0.18, height * 0.82),
      random(SPAWN_R_MIN, SPAWN_R_MIN + 25),
      i % PALETTE.length
    ));
  }
}

function makeBlob(x, y, r, paletteIdx) {
  const c = PALETTE[((paletteIdx | 0) + PALETTE.length) % PALETTE.length];
  return {
    key:   blobKeyCounter++,
    x, y,
    vx: random(-0.4, 0.4),
    vy: random(-0.4, 0.4),
    r,
    color: [c[0], c[1], c[2]],
    phase: Math.random(),           // 0..1 for wobble offset
    buoy:  random(-1, 1),           // thermal direction per-blob
  };
}

function resetScene() {
  pointer.slicedBlobKeys.clear();
  spawnInitialBlobs();
  haptic(25);
}

/* ======================= MOTION ======================= */
function initMotion() {
  const gate = document.getElementById('motion-gate');
  const btn  = document.getElementById('motion-btn');

  const attach = () => {
    window.addEventListener('deviceorientation', handleOrientation);
  };

  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    // iOS 13+ — show gate, request on tap
    if (gate) gate.classList.add('visible');
    if (btn) {
      btn.addEventListener('click', async () => {
        try {
          const res = await DeviceOrientationEvent.requestPermission();
          if (res === 'granted') attach();
        } catch (_) {}
        if (gate) gate.classList.remove('visible');
      }, { once: true });
    }
  } else if (typeof window.DeviceOrientationEvent !== 'undefined') {
    attach();
  }
}

function handleOrientation(e) {
  if (e.gamma == null || e.beta == null) return;
  const angle = (screen && screen.orientation && typeof screen.orientation.angle === 'number')
    ? screen.orientation.angle : 0;
  let gx, gy;
  if (angle === 90) {
    gx = e.beta / 45;
    gy = -e.gamma / 45;
  } else if (angle === -90 || angle === 270) {
    gx = -e.beta / 45;
    gy = e.gamma / 45;
  } else if (angle === 180) {
    gx = -e.gamma / 45;
    gy = -e.beta / 45;
  } else {
    gx = e.gamma / 45;
    gy = e.beta / 45;
  }
  rawG.x = constrain(gx, -1.8, 1.8);
  rawG.y = constrain(gy, -1.8, 1.8);
  useSensor = true;
}

function updateGravity() {
  if (!useSensor) {
    // Desktop fallback: cursor offset drives tilt while pressed; else gentle down.
    if (mouseIsPressed) {
      rawG.x = ((mouseX / width)  - 0.5) * 2.8;
      rawG.y = ((mouseY / height) - 0.5) * 2.8;
    } else {
      rawG.x *= 0.9;
      rawG.y = rawG.y * 0.9 + 1.0 * 0.1;
    }
  }
  tiltG.x += (rawG.x - tiltG.x) * GRAVITY_SMOOTH;
  tiltG.y += (rawG.y - tiltG.y) * GRAVITY_SMOOTH;
}

/* ======================= INPUT / POINTER ======================= */
// p5 touch handlers — unified with mouse via updatePointer each frame
function touchStarted() {
  onPointerDown(touches[0] ? touches[0].x : mouseX,
                touches[0] ? touches[0].y : mouseY);
  return false;
}
function touchEnded() {
  onPointerUp();
  return false;
}
function mousePressed()  { if (!touches || touches.length === 0) onPointerDown(mouseX, mouseY); }
function mouseReleased() { if (!touches || touches.length === 0) onPointerUp(); }

function onPointerDown(x, y) {
  pointer.active = true;
  pointer.x = pointer.prevX = pointer.startX = x;
  pointer.y = pointer.prevY = pointer.startY = y;
  pointer.vx = pointer.vy = 0;
  pointer.startMs = millis();
  pointer.slicedBlobKeys.clear();
}

function onPointerUp() {
  const now = millis();
  const dur = now - pointer.startMs;
  const dx  = pointer.x - pointer.startX;
  const dy  = pointer.y - pointer.startY;
  const moved = Math.hypot(dx, dy);

  if (pointer.active && dur < TAP_MAX_DUR && moved < TAP_MAX_MOVE) {
    // Short tap → either double-tap-reset or spawn
    if (now - lastTapMs < DOUBLE_TAP_MS) {
      resetScene();
      lastTapMs = 0;
    } else {
      lastTapMs = now;
      if (!blobUnderPoint(pointer.x, pointer.y)) {
        trySpawnBlob(pointer.x, pointer.y);
      }
    }
  }
  pointer.active = false;
}

function updatePointer(now) {
  // Sync pointer position from active touch or mouse-press
  if (touches && touches.length > 0) {
    pointer.prevX = pointer.x;
    pointer.prevY = pointer.y;
    pointer.x = touches[0].x;
    pointer.y = touches[0].y;
  } else if (mouseIsPressed && pointer.active) {
    pointer.prevX = pointer.x;
    pointer.prevY = pointer.y;
    pointer.x = mouseX;
    pointer.y = mouseY;
  }

  // Velocity (px/ms), low-pass smoothed
  const dtMs = Math.max(deltaTime, 1);
  const ivx = (pointer.x - pointer.prevX) / dtMs;
  const ivy = (pointer.y - pointer.prevY) / dtMs;
  pointer.vx = pointer.vx * 0.5 + ivx * 0.5;
  pointer.vy = pointer.vy * 0.5 + ivy * 0.5;

  // Slice: if pointer is fast enough, test for blob intersections
  if (pointer.active) {
    const speed = Math.hypot(pointer.vx, pointer.vy);
    if (speed > SLICE_SPEED) {
      trySliceAlongSegment(pointer.prevX, pointer.prevY, pointer.x, pointer.y, now);
    }
  }
}

function updateHoles() {
  holes = [];
  if (touches && touches.length > 0) {
    for (let i = 0; i < touches.length && holes.length < MAX_HOLES; i++) {
      holes.push({ x: touches[i].x, y: touches[i].y, r: HOLE_RADIUS });
    }
  } else if (mouseIsPressed) {
    holes.push({ x: mouseX, y: mouseY, r: HOLE_RADIUS });
  }
}

/* ======================= SLICING ======================= */
function trySliceAlongSegment(x1, y1, x2, y2, now) {
  const sx = x2 - x1, sy = y2 - y1;
  const segLen2 = sx * sx + sy * sy;
  if (segLen2 < 1e-6) return;
  const segLen = Math.sqrt(segLen2);
  const dirX = sx / segLen, dirY = sy / segLen;
  const perpX = -dirY,       perpY = dirX;

  for (let i = blobs.length - 1; i >= 0; i--) {
    const b = blobs[i];
    if (b.r < SPLIT_MIN_R) continue;
    const last = pointer.slicedBlobKeys.get(b.key) || 0;
    if (now - last < SLICE_COOLDOWN) continue;
    if (blobs.length >= MAX_BLOBS) break;

    // Distance from b's center to the segment [x1,y1]-[x2,y2]
    const px = b.x - x1, py = b.y - y1;
    const t = Math.max(0, Math.min(1, (px * sx + py * sy) / segLen2));
    const cx = x1 + sx * t;
    const cy = y1 + sy * t;
    const dx = b.x - cx, dy = b.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > b.r * SLICE_DIST) continue;

    // Split along perpendicular
    const newR = b.r / Math.SQRT2;
    const offset = newR * 0.9;
    const a1 = {
      key: blobKeyCounter++,
      x: b.x + perpX * offset, y: b.y + perpY * offset,
      vx: b.vx + perpX * 0.9,  vy: b.vy + perpY * 0.9,
      r: newR, color: [...b.color],
      phase: Math.random(),    buoy: random(-1, 1),
    };
    const a2 = {
      key: blobKeyCounter++,
      x: b.x - perpX * offset, y: b.y - perpY * offset,
      vx: b.vx - perpX * 0.9,  vy: b.vy - perpY * 0.9,
      r: newR, color: [...b.color],
      phase: Math.random(),    buoy: random(-1, 1),
    };
    blobs.splice(i, 1, a1, a2);
    pointer.slicedBlobKeys.set(a1.key, now);
    pointer.slicedBlobKeys.set(a2.key, now);
    haptic(18);
  }
}

/* ======================= SPAWN / HIT-TEST ======================= */
function blobUnderPoint(x, y) {
  for (const b of blobs) {
    const dx = b.x - x, dy = b.y - y;
    if (dx * dx + dy * dy < b.r * b.r) return b;
  }
  return null;
}

function trySpawnBlob(x, y) {
  if (blobs.length >= MAX_BLOBS) return;
  const idx = Math.floor(Math.random() * PALETTE.length);
  blobs.push(makeBlob(x, y, random(SPAWN_R_MIN, SPAWN_R_MAX), idx));
  haptic(8);
}

/* ======================= PHYSICS ======================= */
function stepPhysics(dt, now) {
  const gx = tiltG.x * GRAVITY_SCALE;
  const gy = tiltG.y * GRAVITY_SCALE;

  // Buoyancy direction = opposite of gravity, scaled by per-blob buoy
  const upx = -tiltG.x, upy = -tiltG.y;

  for (const b of blobs) {
    b.vx += gx * dt;
    b.vy += gy * dt;

    // Thermal / buoyancy: slow sinusoidal push roughly "up"
    const osc = Math.sin((now + b.key * 173) * BUOY_RATE);
    b.vx += upx * BUOY_AMP * b.buoy * osc * dt;
    b.vy += upy * BUOY_AMP * b.buoy * osc * dt;

    // Hole repulsion
    for (const h of holes) {
      const dx = b.x - h.x, dy = b.y - h.y;
      const d  = Math.sqrt(dx * dx + dy * dy) + 0.001;
      if (d < HOLE_PUSH_REACH) {
        const falloff = 1.0 - d / HOLE_PUSH_REACH;
        const f = HOLE_PUSH * falloff * falloff;
        b.vx += (dx / d) * f;
        b.vy += (dy / d) * f;
      }
    }
  }

  // Pairwise separation to resist premature full-merge
  for (let i = 0; i < blobs.length; i++) {
    for (let j = i + 1; j < blobs.length; j++) {
      const a = blobs[i], b = blobs[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d  = Math.sqrt(dx * dx + dy * dy) + 0.001;
      const target = (a.r + b.r) * 0.78;
      if (d < target) {
        const push = (target - d) * SEPARATION;
        const nx = dx / d, ny = dy / d;
        a.vx -= nx * push;
        a.vy -= ny * push;
        b.vx += nx * push;
        b.vy += ny * push;
      }
    }
  }

  for (const b of blobs) {
    b.vx *= Math.pow(DAMPING, dt);
    b.vy *= Math.pow(DAMPING, dt);

    b.x += b.vx * dt;
    b.y += b.vy * dt;

    const pad = b.r * 0.3;
    if (b.x < pad)          { b.x = pad;          b.vx =  Math.abs(b.vx) * WALL_BOUNCE; }
    if (b.x > width  - pad) { b.x = width  - pad; b.vx = -Math.abs(b.vx) * WALL_BOUNCE; }
    if (b.y < pad)          { b.y = pad;          b.vy =  Math.abs(b.vy) * WALL_BOUNCE; }
    if (b.y > height - pad) { b.y = height - pad; b.vy = -Math.abs(b.vy) * WALL_BOUNCE; }
  }
}

function mergeBlobs() {
  for (let i = 0; i < blobs.length; i++) {
    for (let j = i + 1; j < blobs.length; j++) {
      const a = blobs[i], b = blobs[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d  = Math.sqrt(dx * dx + dy * dy);
      const minR = Math.min(a.r, b.r);
      if (d < (a.r + b.r) - minR * MERGE_OVERLAP) {
        const areaA = a.r * a.r;
        const areaB = b.r * b.r;
        const newR  = Math.sqrt(areaA + areaB);
        if (newR > MAX_R) continue;

        const total = areaA + areaB;
        a.x = (a.x * areaA + b.x * areaB) / total;
        a.y = (a.y * areaA + b.y * areaB) / total;
        a.vx = (a.vx * areaA + b.vx * areaB) / total;
        a.vy = (a.vy * areaA + b.vy * areaB) / total;
        a.color = [
          (a.color[0] * areaA + b.color[0] * areaB) / total,
          (a.color[1] * areaA + b.color[1] * areaB) / total,
          (a.color[2] * areaA + b.color[2] * areaB) / total,
        ];
        a.r = newR;

        blobs.splice(j, 1);
        j--;
        haptic(10);
      }
    }
  }
}

/* ======================= RENDER ======================= */
function renderBlobs(now) {
  const count = Math.min(blobs.length, MAX_BLOBS);

  const blobBuf  = new Array(MAX_BLOBS * 4).fill(0);
  const colorBuf = new Array(MAX_BLOBS * 3).fill(0);
  for (let i = 0; i < count; i++) {
    const b = blobs[i];
    blobBuf[i * 4 + 0] = b.x;
    blobBuf[i * 4 + 1] = b.y;
    blobBuf[i * 4 + 2] = b.r;
    blobBuf[i * 4 + 3] = b.phase;
    colorBuf[i * 3 + 0] = b.color[0];
    colorBuf[i * 3 + 1] = b.color[1];
    colorBuf[i * 3 + 2] = b.color[2];
  }

  const holeCount = Math.min(holes.length, MAX_HOLES);
  const holeBuf   = new Array(MAX_HOLES * 3).fill(0);
  for (let i = 0; i < holeCount; i++) {
    holeBuf[i * 3 + 0] = holes[i].x;
    holeBuf[i * 3 + 1] = holes[i].y;
    holeBuf[i * 3 + 2] = holes[i].r;
  }

  // Normalize gravity for lighting
  const gLen = Math.hypot(tiltG.x, tiltG.y) || 1;
  const gDirX = tiltG.x / gLen;
  const gDirY = tiltG.y / gLen;

  shader(metaShader);
  metaShader.setUniform('uResolution',   [width, height]);
  metaShader.setUniform('uBlobCount',    count);
  metaShader.setUniform('uBlobs',        blobBuf);
  metaShader.setUniform('uColors',       colorBuf);
  metaShader.setUniform('uHoleCount',    holeCount);
  metaShader.setUniform('uHoles',        holeBuf);
  metaShader.setUniform('uHoleStrength', HOLE_STRENGTH);
  metaShader.setUniform('uGravityDir',   [gDirX, gDirY]);
  metaShader.setUniform('uTime',         (now - startMs) / 1000);

  rect(0, 0, width, height);
}

/* ======================= MISC ======================= */
function haptic(ms) {
  if (navigator.vibrate) {
    try { navigator.vibrate(ms); } catch (_) {}
  }
}

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') {
          try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
        }
      });
    }
  } catch (_) {}
}
