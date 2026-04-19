/***************************************************************
 * Lava Lamp Blob Simulator
 *
 * Dark-mode, ambient, mobile-first. Blobs fall slowly in the
 * direction of phone tilt (DeviceOrientation), fuse and morph
 * on contact (WebGL metaball shader), and respond to touch by
 * carving a soft repulsive hole.
 ***************************************************************/

const MAX_BLOBS   = 12;
const MAX_HOLES   = 4;
const START_BLOBS = 8;

const GRAVITY_SCALE    = 0.18;
const GRAVITY_SMOOTH   = 0.08;
const DAMPING          = 0.965;
const WALL_BOUNCE      = 0.55;

const MIN_R            = 55;
const MAX_R            = 180;
const MERGE_OVERLAP    = 0.55;

const HOLE_RADIUS      = 95;
const HOLE_STRENGTH    = 1.35;
const HOLE_PUSH        = 0.45;
const HOLE_PUSH_REACH  = HOLE_RADIUS * 1.8;

const METABALL_LO      = 0.95;
const METABALL_HI      = 1.15;

const PALETTE = [
  [0.247, 0.714, 0.659],  // #3FB6A8 muted teal
  [0.769, 0.314, 0.557],  // #C4508E magenta
  [0.847, 0.604, 0.290],  // #D89A4A amber
  [0.498, 0.373, 0.780],  // #7F5FC7 violet
  [0.290, 0.435, 0.690],  // #4A6FB0 indigo
  [0.878, 0.412, 0.482],  // #E0697B coral
];

// ---------------- STATE ----------------
let blobs = [];
let holes = [];
let metaShader;
let tiltGravity = { x: 0, y: 0 };      // smoothed gravity direction
let rawGravity  = { x: 0, y: 1 };      // raw input (defaults to "down")
let useSensor   = false;
let startTime   = 0;

// ---------------- SHADERS ----------------
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

#define MAX_BLOBS 12
#define MAX_HOLES 4

uniform vec2  uResolution;
uniform int   uBlobCount;
uniform vec4  uBlobs[MAX_BLOBS];   // xy=pos, z=radius, w=unused
uniform vec3  uColors[MAX_BLOBS];  // rgb
uniform int   uHoleCount;
uniform vec3  uHoles[MAX_HOLES];   // xy=pos, z=radius
uniform float uHoleStrength;
uniform float uTime;

varying vec2 vTexCoord;

