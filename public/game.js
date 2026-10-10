import * as THREE from 'three';
import { UPGRADES, upgradeCost, computeStats } from './upgrades.js';
import { SHIPS, DEFAULT_SHIP, shipById, describeMods } from './ships.js';

// ---------- Utilities ----------

const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const UNITS = ['K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx'];

function fmt(n) {
  n = Math.floor(n);
  if (Math.abs(n) < 1000) return String(n);
  let i = -1;
  while (Math.abs(n) >= 1000 && i < UNITS.length - 1) { n /= 1000; i++; }
  return (n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : n.toFixed(0)) + UNITS[i];
}
const fmtDmg = (n) => (n < 10 ? n.toFixed(1) : fmt(n));

function ago(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

// ---------- API ----------

const api = {
  async status(since) {
    const r = await fetch(`/api/status?since=${since}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  },
  async buy(id) {
    const r = await fetch('/api/buy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  },
  async ship(id, action) {
    const r = await fetch('/api/ship', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  },
  progress(p) {
    return fetch('/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).catch(() => {});
  },
};

// ---------- Audio (very simple) ----------

let audio = null;
let muted = false;
function beep(freq, dur = 0.08, type = 'square', vol = 0.04, slide = 0) {
  if (!audio || muted) return;
  const t = audio.currentTime;
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(audio.destination);
  o.start(t);
  o.stop(t + dur);
}
// Per-ship firing sound, throttled so a high fire rate doesn't get overwhelming.
let lastShotSound = 0;
let lastDroneSound = 0;
function shotSound(snd) {
  if (!audio || muted || audio.currentTime - lastShotSound < 0.07) return;
  lastShotSound = audio.currentTime;
  beep(snd.freq * rand(0.94, 1.06), snd.dur, snd.type, snd.vol, snd.slide);
}
function droneSound() {
  if (!audio || muted || audio.currentTime - lastDroneSound < 0.12) return;
  lastDroneSound = audio.currentTime;
  beep(1900 * rand(0.95, 1.05), 0.03, 'triangle', 0.008, -700);
}

function unlockAudio() {
  if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
  if (audio.state === 'suspended') audio.resume();
}

// ---------- Scene ----------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
$('stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070a14);
scene.fog = new THREE.Fog(0x070a14, 60, 130);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
const CAM_DIR = new THREE.Vector3(0, 0.88, 0.48).normalize();
const camBase = new THREE.Vector3();

function fitCamera() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  let d = 21 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  if (camera.aspect < 1.2) d *= 1.2 / camera.aspect;
  camBase.copy(CAM_DIR).multiplyScalar(d);
  // Shift the scene center to the left so it isn't hidden under the shop.
  const shopW = w > 900 ? 330 : 0;
  if (shopW) camera.setViewOffset(w, h, shopW / 2, 0, w, h);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
addEventListener('resize', fitCamera);
fitCamera();

scene.add(new THREE.HemisphereLight(0x8fa2ff, 0x2a1438, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(14, 30, 8);
scene.add(sun);

const flat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.75, metalness: 0.1, ...opts });

// Jitter each vertex randomly but consistently: faces stay closed and it gets a low-poly look.
function lowPoly(geo, amount) {
  const p = geo.attributes.position;
  const offsets = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let o = offsets.get(key);
    if (!o) { o = [rand(-amount, amount), rand(-amount, amount), rand(-amount, amount)]; offsets.set(key, o); }
    p.setXYZ(i, p.getX(i) + o[0], p.getY(i) + o[1], p.getZ(i) + o[2]);
  }
  geo.computeVertexNormals();
  return geo;
}

// Low-poly terrain under the battlefield.
{
  let g = new THREE.PlaneGeometry(160, 160, 48, 48);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const d = Math.hypot(x, z);
    p.setXYZ(i, x + rand(-0.9, 0.9), rand(-0.8, 0.8) + (d > 32 ? (d - 32) * rand(0.1, 0.35) : 0), z + rand(-0.9, 0.9));
  }
  g = g.toNonIndexed();
  g.computeVertexNormals();
  const palette = [0x121733, 0x161c3b, 0x1b1640, 0x10182c, 0x1f1a44, 0x141e38].map((c) => new THREE.Color(c));
  const colors = new Float32Array(g.attributes.position.count * 3);
  for (let f = 0; f < colors.length / 9; f++) {
    const c = palette[(Math.random() * palette.length) | 0];
    for (let v = 0; v < 3; v++) colors.set([c.r, c.g, c.b], f * 9 + v * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const terrain = new THREE.Mesh(g, flat(0xffffff, { vertexColors: true, roughness: 1 }));
  terrain.position.y = -4;
  scene.add(terrain);
}

// Decorative asteroid belt.
const asteroids = new THREE.Group();
scene.add(asteroids);
for (let i = 0; i < 46; i++) {
  const a = rand(0, TAU), r = rand(29, 48);
  const m = new THREE.Mesh(
    lowPoly(new THREE.IcosahedronGeometry(rand(0.5, 2.6), 0), 0.35),
    flat(new THREE.Color().setHSL(rand(0.62, 0.78), 0.25, rand(0.18, 0.32))),
  );
  m.position.set(Math.cos(a) * r, rand(-3, 2), Math.sin(a) * r);
  m.rotation.set(rand(0, TAU), rand(0, TAU), 0);
  m.userData.spin = rand(-0.4, 0.4);
  asteroids.add(m);
}

// Stars.
{
  const n = 1400, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection();
    v.y = Math.abs(v.y) * 0.6 + 0.05;
    v.normalize().multiplyScalar(rand(150, 220));
    pos.set([v.x, v.y, v.z], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xc7d2fe, size: 0.9, fog: false })));
}

// ---------- Core ----------

const SHIP_R = 5.5;
const CORE_HIT_R = 2.7;
const FIELD_R = 32;

const core = new THREE.Group();
core.position.y = 0.6;
scene.add(core);
const coreMat = flat(0xd97757, { emissive: 0xd97757, emissiveIntensity: 0.4 });
const coreMesh = new THREE.Mesh(lowPoly(new THREE.IcosahedronGeometry(1.7, 1), 0.16), coreMat);
core.add(coreMesh);
const coreCage = new THREE.Mesh(new THREE.IcosahedronGeometry(2.4, 0), new THREE.MeshBasicMaterial({ color: 0xffb38a, wireframe: true, transparent: true, opacity: 0.35 }));
core.add(coreCage);
core.add(new THREE.PointLight(0xff8a5c, 60, 26, 1.5));

const coreRingMat = new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.6, side: THREE.DoubleSide });
const coreRing = new THREE.Mesh(new THREE.RingGeometry(2.85, 3.05, 64).rotateX(-Math.PI / 2), coreRingMat);
coreRing.position.y = 0.05;
scene.add(coreRing);

const orbitRing = new THREE.Mesh(
  new THREE.RingGeometry(SHIP_R - 0.05, SHIP_R + 0.05, 128).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x5eead4, transparent: true, opacity: 0.18, side: THREE.DoubleSide }),
);
orbitRing.position.y = 0.05;
scene.add(orbitRing);

// ---------- Ships ----------
// Each model points its nose at +Z and fills a thruster group, which is animated separately.

function mesh(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}

// Flat outline (x = sideways, y = toward the nose) extruded and laid onto the XZ plane.
function plate(points, depth = 0.08) {
  const shape = new THREE.Shape();
  points.forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false }).rotateX(Math.PI / 2).translate(0, depth / 2, 0);
}

function flame(x, radius, length, color = 0x7dd3fc) {
  return mesh(
    new THREE.ConeGeometry(radius, length, 6).rotateX(-Math.PI / 2).translate(0, 0, -length / 2),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }),
    x,
  );
}

const SHIP_MODELS = {
  // Arrowhead fighter with delta wings and two engines.
  arrow(g, thr) {
    const hull = flat(0xe2e8f0, { roughness: 0.55 });
    const glass = flat(0x0e7490, { emissive: 0x22d3ee, emissiveIntensity: 0.6, roughness: 0.2, metalness: 0.4 });
    const light = new THREE.MeshBasicMaterial({ color: 0xd97757 });
    g.add(
      mesh(new THREE.CylinderGeometry(0.04, 0.34, 2.3, 6).rotateX(Math.PI / 2).scale(1, 0.6, 1), hull, 0, 0, 0.1),
      mesh(new THREE.OctahedronGeometry(0.22, 0).scale(0.85, 0.7, 1.9), glass, 0, 0.17, 0.25),
      mesh(plate([[0, 0.55], [1.45, -0.55], [1.32, -0.85], [0.42, -0.7], [-0.42, -0.7], [-1.32, -0.85], [-1.45, -0.55]]).translate(0, 0, -0.15),
        flat(0x2dd4bf, { emissive: 0x0f766e, emissiveIntensity: 0.35 })),
    );
    for (const side of [-1, 1]) {
      const fin = mesh(new THREE.BoxGeometry(0.05, 0.42, 0.45), hull, 0.45 * side, 0.24, -0.72);
      fin.rotation.z = -0.35 * side;
      g.add(
        mesh(new THREE.CylinderGeometry(0.11, 0.16, 0.85, 6).rotateX(Math.PI / 2), flat(0x475569), 0.45 * side, 0.02, -0.55),
        fin,
        mesh(new THREE.BoxGeometry(0.1, 0.1, 0.3), light, 1.36 * side, 0.04, -0.82),
      );
      thr.add(flame(0.45 * side, 0.13, 0.7));
    }
    thr.position.set(0, 0.02, -0.97);
  },

  // Light yellow-and-black interceptor with forward-swept wings.
  hornet(g, thr) {
    const yellow = flat(0xfacc15, { emissive: 0xa16207, emissiveIntensity: 0.3 });
    const black = flat(0x4b5563, { emissive: 0x111827, emissiveIntensity: 0.4 });
    g.add(
      mesh(new THREE.CylinderGeometry(0.03, 0.26, 2.2, 4).rotateX(Math.PI / 2).rotateZ(Math.PI / 4).scale(1, 0.7, 1), yellow, 0, 0, 0.15),
      mesh(new THREE.OctahedronGeometry(0.17, 0).scale(0.9, 0.8, 2), flat(0x7f1d1d, { emissive: 0xef4444, emissiveIntensity: 0.7 }), 0, 0.14, 0.3),
      mesh(plate([[0, -0.15], [1.15, 0.4], [1.25, 0.2], [0.35, -0.6], [-0.35, -0.6], [-1.25, 0.2], [-1.15, 0.4]], 0.06), black, 0, 0, -0.2),
      mesh(plate([[0, 0.1], [0.55, -0.35], [-0.55, -0.35]], 0.05), yellow, 0, 0.06, -0.55),
    );
    for (const side of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(0.06, 0.06, 0.7), yellow, 1.2 * side, 0.03, 0.35));
    const stinger = mesh(new THREE.BoxGeometry(0.06, 0.38, 0.4), black, 0, 0.22, -0.75);
    stinger.rotation.x = -0.35;
    g.add(stinger);
    thr.add(flame(0, 0.16, 0.9, 0xfde68a));
    thr.position.set(0, 0, -0.92);
  },

  // Heavy, boxy armored gunship with two side cannons.
  bastion(g, thr) {
    const armor = flat(0x94a3b8, { roughness: 0.9 });
    const orange = flat(0xf97316, { emissive: 0x9a3412, emissiveIntensity: 0.35 });
    const dark = flat(0x334155);
    g.add(
      mesh(lowPoly(new THREE.BoxGeometry(0.95, 0.42, 1.8), 0.04), armor, 0, 0, -0.05),
      mesh(new THREE.CylinderGeometry(0.2, 0.45, 0.5, 4).rotateX(Math.PI / 2).rotateZ(Math.PI / 4).scale(1, 0.55, 1), orange, 0, 0, 1.0),
      mesh(new THREE.BoxGeometry(0.4, 0.16, 0.45), flat(0x0c4a6e, { emissive: 0x38bdf8, emissiveIntensity: 0.5 }), 0, 0.28, 0.2),
      mesh(plate([[0.45, 0.35], [1.35, -0.1], [1.35, -0.55], [0.45, -0.7]], 0.12), armor),
      mesh(plate([[-0.45, 0.35], [-1.35, -0.1], [-1.35, -0.55], [-0.45, -0.7]], 0.12), armor),
    );
    for (const side of [-1, 1]) {
      g.add(
        mesh(new THREE.BoxGeometry(0.22, 0.22, 1.3), dark, 0.72 * side, 0.15, 0.35),
        mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), orange, 0.72 * side, 0.15, -0.2),
        mesh(new THREE.BoxGeometry(0.3, 0.14, 0.5), orange, 1.3 * side, 0.02, -0.3),
      );
      thr.add(flame(0.3 * side, 0.2, 0.75, 0xfdba74));
    }
    thr.position.set(0, 0, -0.95);
  },

  // Wide, flat flying wing, like a manta ray.
  manta(g, thr) {
    const purple = flat(0x7c3aed, { emissive: 0x4c1d95, emissiveIntensity: 0.45 });
    const light = flat(0xddd6fe);
    g.add(
      mesh(plate([[0, 0.95], [0.6, 0.35], [1.7, -0.25], [1.6, -0.6], [0.55, -0.4], [0.25, -0.95], [-0.25, -0.95], [-0.55, -0.4], [-1.6, -0.6], [-1.7, -0.25], [-0.6, 0.35]], 0.12), purple),
      mesh(new THREE.OctahedronGeometry(0.4, 0).scale(0.7, 0.45, 2.1), light, 0, 0.1, 0.05),
      mesh(new THREE.OctahedronGeometry(0.15, 0).scale(1, 0.8, 1.6), flat(0x312e81, { emissive: 0xa78bfa, emissiveIntensity: 0.9 }), 0, 0.24, 0.35),
    );
    for (const side of [-1, 1]) {
      g.add(mesh(new THREE.ConeGeometry(0.09, 0.6, 4).rotateX(Math.PI / 2), light, 0.62 * side, 0.02, 0.55));
      thr.add(flame(0.5 * side, 0.1, 0.55, 0xe9d5ff));
    }
    thr.add(flame(0, 0.13, 0.75, 0xe9d5ff));
    thr.position.set(0, 0.02, -0.92);
  },

  // White-and-gold flagship with a ring and the Claude gem in the middle.
  opus(g, thr) {
    const white = flat(0xf8fafc, { roughness: 0.4, metalness: 0.2 });
    const gold = flat(0xfbbf24, { emissive: 0xb45309, emissiveIntensity: 0.45, metalness: 0.5, roughness: 0.4 });
    g.add(
      mesh(new THREE.OctahedronGeometry(0.5, 0).scale(0.75, 0.5, 2.2), white, 0, 0, 0.05),
      mesh(new THREE.TorusGeometry(0.95, 0.08, 4, 12).rotateX(Math.PI / 2), gold, 0, 0, -0.1),
      mesh(new THREE.IcosahedronGeometry(0.22, 0), new THREE.MeshBasicMaterial({ color: 0xd97757 }), 0, 0.3, -0.05),
      mesh(plate([[0, 0.2], [1.25, -0.45], [0.95, -0.75], [0, -0.55], [-0.95, -0.75], [-1.25, -0.45]], 0.06), white, 0, 0, -0.15),
    );
    for (const side of [-1, 1]) {
      g.add(mesh(new THREE.ConeGeometry(0.08, 0.9, 4).rotateX(Math.PI / 2), gold, 0.3 * side, 0, 0.95));
      g.add(mesh(new THREE.OctahedronGeometry(0.14, 0), gold, 0.95 * side, 0, -0.1));
    }
    thr.add(flame(0, 0.2, 0.9, 0xfef3c7));
    thr.position.set(0, 0, -1.05);
  },
};

function buildShip(id) {
  const model = new THREE.Group();
  const thr = new THREE.Group();
  (SHIP_MODELS[id] || SHIP_MODELS.arrow)(model, thr);
  model.add(thr);
  model.scale.setScalar(1.15);
  return { model, thruster: thr };
}

const ship = new THREE.Group();
ship.position.y = 0.6;
scene.add(ship);
let shipModel = null;
let thruster = null;
let shipSound = shipById(DEFAULT_SHIP).sound;

function disposeModel(model) {
  model.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose();
  });
}

function setShip(id) {
  if (shipModel) {
    ship.remove(shipModel);
    disposeModel(shipModel);
  }
  ({ model: shipModel, thruster } = buildShip(id));
  ship.add(shipModel);
  const def = shipById(id);
  C.bullet.set(def.bullet);
  shipSound = def.sound;
}

const droneGeo = lowPoly(new THREE.OctahedronGeometry(0.36, 0), 0.05);
const droneMat = flat(0xa78bfa, { emissive: 0x7c3aed, emissiveIntensity: 0.6 });
const drones = [];

// ---------- Instanced pools (bullets and particles) ----------

const dummy = new THREE.Object3D();
const WHITE = new THREE.Color(1, 1, 1);

function makePool(geo, max, opts = {}) {
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, ...opts }), max);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, WHITE);
  mesh.count = 0;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { mesh, items: [], max };
}
function poolAdd(pool, item) {
  if (pool.items.length < pool.max) pool.items.push(item);
}
function poolSync(pool, place) {
  const { mesh, items } = pool;
  for (let i = 0; i < items.length; i++) {
    place(items[i], dummy);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, items[i].color);
  }
  mesh.count = items.length;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
}

const bullets = makePool(new THREE.OctahedronGeometry(0.17, 0).scale(1, 1, 3.4), 500);
const enemyBullets = makePool(new THREE.IcosahedronGeometry(0.3, 0), 300);
const particles = makePool(new THREE.TetrahedronGeometry(0.26, 0), 1200, { transparent: true });

const C = {
  bullet: new THREE.Color(0x67e8f9),
  crit: new THREE.Color(0xfde047),
  drone: new THREE.Color(0xc4b5fd),
  enemyBullet: new THREE.Color(0xff5470),
  spark: new THREE.Color(0xffffff),
  gold: new THREE.Color(0xfbbf24),
  core: new THREE.Color(0xd97757),
};

setShip(DEFAULT_SHIP);

function burst(x, y, z, color, count, speed = 6, size = 1) {
  for (let i = 0; i < count; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(rand(0.3, 1) * speed);
    v.y = Math.abs(v.y) * 0.8;
    const life = rand(0.35, 0.9);
    poolAdd(particles, { x, y, z, vx: v.x, vy: v.y, vz: v.z, life, max: life, s: rand(0.6, 1.4) * size, rot: rand(0, TAU), color, g: 9 });
  }
}

// ---------- Enemies ----------

const ENEMY_TYPES = {
  cube:  { geo: lowPoly(new THREE.BoxGeometry(1.25, 1.25, 1.25), 0.12), hp: 1,   r: 0.85, dmg: 8,  color: 0x8b5cf6, spin: 1.2, drift: 0 },
  tetra: { geo: lowPoly(new THREE.TetrahedronGeometry(1, 0), 0.1),      hp: 0.6, r: 0.8,  dmg: 6,  color: 0x34d399, spin: 2.6, drift: 0.6 },
  octa:  { geo: lowPoly(new THREE.OctahedronGeometry(1, 0), 0.1),       hp: 2.4, r: 0.9,  dmg: 14, color: 0xf43f5e, spin: 0.8, drift: 0, shoots: [2.6, 5.5] },
  split: { geo: lowPoly(new THREE.IcosahedronGeometry(1.05, 0), 0.12),  hp: 1.8, r: 0.95, dmg: 10, color: 0x38bdf8, spin: 1.0, drift: 0.2 },
  boss:  { geo: lowPoly(new THREE.DodecahedronGeometry(2.2, 0), 0.25),  hp: 45,  r: 2.3,  dmg: 60, color: 0xfbbf24, spin: 0.4, drift: 0, shoots: [1.6, 2.6] },
};
for (const T of Object.values(ENEMY_TYPES)) T.particleColor = new THREE.Color(T.color);

const barGeo = new THREE.PlaneGeometry(1, 0.16);
const barBgMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6, depthTest: false });
const barFgMat = new THREE.MeshBasicMaterial({ color: 0xf43f5e, depthTest: false });

function makeBar(width) {
  const g = new THREE.Group();
  const bg = new THREE.Mesh(barGeo, barBgMat);
  const fg = new THREE.Mesh(barGeo, barFgMat);
  bg.scale.x = width;
  bg.renderOrder = 10;
  fg.renderOrder = 11;
  g.add(bg, fg);
  g.userData = { fg, w: width };
  g.visible = false;
  scene.add(g);
  return g;
}

let enemies = [];

// Elites have triple health, deal double damage to the core and glow brighter.
function spawnEnemy(type, ring, angle, r, hpBase, { elite = false, enter = true } = {}) {
  const T = ENEMY_TYPES[type];
  const mat = flat(T.color, { emissive: T.color, emissiveIntensity: 0.18 });
  const mesh = new THREE.Mesh(T.geo, mat);
  mesh.rotation.set(rand(0, TAU), rand(0, TAU), 0);
  if (elite) mesh.scale.setScalar(1.3);
  scene.add(mesh);
  const hp = hpBase * T.hp * (elite ? 3 : 1);
  const e = {
    type, T, mesh, mat, ring, angle, elite, hpBase,
    r: enter ? r + 10 : r, targetR: r, hp, maxHp: hp, flash: 0,
    dmgMul: elite ? 2 : 1, glow: elite ? 0.7 : 0.18,
    fireT: T.shoots ? rand(...T.shoots) + 2 : 0,
    bar: makeBar(type === 'boss' ? 3.4 : elite ? 1.7 : 1.3),
    bob: rand(0, TAU), x: 0, z: 0, alive: true,
  };
  enemies.push(e);
  return e;
}

function removeEnemy(e) {
  e.alive = false;
  scene.remove(e.mesh, e.bar);
  e.mat.dispose();
}

// ---------- Game state ----------

const state = { wallet: 0, shownWallet: 0, earnedTotal: 0, levels: {}, ship: DEFAULT_SHIP, ships: [DEFAULT_SHIP], generating: false, processes: 0, rate: 0, sessions: [], seq: 0, online: false, loaded: false };
let stats = computeStats({}, false);

const game = {
  wave: 1, best: 1, kills: 0,
  phase: 'loading', phaseT: 0,
  coreHp: 100, stepT: 3, rings: [],
  shipAngle: -Math.PI / 2, aimAngle: -Math.PI / 2, mouseAim: false,
  fireT: 0, paused: false, shake: 0, corePulse: 0, waveTotal: 0,
  nextWave: 1, levelKills: 0, levelWallet: 0,
};

// Each level is 5 waves; the last one is the boss.
const WAVES_PER_LEVEL = 5;
const levelOf = (w) => Math.ceil(w / WAVES_PER_LEVEL);
const waveInLevel = (w) => ((w - 1) % WAVES_PER_LEVEL) + 1;
const firstWaveOf = (level) => (level - 1) * WAVES_PER_LEVEL + 1;

function stepInterval() {
  return Math.max(1.3, 3.0 - game.wave * 0.06);
}

// Multiplier for the damage enemies deal to the core; grows with each level.
const enemyDmgScale = () => 1 + 0.15 * (levelOf(game.wave) - 1);
// Shooting enemies fire more often in later waves.
const fireRateScale = () => Math.max(0.65, 1 - game.wave * 0.015);

function spawnWave(w) {
  const boss = w % 5 === 0;
  const n = Math.min(16 + 3 * w, 64) - (boss ? 8 : 0);
  const ringCount = Math.min(2 + Math.floor(w / 3), 5);
  const perRing = Math.ceil(n / ringCount);
  const hpBase = 12 * Math.pow(1.28, w - 1);
  const pTetra = w >= 2 ? Math.min(0.15 + w * 0.01, 0.3) : 0;
  const pOcta = w >= 3 ? Math.min(0.08 + w * 0.012, 0.3) : 0;
  const pSplit = w >= 6 ? Math.min(0.1 + (w - 6) * 0.01, 0.25) : 0;
  const pElite = w >= 4 ? Math.min(0.04 + w * 0.005, 0.15) : 0;

  game.rings = [];
  let spawned = 0;
  for (let k = 0; k < ringCount; k++) {
    const speed = 0.16 + 0.04 * k + Math.min(w, 25) * 0.006;
    game.rings.push({ omega: speed * (k % 2 ? -1 : 1) });
    const count = Math.min(perRing, n - spawned);
    for (let j = 0; j < count; j++) {
      const roll = Math.random();
      const type = roll < pOcta ? 'octa' : roll < pOcta + pTetra ? 'tetra' : roll < pOcta + pTetra + pSplit ? 'split' : 'cube';
      spawnEnemy(type, k, (j / count) * TAU + k * 0.37, 15 + k * 1.9, hpBase, { elite: Math.random() < pElite });
    }
    spawned += count;
  }
  if (boss) {
    game.rings.push({ omega: 0.12 });
    spawnEnemy('boss', game.rings.length - 1, rand(0, TAU), 15 + ringCount * 1.9 + 1.2, hpBase);
  }
  game.waveTotal = enemies.length;
}

function clearField() {
  for (const e of enemies) removeEnemy(e);
  enemies = [];
  bullets.items.length = 0;
  enemyBullets.items.length = 0;
}

function startWave(w) {
  clearField();
  game.wave = w;
  game.best = Math.max(game.best, w);
  game.coreHp = stats.coreMax;
  game.stepT = stepInterval() + 2;
  game.fireT = 0;
  spawnWave(w);
  game.phase = 'play';
  const boss = waveInLevel(w) === WAVES_PER_LEVEL;
  banner(`LEVEL ${levelOf(w)} · WAVE ${waveInLevel(w)}/${WAVES_PER_LEVEL}`, boss ? 'A boss is approaching' : `${game.waveTotal} enemies in orbit`, 1.8);
  beep(330, 0.25, 'triangle', 0.05, 330);
  renderStats();
  saveProgress();
}

const DEBUG = new URLSearchParams(location.search).has('debug');

function saveProgress() {
  if (DEBUG) return;
  // During the pause between levels, save the wave the game will resume from.
  const wave = game.phase === 'intermission' ? game.nextWave : game.wave;
  if (state.online) api.progress({ wave, bestWave: game.best, kills: game.kills });
}

// ---------- Pause between levels ----------

function showIntermission(kind) {
  clearField();
  game.phase = 'intermission';
  game.coreHp = stats.coreMax;
  $('banner').classList.remove('show');
  bannerTimer = 0;

  const level = levelOf(game.nextWave);
  const title = {
    start: `LEVEL ${level}`,
    complete: `LEVEL ${levelOf(game.wave)} COMPLETE`,
    dead: 'CORE DESTROYED',
  }[kind];
  const sub = {
    start: waveInLevel(game.nextWave) > 1
      ? `Resuming at wave ${waveInLevel(game.nextWave)}/${WAVES_PER_LEVEL}`
      : `${WAVES_PER_LEVEL} waves · the last one is a boss`,
    complete: `Upgrade your gear before level ${level}`,
    dead: `Upgrade your gear and retry wave ${waveInLevel(game.nextWave)}/${WAVES_PER_LEVEL} of level ${level}`,
  }[kind];
  $('inter-title').textContent = title;
  $('inter-sub').textContent = sub;
  $('inter-go').textContent = kind === 'dead' ? 'Retry ▸' : kind === 'complete' ? `Start level ${level} ▸` : 'Start ▸';
  $('inter-summary').innerHTML = kind === 'complete'
    ? `<span>Kills this level <b>${fmt(game.kills - game.levelKills)}</b></span><span>Tokens earned <b>+${fmt(Math.max(0, state.earnedTotal - game.levelWallet))} TK</b></span>`
    : '';
  $('intermission').classList.add('show');
  updateIntermission();
  renderStats();
  saveProgress();
}

function updateIntermission() {
  if (game.phase !== 'intermission') return;
  const affordable = UPGRADES.filter((u) => {
    const lvl = state.levels[u.id] || 0;
    return !(u.max != null && lvl >= u.max) && state.wallet >= upgradeCost(u, lvl);
  }).length;
  $('inter-hint').textContent = affordable
    ? `You can afford ${affordable} upgrade${affordable > 1 ? 's' : ''} in the shop →`
    : state.generating
      ? 'Claude is generating tokens… wait a bit or carry on'
      : "You can't afford any upgrade: put Claude to work and come back";
}

function continueFromIntermission() {
  if (game.phase !== 'intermission') return;
  $('intermission').classList.remove('show');
  if (waveInLevel(game.nextWave) === 1 || levelOf(game.nextWave) !== levelOf(game.wave)) {
    game.levelKills = game.kills;
    game.levelWallet = state.earnedTotal;
  }
  startWave(game.nextWave);
}
$('inter-go').addEventListener('click', () => { unlockAudio(); continueFromIntermission(); });

const coreDamageLog = { contact: 0, bullet: 0 };
function coreHit(dmg, source) {
  if (game.phase !== 'play') return;
  coreDamageLog[source] += dmg;
  game.coreHp -= dmg;
  game.shake = Math.max(game.shake, 0.45);
  $('vignette').classList.add('on');
  setTimeout(() => $('vignette').classList.remove('on'), 60);
  beep(90, 0.2, 'sawtooth', 0.06, -40);
  if (game.coreHp <= 0) {
    game.coreHp = 0;
    game.phase = 'dead';
    game.phaseT = 2;
    burst(0, 0.6, 0, C.core, 140, 14, 1.8);
    for (const e of enemies) burst(e.x, 0.6, e.z, e.T.particleColor, 8);
    clearField();
    game.shake = 1.2;
    banner('CORE DESTROYED', '', 2);
    beep(60, 0.9, 'sawtooth', 0.08, -30);
  }
}

// ---------- Combat ----------

// The enemy closest to the ship among those that crossed its orbit (between the ship and the core).
function innerTarget() {
  let best = null, bd = Infinity;
  for (const e of enemies) {
    if (!e.alive || e.r > SHIP_R + 0.4) continue;
    const d = (e.x - ship.position.x) ** 2 + (e.z - ship.position.z) ** 2;
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

function shoot() {
  const n = stats.shots;
  const spread = stats.spread;
  let sx = Math.cos(game.shipAngle) * (SHIP_R + 0.9);
  let sz = Math.sin(game.shipAngle) * (SHIP_R + 0.9);
  let aim = game.shipAngle;
  // Normal shots go outward; if something is already inside the orbit, the ship fires inward at it.
  const inner = innerTarget();
  if (inner) {
    sx = ship.position.x;
    sz = ship.position.z;
    aim = Math.atan2(inner.z - sz, inner.x - sx);
  }
  for (let i = 0; i < n; i++) {
    const a = aim + (i - (n - 1) / 2) * spread;
    const crit = Math.random() < stats.critChance;
    poolAdd(bullets, {
      x: sx, z: sz, dx: Math.cos(a), dz: Math.sin(a), speed: 34, life: 1.2,
      dmg: stats.dmg * (crit ? stats.critMult : 1), crit, pierce: stats.pierce, hit: new Set(), chain: true,
      color: crit ? C.crit : C.bullet,
    });
  }
  shotSound(shipSound);
}

function nearestEnemy(x, z, maxDist = 26, exclude) {
  let best = null, bd = maxDist * maxDist;
  for (const e of enemies) {
    if (!e.alive || (exclude && exclude.has(e))) continue;
    const d = (e.x - x) ** 2 + (e.z - z) ** 2;
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

function hitEnemy(e, dmg, crit, canChain) {
  if (!e.alive) return;
  e.hp -= dmg;
  e.flash = 0.07;
  dmgText(e.x, e.z, dmg, crit);
  burst(e.x, 0.6, e.z, C.spark, 2, 4, 0.6);
  if (canChain && Math.random() < stats.chainChance) chainArc(e, dmg * 0.6);
  if (e.hp <= 0) killEnemy(e);
  else if (e.type === 'boss' && !e.summoned && e.hp < e.maxHp / 2) summonEscorts(e);
}

// When it drops below half health, the boss calls an escort of cubes around it.
function summonEscorts(boss) {
  boss.summoned = true;
  const count = 4 + levelOf(game.wave);
  for (let i = 0; i < count; i++) {
    const e = spawnEnemy('cube', boss.ring, boss.angle + (i - (count - 1) / 2) * 0.16, boss.r + 1.6, boss.hpBase * 1.5, { enter: false });
    e.targetR = boss.targetR + 1.6;
  }
  game.waveTotal += count;
  burst(boss.x, 1, boss.z, ENEMY_TYPES.boss.particleColor, 40, 10, 1.2);
  banner('ESCORT!', 'The boss called for reinforcements', 1.2);
  beep(180, 0.4, 'sawtooth', 0.06, 200);
}

function killEnemy(e) {
  removeEnemy(e);
  game.kills++;
  // The blue icosahedron splits into two tetrahedrons when it dies.
  if (e.type === 'split') {
    for (const side of [-1, 1]) {
      const child = spawnEnemy('tetra', e.ring, e.angle + side * 0.12, e.r, e.hpBase * (e.elite ? 1.5 : 1), { enter: false });
      child.targetR = e.targetR;
    }
    game.waveTotal += 2;
  }
  const big = e.type === 'boss';
  burst(e.x, 0.6, e.z, e.T.particleColor, big ? 90 : 14, big ? 14 : 7, big ? 1.8 : 1);
  game.shake = Math.max(game.shake, big ? 0.9 : 0.12);
  beep(big ? 120 : rand(500, 700), big ? 0.6 : 0.07, big ? 'sawtooth' : 'square', big ? 0.07 : 0.025, big ? -60 : -300);
}

const arcs = [];
const arcMat = new THREE.LineBasicMaterial({ color: 0x93c5fd, transparent: true });

function chainArc(from, dmg) {
  const visited = new Set([from]);
  const pts = [new THREE.Vector3(from.x, 0.7, from.z)];
  let cur = from;
  for (let i = 0; i < stats.chainJumps; i++) {
    const next = nearestEnemy(cur.x, cur.z, 6.5, visited);
    if (!next) break;
    visited.add(next);
    // Zig-zag between enemies so it looks like lightning.
    for (let s = 1; s <= 3; s++) {
      const t = s / 4;
      pts.push(new THREE.Vector3(cur.x + (next.x - cur.x) * t + rand(-0.4, 0.4), 0.7 + rand(-0.3, 0.3), cur.z + (next.z - cur.z) * t + rand(-0.4, 0.4)));
    }
    pts.push(new THREE.Vector3(next.x, 0.7, next.z));
    hitEnemy(next, dmg, false, false);
    cur = next;
  }
  if (pts.length < 2) return;
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), arcMat.clone());
  scene.add(line);
  arcs.push({ line, life: 0.2 });
  beep(1400, 0.05, 'sawtooth', 0.015, -900);
}

function fireEnemyBullet(e) {
  const d = Math.hypot(e.x, e.z);
  const base = Math.atan2(-e.z / d, -e.x / d);
  const boss = e.type === 'boss';
  const angles = boss ? [-0.22, 0, 0.22] : [0];
  for (const off of angles) {
    const a = base + off;
    poolAdd(enemyBullets, {
      x: e.x, z: e.z, dx: Math.cos(a), dz: Math.sin(a),
      speed: boss ? 5.5 : 4.2, dmg: (boss ? 5 : 3) * enemyDmgScale(), color: C.enemyBullet, rot: 0,
    });
  }
}

// ---------- Text effects ----------

const texts = [];
const projV = new THREE.Vector3();

function floatText(x, y, z, str, cls, life = 0.75, rise = 2.2) {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = str;
  $('fx').appendChild(el);
  texts.push({ el, x, y, z, life, max: life, rise });
}

function dmgText(x, z, dmg, crit) {
  if (texts.length > 50 && !crit) return;
  floatText(x + rand(-0.4, 0.4), 1.6, z + rand(-0.4, 0.4), fmtDmg(dmg), crit ? 'dmg crit' : 'dmg');
}

let bannerTimer = 0;
function banner(title, sub, secs) {
  $('banner-title').textContent = title;
  $('banner-sub').textContent = sub;
  $('banner').classList.add('show');
  bannerTimer = secs;
}

function toast(html, cls = '') {
  const el = document.createElement('div');
  el.className = `toast ${cls}`;
  el.innerHTML = html;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Shop ----------

function renderShop() {
  $('shop-list').innerHTML = UPGRADES.map((u, i) => {
    const lvl = state.levels[u.id] || 0;
    const maxed = u.max != null && lvl >= u.max;
    return `<button class="up" data-id="${u.id}">
      <span class="key">${(i + 1) % 10}</span>
      <span class="icon">${u.icon}</span>
      <span><b>${u.name}</b><em>Lv ${lvl}${u.max != null ? '/' + u.max : ''}</em><small>${u.desc}</small></span>
      <span class="cost">${maxed ? 'MAX' : fmt(upgradeCost(u, lvl))}</span>
    </button>`;
  }).join('');
  updateAffordability();
  renderStats();
}

function updateAffordability() {
  for (const btn of $('shop-list').children) {
    const u = UPGRADES.find((x) => x.id === btn.dataset.id);
    const lvl = state.levels[u.id] || 0;
    const maxed = u.max != null && lvl >= u.max;
    const can = !maxed && state.online && state.wallet >= upgradeCost(u, lvl);
    btn.classList.toggle('maxed', maxed);
    btn.classList.toggle('can', can);
    btn.classList.toggle('cant', !can && !maxed);
  }
}

function renderStats() {
  const dps = stats.dmg * stats.fireRate * stats.shots * (1 + stats.critChance * (stats.critMult - 1)) + stats.drones * stats.droneDmg * stats.droneRate;
  $('stats').innerHTML = [
    ['Damage', fmtDmg(stats.dmg)],
    ['Shots/s', stats.fireRate.toFixed(1)],
    ['Approx. DPS', fmtDmg(dps)],
    ['Core', fmt(stats.coreMax)],
    ['Overclock', stats.overclock > 1 ? `×${stats.overclock.toFixed(2)}` : 'inactive'],
    ['Ship', shipById(state.ship).name],
    ['Best', `level ${levelOf(game.best)}`],
  ].map(([k, v]) => `<span>${k}: <b>${v}</b></span>`).join('');
}

let buying = false;
async function buy(id) {
  if (buying) return;
  if (!state.online) return toast('Server disconnected', 'error');
  buying = true;
  try {
    const s = await api.buy(id);
    applyStatus(s);
    const btn = $('shop-list').querySelector(`[data-id="${id}"]`);
    if (btn) { btn.classList.remove('bought'); void btn.offsetWidth; btn.classList.add('bought'); }
    beep(660, 0.08, 'triangle', 0.05);
    setTimeout(() => beep(990, 0.12, 'triangle', 0.05), 70);
  } catch (err) {
    toast(escapeHtml(err.message), 'error');
    beep(150, 0.15, 'square', 0.04);
  } finally {
    buying = false;
  }
}

$('shop-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.up');
  if (btn) { unlockAudio(); buy(btn.dataset.id); }
});

// ---------- Hangar ----------

let shopTab = 'up';
let previewId = DEFAULT_SHIP;

// Rotating preview of the ship selected in the hangar, with its own small renderer.
const preview = (() => {
  const canvas = $('hangar-preview');
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  r.setPixelRatio(Math.min(devicePixelRatio, 2));
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0x8fa2ff, 0x2a1438, 1.3));
  const light = new THREE.DirectionalLight(0xffffff, 2.4);
  light.position.set(3, 5, 4);
  sc.add(light);
  const cam = new THREE.PerspectiveCamera(35, 2, 0.1, 50);
  cam.position.set(0, 2.4, 4.6);
  cam.lookAt(0, -0.1, 0);
  const holder = new THREE.Group();
  holder.rotation.y = 0.6;
  sc.add(holder);
  let current = null, thr = null, w = 0, h = 0;
  return {
    show(id) {
      if (current) { holder.remove(current); disposeModel(current); }
      ({ model: current, thruster: thr } = buildShip(id));
      holder.add(current);
    },
    render(dt) {
      if (canvas.clientWidth !== w || canvas.clientHeight !== h) {
        w = canvas.clientWidth;
        h = canvas.clientHeight;
        if (!w || !h) return;
        r.setSize(w, h, false);
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
      }
      holder.rotation.y += dt * 0.7;
      if (thr) thr.scale.z = 0.8 + Math.random() * 0.4;
      r.render(sc, cam);
    },
  };
})();

function renderHangar() {
  $('hangar-list').innerHTML = SHIPS.map((s) => {
    const owned = state.ships.includes(s.id);
    const equipped = state.ship === s.id;
    const mods = describeMods(s.mods)
      .map((m) => `<i class="${m.good === true ? 'good' : m.good === false ? 'bad' : ''}">${m.label}</i>`).join('') || '<i>No modifiers</i>';
    const action = equipped
      ? '<span class="tag">EQUIPPED</span>'
      : owned ? '<button data-act="select">Equip</button>' : `<button data-act="buy">${fmt(s.price)} TK</button>`;
    return `<div class="ship${equipped ? ' equipped' : ''}${previewId === s.id ? ' previewing' : ''}" data-ship="${s.id}"
        style="--ship: #${s.bullet.toString(16).padStart(6, '0')}">
      <div class="ship-info"><b>${s.name}</b><small>${s.desc}</small><span class="mods">${mods}</span></div>
      ${action}
    </div>`;
  }).join('');
  updateHangarAffordability();
}

function updateHangarAffordability() {
  for (const card of $('hangar-list').children) {
    const btn = card.querySelector('[data-act="buy"]');
    if (btn) btn.classList.toggle('can', state.online && state.wallet >= shipById(card.dataset.ship).price);
  }
}

function previewShip(id) {
  previewId = id;
  preview.show(id);
  $('hangar-name').textContent = shipById(id).name;
  for (const card of $('hangar-list').children) card.classList.toggle('previewing', card.dataset.ship === id);
}

async function shipAction(id, action) {
  if (buying) return;
  if (!state.online) return toast('Server disconnected', 'error');
  buying = true;
  try {
    applyStatus(await api.ship(id, action));
    if (action === 'buy') toast(`<b>${escapeHtml(shipById(id).name)}</b> added to the hangar and equipped`);
    beep(520, 0.08, 'triangle', 0.05);
    setTimeout(() => beep(780, 0.14, 'triangle', 0.05), 80);
  } catch (err) {
    toast(escapeHtml(err.message), 'error');
    beep(150, 0.15, 'square', 0.04);
  } finally {
    buying = false;
  }
}

$('hangar-list').addEventListener('click', (e) => {
  const card = e.target.closest('.ship');
  if (!card) return;
  unlockAudio();
  previewShip(card.dataset.ship);
  const btn = e.target.closest('button[data-act]');
  if (btn) shipAction(card.dataset.ship, btn.dataset.act);
});

function setShopTab(tab) {
  shopTab = tab;
  for (const b of $('tabs').children) b.classList.toggle('active', b.dataset.tab === tab);
  $('shop-list').hidden = tab !== 'up';
  $('hangar').hidden = tab !== 'hangar';
  $('shop-hint').textContent = tab === 'up'
    ? 'Paid for only with the tokens Claude consumes.'
    : 'Each ship changes your combat style. Bought with TK.';
  if (tab === 'hangar') previewShip(previewId);
}
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setShopTab(b.dataset.tab);
});

// ---------- Server connection ----------

function refreshStats() {
  const prevMax = stats.coreMax;
  stats = computeStats(state.levels, state.generating, state.ship);
  if (stats.coreMax > prevMax && game.phase === 'play') game.coreHp += stats.coreMax - prevMax;
  game.coreHp = Math.min(game.coreHp, stats.coreMax);
  syncDrones();
  renderStats();
}

function applyStatus(s) {
  const levelsChanged = JSON.stringify(s.levels) !== JSON.stringify(state.levels);
  const genChanged = s.generating !== state.generating;
  const shipChanged = s.ship !== state.ship;
  const shipsChanged = JSON.stringify(s.ships) !== JSON.stringify(state.ships);
  state.ship = s.ship;
  state.ships = s.ships;
  state.wallet = s.wallet;
  state.levels = s.levels;
  state.generating = s.generating;
  state.processes = s.processes;
  state.rate = s.rate;
  state.sessions = s.sessions;
  state.earnedTotal = s.earned;
  if (levelsChanged) renderShop();
  if (shipChanged) setShip(s.ship);
  if (levelsChanged || genChanged || shipChanged) refreshStats();
  if (shipChanged || shipsChanged) renderHangar();
  updateHangarAffordability();
  if (genChanged && s.generating) toast('<b>Claude is generating</b> · overclock on');
  updateAffordability();
  updateIntermission();
  renderClaude(s);
}

function renderClaude(s) {
  const el = $('claude');
  el.className = s.generating ? 'gen' : s.processes > 0 ? 'open' : '';
  $('claude-text').textContent = s.generating
    ? `Claude generating · overclock ×${stats.overclock.toFixed(2)}`
    : s.processes > 0
      ? `${s.processes} Claude session${s.processes > 1 ? 's' : ''} open · idle`
      : 'No Claude sessions open';
  $('rate').textContent = `${fmt(s.rate)} TK/min · earned ${fmt(s.earned)} · spent ${fmt(s.spent)}`;
  // Diminishing returns kick in when too many tokens are burned in the same 10-minute window.
  const inc = s.income;
  const saturated = inc.efficiency < 0.98;
  $('saturation').hidden = !saturated;
  if (saturated) {
    $('saturation').innerHTML = `⚠ Saturated: <b>${Math.round(inc.efficiency * 100)}%</b> efficiency. ` +
      `Too many tokens at once (${fmt(inc.windowTk)} in ${inc.windowMinutes} min)` +
      `<div class="meter"><i style="width:${Math.round(inc.efficiency * 100)}%"></i></div>`;
  }
  if (saturated && !state.saturated) toast('<b>Income saturated</b> · parallel sessions give diminishing returns');
  state.saturated = saturated;
  $('sessions').innerHTML = s.sessions.map((x) =>
    `<div><b>${escapeHtml(x.project)}</b><span>${fmt(x.total)} TK · ${ago(x.ago)}</span></div>`).join('');
  const w = s.weights;
  $('formula').textContent = `TK = input + output + ${w.cacheWrite * 100}% cache writes + ${w.cacheRead * 100}% cache reads, since ${new Date(s.since).toLocaleDateString('en-US')} (+${fmt(s.starter)} starter). The first ${fmt(inc.cap)} TK every ${inc.windowMinutes} min count in full, then returns diminish.`;
}

function onTokenEvents(events) {
  if (!events.length) return;
  const total = events.reduce((a, e) => a + e.tk, 0);
  const byProject = new Map();
  for (const e of events) byProject.set(e.project, (byProject.get(e.project) || 0) + e.tk);
  for (const [project, tk] of [...byProject].slice(0, 3)) toast(`<b>+${fmt(tk)} TK</b> · ${escapeHtml(project)}`);
  floatText(0, 3.2, 0, `+${fmt(total)} TK`, 'dmg tk', 1.6, 3);
  game.corePulse = 1;
  burst(0, 1, 0, C.gold, Math.min(10 + events.length * 6, 60), 7, 1.1);
  const wl = $('wallet');
  wl.classList.add('bump');
  setTimeout(() => wl.classList.remove('bump'), 250);
  beep(880, 0.1, 'sine', 0.05, 440);
}

async function poll() {
  try {
    const s = await api.status(state.seq);
    $('offline').classList.remove('show');
    const first = !state.loaded;
    state.online = true;
    applyStatus(s);
    if (!first) onTokenEvents(s.events);
    state.seq = s.seq;
    if (first) {
      state.loaded = true;
      state.shownWallet = s.wallet;
      game.best = s.bestWave;
      game.kills = s.kills;
      game.levelKills = s.kills;
      game.levelWallet = s.earned;
      game.wave = game.nextWave = s.wave;
      showIntermission('start');
    }
  } catch {
    state.online = false;
    $('offline').classList.add('show');
    updateAffordability();
    if (!state.loaded) {
      state.loaded = true;
      renderShop();
      game.nextWave = 1;
      showIntermission('start');
    }
  }
}

// ---------- Controls ----------

const keys = new Set();
addEventListener('keydown', (e) => {
  unlockAudio();
  keys.add(e.code);
  if (['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD'].includes(e.code)) game.mouseAim = false;
  const digit = e.code.match(/^(?:Digit|Numpad)(\d)$/);
  if (digit && !e.repeat) {
    const idx = (Number(digit[1]) + 9) % 10;
    if (UPGRADES[idx]) buy(UPGRADES[idx].id);
  }
  if ((e.code === 'Space' || e.code === 'Enter') && game.phase === 'intermission') { e.preventDefault(); continueFromIntermission(); }
  if (e.code === 'KeyH') setShopTab(shopTab === 'hangar' ? 'up' : 'hangar');
  if (e.code === 'KeyP') { game.paused = !game.paused; $('paused').classList.toggle('show', game.paused); }
  if (e.code === 'KeyM') { muted = !muted; toast(muted ? 'Sound off' : 'Sound on'); }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

const raycaster = new THREE.Raycaster();
const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.6);
const ndc = new THREE.Vector2();
const hitPoint = new THREE.Vector3();
renderer.domElement.addEventListener('pointermove', (e) => {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  if (raycaster.ray.intersectPlane(aimPlane, hitPoint)) {
    game.aimAngle = Math.atan2(hitPoint.z, hitPoint.x);
    game.mouseAim = true;
  }
});
renderer.domElement.addEventListener('pointerdown', unlockAudio);

// ---------- Main loop ----------

function syncDrones() {
  while (drones.length < stats.drones) {
    const m = new THREE.Mesh(droneGeo, droneMat);
    m.userData.fireT = rand(0, 0.5);
    scene.add(m);
    drones.push(m);
  }
  while (drones.length > stats.drones) scene.remove(drones.pop());
}

let time = 0;

function updateShip(dt) {
  const turn = stats.turnSpeed * dt;
  if (game.mouseAim) {
    const diff = wrapAngle(game.aimAngle - game.shipAngle);
    game.shipAngle += THREE.MathUtils.clamp(diff, -turn, turn);
  } else {
    if (keys.has('KeyA') || keys.has('ArrowLeft')) game.shipAngle -= turn;
    if (keys.has('KeyD') || keys.has('ArrowRight')) game.shipAngle += turn;
  }
  game.shipAngle = wrapAngle(game.shipAngle);
  const a = game.shipAngle;
  ship.position.x = Math.cos(a) * SHIP_R;
  ship.position.z = Math.sin(a) * SHIP_R;
  // The ship turns inward while defending the inside of its orbit.
  const inner = game.phase === 'play' ? innerTarget() : null;
  const face = inner ? Math.atan2(inner.z - ship.position.z, inner.x - ship.position.x) : a;
  ship.rotation.y = Math.PI / 2 - face;
  ship.rotation.z = Math.sin(time * 3) * 0.08;
  thruster.scale.z = 0.8 + Math.random() * 0.5 * (state.generating ? 1.6 : 1);

  if (game.phase === 'play') {
    game.fireT -= dt;
    while (game.fireT <= 0) {
      game.fireT += 1 / stats.fireRate;
      shoot();
    }
  }

  drones.forEach((d, i) => {
    const da = time * 2.2 + (i / drones.length) * TAU;
    d.position.set(ship.position.x + Math.cos(da) * 1.6, 1.1 + Math.sin(time * 4 + i) * 0.15, ship.position.z + Math.sin(da) * 1.6);
    d.rotation.y += dt * 3;
    if (game.phase !== 'play') return;
    d.userData.fireT -= dt;
    if (d.userData.fireT > 0) return;
    const target = nearestEnemy(d.position.x, d.position.z, 24);
    if (!target) return;
    d.userData.fireT = 1 / stats.droneRate;
    const dx = target.x - d.position.x, dz = target.z - d.position.z, len = Math.hypot(dx, dz) || 1;
    poolAdd(bullets, {
      x: d.position.x, z: d.position.z, dx: dx / len, dz: dz / len, speed: 28, life: 1.2,
      dmg: stats.droneDmg, crit: false, pierce: 0, hit: new Set(), chain: false, color: C.drone,
    });
    droneSound();
  });
}

function updateEnemies(dt) {
  if (game.phase !== 'play') return;
  game.stepT -= dt;
  if (game.stepT <= 0) {
    // Like classic invaders: they step forward and reverse direction, but toward the core.
    game.stepT = stepInterval();
    for (const e of enemies) e.targetR -= e.type === 'boss' ? 0.7 : 1;
    for (const r of game.rings) r.omega *= -1;
    beep(70, 0.09, 'square', 0.03);
  }

  for (const e of enemies) {
    if (!e.alive) continue;
    e.angle += game.rings[e.ring].omega * (1 + e.T.drift) * dt;
    e.r += (e.targetR - e.r) * Math.min(1, dt * 4);
    e.x = Math.cos(e.angle) * e.r;
    e.z = Math.sin(e.angle) * e.r;
    e.mesh.position.set(e.x, 0.7 + Math.sin(e.bob + time * 2) * 0.15, e.z);
    e.mesh.rotation.x += e.T.spin * dt;
    e.mesh.rotation.y += e.T.spin * 0.7 * dt;
    e.flash -= dt;
    e.mat.emissiveIntensity = e.flash > 0 ? 1.4 : e.elite ? e.glow + Math.sin(time * 6 + e.bob) * 0.25 : e.glow;

    if (e.hp < e.maxHp) {
      const { fg, w } = e.bar.userData;
      const f = Math.max(0, e.hp / e.maxHp);
      e.bar.visible = true;
      e.bar.position.set(e.x, e.type === 'boss' ? 3.6 : 2, e.z);
      e.bar.quaternion.copy(camera.quaternion);
      fg.scale.x = w * f;
      fg.position.x = -(w * (1 - f)) / 2;
    }

    if (e.T.shoots && e.r < 20) {
      e.fireT -= dt;
      if (e.fireT <= 0) { e.fireT = rand(...e.T.shoots) * fireRateScale(); fireEnemyBullet(e); }
    }

    if (e.r < CORE_HIT_R + e.T.r * 0.5) {
      burst(e.x, 0.6, e.z, e.T.particleColor, 18, 8);
      removeEnemy(e);
      coreHit(e.T.dmg * e.dmgMul * enemyDmgScale(), 'contact');
      if (game.phase !== 'play') return;
    }
  }
  enemies = enemies.filter((e) => e.alive);

  if (enemies.length === 0) {
    game.phase = 'clear';
    game.phaseT = 2;
    banner(`WAVE ${game.wave} CLEARED`, 'Preparing the next wave…', 1.8);
    beep(523, 0.15, 'triangle', 0.05);
    setTimeout(() => beep(784, 0.25, 'triangle', 0.05), 140);
  }
}

function updateBullets(dt) {
  const items = bullets.items;
  let w = 0;
  for (let i = 0; i < items.length; i++) {
    const b = items[i];
    b.x += b.dx * b.speed * dt;
    b.z += b.dz * b.speed * dt;
    b.life -= dt;
    let alive = b.life > 0 && b.x * b.x + b.z * b.z < FIELD_R * FIELD_R;
    if (alive) {
      for (const e of enemies) {
        if (!e.alive || b.hit.has(e)) continue;
        const rr = e.T.r + 0.25;
        if ((e.x - b.x) ** 2 + (e.z - b.z) ** 2 < rr * rr) {
          b.hit.add(e);
          hitEnemy(e, b.dmg, b.crit, b.chain);
          if (b.pierce-- <= 0) { alive = false; break; }
        }
      }
    }
    if (alive) items[w++] = b;
  }
  items.length = w;
  poolSync(bullets, (b, d) => {
    d.position.set(b.x, 0.7, b.z);
    d.rotation.set(0, Math.atan2(b.dx, b.dz), 0);
    d.scale.setScalar(b.crit ? 1.5 : 1);
  });

  const eb = enemyBullets.items;
  w = 0;
  for (let i = 0; i < eb.length; i++) {
    const b = eb[i];
    b.x += b.dx * b.speed * dt;
    b.z += b.dz * b.speed * dt;
    b.rot += dt * 6;
    let alive = true;
    if ((b.x - ship.position.x) ** 2 + (b.z - ship.position.z) ** 2 < 1.1) {
      burst(b.x, 0.7, b.z, C.bullet, 6, 5, 0.6);
      beep(1200, 0.04, 'square', 0.02);
      alive = false;
    } else if (b.x * b.x + b.z * b.z < 2.3 * 2.3) {
      burst(b.x, 0.7, b.z, C.enemyBullet, 8, 5);
      coreHit(b.dmg, 'bullet');
      alive = false;
    }
    if (alive) eb[w++] = b;
  }
  eb.length = game.phase === 'dead' ? 0 : w;
  poolSync(enemyBullets, (b, d) => {
    d.position.set(b.x, 0.7, b.z);
    d.rotation.set(b.rot, b.rot * 0.7, 0);
    d.scale.setScalar(1);
  });
}

function updateParticles(dt) {
  const items = particles.items;
  let w = 0;
  for (let i = 0; i < items.length; i++) {
    const p = items[i];
    p.life -= dt;
    if (p.life <= 0) continue;
    p.vy -= p.g * dt;
    p.x += p.vx * dt;
    p.y = Math.max(-0.2, p.y + p.vy * dt);
    p.z += p.vz * dt;
    p.vx *= 0.97;
    p.vz *= 0.97;
    p.rot += dt * 8;
    items[w++] = p;
  }
  items.length = w;
  poolSync(particles, (p, d) => {
    d.position.set(p.x, p.y, p.z);
    d.rotation.set(p.rot, p.rot * 1.3, 0);
    d.scale.setScalar(p.s * (p.life / p.max));
  });

  for (let i = arcs.length - 1; i >= 0; i--) {
    const a = arcs[i];
    a.life -= dt;
    a.line.material.opacity = Math.max(0, a.life / 0.2);
    if (a.life <= 0) {
      scene.remove(a.line);
      a.line.geometry.dispose();
      a.line.material.dispose();
      arcs.splice(i, 1);
    }
  }

  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i];
    t.life -= dt;
    if (t.life <= 0) { t.el.remove(); texts.splice(i, 1); continue; }
    t.y += t.rise * dt;
    projV.set(t.x, t.y, t.z).project(camera);
    t.el.style.transform = `translate(${(projV.x * 0.5 + 0.5) * innerWidth}px, ${(-projV.y * 0.5 + 0.5) * innerHeight}px) translate(-50%, -50%)`;
    t.el.style.opacity = Math.min(1, (t.life / t.max) * 2);
  }
}

function updateWorld(dt) {
  coreMesh.rotation.y += dt * 0.5;
  coreMesh.rotation.x += dt * 0.2;
  coreCage.rotation.y -= dt * (state.generating ? 1.2 : 0.3);
  game.corePulse = Math.max(0, game.corePulse - dt * 1.5);
  coreMesh.scale.setScalar(1 + game.corePulse * 0.3 + Math.sin(time * 3) * 0.03);
  coreMat.emissiveIntensity = 0.4 + game.corePulse * 1.5 + (state.generating ? 0.25 + Math.sin(time * 8) * 0.15 : 0);

  const hpFrac = game.coreHp / stats.coreMax;
  coreRingMat.color.setHSL(0.33 * hpFrac, 0.8, 0.55);
  coreRing.scale.setScalar(1 + (1 - hpFrac) * 0.08 * Math.sin(time * 10));

  if (game.phase === 'play' && stats.coreRegen > 0) game.coreHp = Math.min(stats.coreMax, game.coreHp + stats.coreRegen * dt);

  asteroids.rotation.y += dt * 0.012;
  for (const m of asteroids.children) m.rotation.x += m.userData.spin * dt;

  if (game.phase === 'clear' || game.phase === 'dead') {
    game.phaseT -= dt;
    if (game.phaseT <= 0) {
      if (game.phase === 'dead') {
        game.nextWave = game.wave;
        showIntermission('dead');
      } else if (waveInLevel(game.wave) === WAVES_PER_LEVEL) {
        game.nextWave = game.wave + 1;
        game.best = Math.max(game.best, game.nextWave);
        showIntermission('complete');
      } else {
        startWave(game.wave + 1);
      }
    }
  }

  if (bannerTimer > 0) {
    bannerTimer -= dt;
    if (bannerTimer <= 0) $('banner').classList.remove('show');
  }

  game.shake = Math.max(0, game.shake - dt * 2.5);
  const s = game.shake * game.shake * 0.8;
  camera.position.set(camBase.x + rand(-s, s), camBase.y + rand(-s, s), camBase.z + rand(-s, s));
  camera.lookAt(0, 0, 0.5);
}

let hudT = 0;
function updateHud(dt) {
  hudT -= dt;
  state.shownWallet += (state.wallet - state.shownWallet) * Math.min(1, dt * 6);
  if (Math.abs(state.wallet - state.shownWallet) < 1) state.shownWallet = state.wallet;
  if (hudT > 0) return;
  hudT = 0.1;
  $('wallet').textContent = state.online || state.wallet ? fmt(state.shownWallet) : '—';
  const w = game.phase === 'intermission' ? game.nextWave : game.wave;
  $('wave-title').textContent = `LEVEL ${levelOf(w)} · WAVE ${waveInLevel(w)}/${WAVES_PER_LEVEL}`;
  const left = enemies.length;
  $('wave-sub').textContent = game.phase === 'play'
    ? `Enemies ${left}/${game.waveTotal} · Best level ${levelOf(game.best)} · Kills ${fmt(game.kills)}`
    : game.phase === 'dead' ? 'Core destroyed'
      : game.phase === 'intermission' ? 'Paused · upgrade your gear' : 'Wave cleared';
  $('core-bar').style.width = `${(game.coreHp / stats.coreMax) * 100}%`;
  $('core-label').textContent = `CORE ${fmt(game.coreHp)} / ${fmt(stats.coreMax)}`;
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (game.paused || game.phase === 'loading') dt = 0;
  time += dt;
  updateShip(dt);
  updateEnemies(dt);
  updateBullets(dt);
  updateParticles(dt);
  updateWorld(dt);
  updateHud(dt);
  renderer.render(scene, camera);
  if (shopTab === 'hangar') preview.render(dt);
}

// With ?debug the simulation can be stepped manually from the console (useful in background tabs).
if (DEBUG) {
  window.__debug = {
    game,
    get enemies() { return enemies; },
    get stats() { return stats; },
    killAll() { for (const e of [...enemies]) if (e.alive) killEnemy(e); },
    continue: continueFromIntermission,
    coreDamageLog,
    hangar(id) { setShopTab('hangar'); previewShip(id); preview.render(1 / 30); },
    // Building blocks for staging scenes (e.g. README screenshots).
    THREE, scene, camera, renderer, buildShip, showIntermission, setShopTab,
    step(seconds, dt = 1 / 30) {
      for (let s = 0; s < seconds; s += dt) {
        time += dt;
        updateShip(dt); updateEnemies(dt); updateBullets(dt); updateParticles(dt); updateWorld(dt); updateHud(dt);
      }
      renderer.render(scene, camera);
    },
  };
}

renderShop();
renderHangar();
poll();
setInterval(poll, 2000);
setInterval(saveProgress, 10000);
requestAnimationFrame(frame);
