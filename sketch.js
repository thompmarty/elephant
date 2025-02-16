/***************************************************************
 * Two-State Orbit + Push-Out (No Text Labels)
 * 
 * In State 1: All 6 orbit in ascending order [1,2,3,4,5,6].
 * Clicking one -> it becomes center, ring goes to 5 circles.
 *
 * In State 2: A "center circle" + 5 orbiting circles.
 * - Clicking the center circle -> it re-inserts itself back into 
 *   the ring in sorted order, returning to State 1.
 * - Clicking a ring circle -> that circle becomes center, pushing
 *   the old center onto the ring "opposite" the new center.
 *
 * Over time the ring can get out of ascending order, but 
 * whenever you re-click the center circle, the ring is re-sorted.
 ***************************************************************/

// ---------------- CONFIG ----------------
const CIRCLE_IDS    = [1, 2, 3, 4, 5, 6];       // fixed IDs, used internally
const COLORS        = ["#00BFA6", "#7C4DFF", "#FF5252", "#FFC400", "#448AFF", "#FF4081"];
const DARK_BG       = "#2C2C2C";                // dark-gray background

// Sizes for state 1 (no center)
const NORMAL_RADIUS = 180;   // ring distance
const NORMAL_SIZE   = 120;   // diameter of circles

// Sizes for state 2 (one center)
const ORBIT_RADIUS  = 260;   // ring distance when 5 remain
const CENTER_SIZE   = 260;   // center circle diameter
const RING_SIZE     = 90;    // orbiting circle diameter

// Animation speeds
const ORBIT_SPEED   = 0.002; // how fast the ring rotates
const EASING_SPEED  = 0.1;   // how quickly circles move/resize to targets

// ---------------- GLOBALS ----------------
let circleData       = [];   // info about each circle: {id, color, curX, curY, ...}
let ringArrangement  = [];   // which circle IDs are on the ring (in some order)
let centerCircleId   = -1;   // which circle ID is in center? -1 => none
let globalAngle      = 0;    // ring's rotation angle

function setup() {
  createCanvas(windowWidth, windowHeight);
  noStroke();

  // Remove default browser margins
  const c = canvas;
  c.style.display  = "block";
  c.style.margin   = "0";
  c.style.padding  = "0";
  c.style.position = "absolute";
  c.style.top      = "0";
  c.style.left     = "0";

  // Create circle objects for IDs 1..6
  for (let i = 0; i < CIRCLE_IDS.length; i++) {
    circleData.push({
      id:    CIRCLE_IDS[i],
      color: color(COLORS[i]),
      // We’ll animate curX/Y/Size toward targetX/Y/Size
      curX:      0,
      curY:      0,
      curSize:   NORMAL_SIZE,
      targetX:   0,
      targetY:   0,
      targetSize: NORMAL_SIZE
    });
  }

  // Start in State 1: ringArrangement has all IDs in ascending order
  ringArrangement = [...CIRCLE_IDS]; // copy array

  // Position them so they don’t appear from a corner
  placeRing(ringArrangement, NORMAL_RADIUS, NORMAL_SIZE);
  for (let c of circleData) {
    c.curX    = c.targetX;
    c.curY    = c.targetY;
    c.curSize = c.targetSize;
  }
}

function draw() {
  background(DARK_BG);

  // Rotate the ring gently
  globalAngle += ORBIT_SPEED;

  if (centerCircleId === -1) {
    // ---------- STATE 1: No Center ----------
    placeRing(ringArrangement, NORMAL_RADIUS, NORMAL_SIZE);
  } else {
    // ---------- STATE 2: One Circle in Center ----------
    // The ringArrangement has the 5 orbiting circles
    placeRing(ringArrangement, ORBIT_RADIUS, RING_SIZE);

    // The center circle is enlarged and placed in the middle
    let c = getCircleData(centerCircleId);
    c.targetX    = width / 2;
    c.targetY    = height / 2;
    c.targetSize = CENTER_SIZE;
  }

  // Smoothly animate circles to their targets
  for (let c of circleData) {
    c.curX    += (c.targetX    - c.curX)    * EASING_SPEED;
    c.curY    += (c.targetY    - c.curY)    * EASING_SPEED;
    c.curSize += (c.targetSize - c.curSize) * EASING_SPEED;

    fill(c.color);
    ellipse(c.curX, c.curY, c.curSize, c.curSize);
  }
}

// Arrange the array of circle IDs around the ring at a given radius
function placeRing(ids, radius, size) {
  let count = ids.length;
  if (count === 0) return;
  let step = TWO_PI / count;
  for (let i = 0; i < count; i++) {
    let id = ids[i];
    let obj  = getCircleData(id);
    let angle = globalAngle + step * i;
    let x = width / 2 + cos(angle) * radius;
    let y = height / 2 + sin(angle) * radius;

    obj.targetX    = x;
    obj.targetY    = y;
    obj.targetSize = size;
  }
}

function mousePressed() {
  let clickedId = findCircleUnderMouse();
  
  // Clicked empty space => if we had a center, revert to normal
  if (clickedId === -1) {
    if (centerCircleId !== -1) {
      insertIdSorted(centerCircleId, ringArrangement);
      centerCircleId = -1;
    }
    return;
  }

  // If user clicked the circle already in center => revert to normal
  if (clickedId === centerCircleId) {
    insertIdSorted(centerCircleId, ringArrangement);
    centerCircleId = -1;
    return;
  }

  // Otherwise, the user clicked a ring circle => newCenter
  let newCenterId = clickedId;
  let oldCenterId = centerCircleId;

  if (oldCenterId === -1) {
    // If we’re in State 1, just remove newCenter from ring and put it center
    removeId(newCenterId, ringArrangement);
    centerCircleId = newCenterId;
    return;
  }

  // If we're in State 2: push oldCenter to "opposite" newCenter's position
  let pos = ringArrangement.indexOf(newCenterId);
  if (pos === -1) return; // should never happen unless something’s off

  let len = ringArrangement.length; // typically 5
  let opposite = (pos + Math.floor(len/2)) % len;

  // Insert the old center at 'opposite'
  ringArrangement.splice(opposite, 0, oldCenterId);
  // Remove newCenter from ring
  removeId(newCenterId, ringArrangement);
  // newCenter is now the center
  centerCircleId = newCenterId;
}

// Helper: remove a given ID from an array (if present)
function removeId(id, arr) {
  let i = arr.indexOf(id);
  if (i !== -1) arr.splice(i, 1);
}

// Helper: insert a given ID into an array so that it remains sorted
function insertIdSorted(id, arr) {
  arr.push(id);
  arr.sort((a,b) => a - b);
}

// Return the circle object for a given ID
function getCircleData(id) {
  return circleData.find(obj => obj.id === id);
}

// Check which circle (if any) is under the mouse
function findCircleUnderMouse() {
  for (let i = 0; i < circleData.length; i++) {
    let c = circleData[i];
    let d = dist(mouseX, mouseY, c.curX, c.curY);
    if (d < c.curSize / 2) {
      return c.id; 
    }
  }
  return -1;
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