void main() {
  // vTexCoord is [0,1]; flip Y so (0,0) is top-left in pixels
  vec2 p = vec2(vTexCoord.x, 1.0 - vTexCoord.y) * uResolution;

  float F = 0.0;
  vec3  accumColor = vec3(0.0);
  float weightSum  = 0.0;

  for (int i = 0; i < MAX_BLOBS; i++) {
    if (i >= uBlobCount) break;
    vec2  bp = uBlobs[i].xy;
    float br = uBlobs[i].z;
    vec2  d  = p - bp;
    float dd = dot(d, d) + 1.0;
    float contrib = (br * br) / dd;
    F          += contrib;
    accumColor += uColors[i] * contrib;
    weightSum  += contrib;
  }

  for (int j = 0; j < MAX_HOLES; j++) {
    if (j >= uHoleCount) break;
    vec2  hp = uHoles[j].xy;
    float hr = uHoles[j].z;
    vec2  d  = p - hp;
    float dd = dot(d, d) + 1.0;
    F -= uHoleStrength * (hr * hr) / dd;
  }

  vec3 color = (weightSum > 0.0) ? (accumColor / weightSum) : vec3(0.4);

  // slow ambient color drift
  float t = uTime;
  vec3 drift = vec3(
    0.5 + 0.5 * sin(t * 0.30),
    0.5 + 0.5 * sin(t * 0.27 + 2.0),
    0.5 + 0.5 * sin(t * 0.23 + 4.0)
  );
  color = mix(color, color * (0.85 + 0.35 * drift), 0.22);

  // gooey isosurface
  float mask = smoothstep(${METABALL_LO.toFixed(3)}, ${METABALL_HI.toFixed(3)}, F);

  // interior rim lift (brighter toward thick core)
  float core = smoothstep(1.15, 1.8, F);
  vec3  surf = mix(color * 0.55, color * 1.12, core);

  // soft glow just outside the isosurface
  float glow = smoothstep(0.35, ${METABALL_LO.toFixed(3)}, F) * (1.0 - mask);

  vec3 bg = vec3(0.020, 0.023, 0.043);
  vec3 outColor = mix(bg, surf, mask) + 0.22 * glow * color;

  // vignette
  vec2 q = vTexCoord - 0.5;
  float vig = smoothstep(0.85, 0.25, length(q));
  outColor *= mix(0.80, 1.0, vig);

  // gamma
  outColor = pow(outColor, vec3(0.95));

  gl_FragColor = vec4(outColor, 1.0);
}
`;

// ---------------- p5 HOOKS ----------------
function setup() {
  const c = createCanvas(windowWidth, windowHeight, WEBGL);
  c.elt.style.display  = 'block';
  c.elt.style.position = 'absolute';
  c.elt.style.top      = '0';
  c.elt.style.left     = '0';
  pixelDensity(1);
  noStroke();

  metaShader = createShader(VERT_SRC, FRAG_SRC);
  startTime  = millis();

  spawnInitialBlobs();
  initMotion();
}

function draw() {
  clear();

  const dt = Math.min(deltaTime / 16.667, 2.0); // cap dt in case of hitches
  updateHoles();
  updateGravity();
  stepPhysics(dt);
  mergeBlobs();

  renderBlobs();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

// ---------------- INIT ----------------
function spawnInitialBlobs() {
  blobs = [];
  for (let i = 0; i < START_BLOBS; i++) {
    blobs.push(makeBlob(
      random(width * 0.15, width * 0.85),
      random(height * 0.15, height * 0.85),
      random(MIN_R, MIN_R + 45),
      i % PALETTE.length
    ));
  }
}

function makeBlob(x, y, r, paletteIdx) {
  const c = PALETTE[paletteIdx % PALETTE.length];
  return {
    x, y,
    vx: random(-0.4, 0.4),
    vy: random(-0.4, 0.4),
    r,
    color: [c[0], c[1], c[2]],
  };
}

// ---------------- MOTION / GRAVITY ----------------
function initMotion() {
  const gate = document.getElementById('motion-gate');
  const btn  = document.getElementById('motion-btn');

  const attachListener = () => {
    window.addEventListener('deviceorientation', handleOrientation);
  };

  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    // iOS 13+ requires an explicit user gesture
    if (gate) gate.classList.add('visible');
    if (btn) {
      btn.addEventListener('click', async () => {
        try {
          const res = await DeviceOrientationEvent.requestPermission();
          if (res === 'granted') attachListener();
        } catch (_) { /* ignore — fall through to desktop-style gravity */ }
        if (gate) gate.classList.remove('visible');
      }, { once: true });
    }
  } else if (typeof window.DeviceOrientationEvent !== 'undefined') {
    attachListener();
  }
}

function handleOrientation(e) {
  // gamma: left/right tilt (-90..90). beta: front/back tilt (-180..180).
  if (e.gamma == null || e.beta == null) return;
  // Landscape vs portrait: use screen.orientation if available
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
  rawGravity.x = constrain(gx, -1.8, 1.8);
  rawGravity.y = constrain(gy, -1.8, 1.8);
  useSensor = true; // only flip once a real orientation event arrives
}

function updateGravity() {
  if (!useSensor) {
    // Desktop fallback: cursor offset from screen center acts as tilt when
    // pressed; otherwise a gentle downward pull so blobs still settle.
    let tx = 0, ty = 1.0;
    if (mouseIsPressed) {
      tx = ((mouseX / width)  - 0.5) * 3.0;
      ty = ((mouseY / height) - 0.5) * 3.0;
    }
    rawGravity.x = tx;
    rawGravity.y = ty;
  }
  tiltGravity.x += (rawGravity.x - tiltGravity.x) * GRAVITY_SMOOTH;
  tiltGravity.y += (rawGravity.y - tiltGravity.y) * GRAVITY_SMOOTH;
}

// ---------------- TOUCH / HOLES ----------------
function updateHoles() {
  holes = [];
  if (touches && touches.length > 0) {
    for (let i = 0; i < touches.length && holes.length < MAX_HOLES; i++) {
      const t = touches[i];
      holes.push({ x: t.x, y: t.y, r: HOLE_RADIUS });
    }
  } else if (mouseIsPressed) {
    holes.push({ x: mouseX, y: mouseY, r: HOLE_RADIUS });
  }
}

function touchStarted() { return false; }
function touchMoved()   { return false; }

// ---------------- PHYSICS ----------------
function stepPhysics(dt) {
  const gx = tiltGravity.x * GRAVITY_SCALE;
  const gy = tiltGravity.y * GRAVITY_SCALE;

  for (const b of blobs) {
    b.vx += gx * dt;
    b.vy += gy * dt;

    // Hole repulsion pushes blob centers outward from each touch.
    for (const h of holes) {
      const dx = b.x - h.x;
      const dy = b.y - h.y;
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.001;
      if (dist < HOLE_PUSH_REACH) {
        const falloff = 1.0 - dist / HOLE_PUSH_REACH;
        const f = HOLE_PUSH * falloff * falloff;
        b.vx += (dx / dist) * f;
        b.vy += (dy / dist) * f;
      }
    }

    b.vx *= Math.pow(DAMPING, dt);
    b.vy *= Math.pow(DAMPING, dt);

    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // Soft walls
    const pad = b.r * 0.35;
    if (b.x < pad)            { b.x = pad;            b.vx = Math.abs(b.vx) * WALL_BOUNCE; }
    if (b.x > width - pad)    { b.x = width - pad;    b.vx = -Math.abs(b.vx) * WALL_BOUNCE; }
    if (b.y < pad)            { b.y = pad;            b.vy = Math.abs(b.vy) * WALL_BOUNCE; }
    if (b.y > height - pad)   { b.y = height - pad;   b.vy = -Math.abs(b.vy) * WALL_BOUNCE; }
  }
}

function mergeBlobs() {
  for (let i = 0; i < blobs.length; i++) {
    for (let j = i + 1; j < blobs.length; j++) {
      const a = blobs[i];
      const b = blobs[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d  = Math.sqrt(dx * dx + dy * dy);
      const minR = Math.min(a.r, b.r);
      if (d < (a.r + b.r) - minR * MERGE_OVERLAP) {
        const areaA = a.r * a.r;
        const areaB = b.r * b.r;
        const newR  = Math.sqrt(areaA + areaB);
        if (newR > MAX_R) continue; // skip merge that would exceed cap

        const totalA = areaA + areaB;
        const nx = (a.x * areaA + b.x * areaB) / totalA;
        const ny = (a.y * areaA + b.y * areaB) / totalA;
        const nvx = (a.vx * areaA + b.vx * areaB) / totalA;
        const nvy = (a.vy * areaA + b.vy * areaB) / totalA;

        const nc = [
          (a.color[0] * areaA + b.color[0] * areaB) / totalA,
          (a.color[1] * areaA + b.color[1] * areaB) / totalA,
          (a.color[2] * areaA + b.color[2] * areaB) / totalA,
        ];

        a.x = nx; a.y = ny;
        a.vx = nvx; a.vy = nvy;
        a.r = newR;
        a.color = nc;

        blobs.splice(j, 1);
        j--;
      }
    }
  }
}

// ---------------- RENDER ----------------
function renderBlobs() {
  const count = Math.min(blobs.length, MAX_BLOBS);

  const blobBuf  = new Array(MAX_BLOBS * 4).fill(0);
  const colorBuf = new Array(MAX_BLOBS * 3).fill(0);
  for (let i = 0; i < count; i++) {
    const b = blobs[i];
    blobBuf[i * 4 + 0] = b.x;
    blobBuf[i * 4 + 1] = b.y;
    blobBuf[i * 4 + 2] = b.r;
    blobBuf[i * 4 + 3] = 0;
    colorBuf[i * 3 + 0] = b.color[0];
    colorBuf[i * 3 + 1] = b.color[1];
    colorBuf[i * 3 + 2] = b.color[2];
  }

  const holeCount = Math.min(holes.length, MAX_HOLES);
  const holeBuf = new Array(MAX_HOLES * 3).fill(0);
  for (let i = 0; i < holeCount; i++) {
    holeBuf[i * 3 + 0] = holes[i].x;
    holeBuf[i * 3 + 1] = holes[i].y;
    holeBuf[i * 3 + 2] = holes[i].r;
  }

  shader(metaShader);
  metaShader.setUniform('uResolution',   [width, height]);
  metaShader.setUniform('uBlobCount',    count);
  metaShader.setUniform('uBlobs',        blobBuf);
  metaShader.setUniform('uColors',       colorBuf);
  metaShader.setUniform('uHoleCount',    holeCount);
  metaShader.setUniform('uHoles',        holeBuf);
  metaShader.setUniform('uHoleStrength', HOLE_STRENGTH);
  metaShader.setUniform('uTime',         (millis() - startTime) / 1000);

  rect(0, 0, width, height);
}
