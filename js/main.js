import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Sound } from './sound.js';
import { Tracker } from './tracker.js';
import { Station } from './station.js';
import { FloppyPizza } from './pizza.js';
import { RatBody } from './ratphysics.js';
import { texFrom, concreteCanvas } from './textures.js';

// =========================================================================
// 🛠️ TWEAK ME
// =========================================================================
const CONFIG = {
  tagDictionary: 'ARUCO_6X6_1000', // the printed tag's dictionary: 'ARUCO_6X6_1000' (any 6x6 tag) or 'ARUCO' (Original ArUco)
  triggerId: 0,         // only this tag fires the flash (the apple tag is 6x6 tag 0). null = any tag in the dictionary.
  tagInShape: true,     // also find a tag printed inside a solid black shape, like the apple logo
  ratLength: 0.38,      // meters, nose to tail tip
  pizzaLength: 0.22,    // meters, tip to crust
  walkAnim: 'walk_big',  // walk_A1 (quick), walk_A2 (medium), walk_A3 (slow, heavy)
  walkAnimSpeed: 0.9,
  walkSpeed: 0.15,      // how fast he walks on each step (m/s)
  runSpeed: 1.1,        // how fast he bolts to hide (m/s)
  minHideTime: 1.0,     // seconds he stays hidden even if you close the flap right away
  peekEvery: 3.0,       // seconds between peeks while hiding
  stationName: 'Spring Street', // column signs
  mosaicName: 'SPRING ST.',     // big wall mosaics
  plaqueName: 'SPRING',         // little wall plaques
  line: '6',
  lineColor: '#00933c',         // 4/5/6 green
  // When the station recording (assets/sounds/nyc-subway-loop.mp3) is playing, trains follow it.
  // These only apply if that file can't load:
  firstTrain: 12,       // seconds after Start until the first train
  trainEvery: 60,       // roughly how often trains come (seconds)
  expressTrain: true,   // true: express roars through (recorded sound). false: local train stops and announces.
};

// Staircase size (meters). Real NYC subway steps are about 30cm deep, 17cm tall.
const STEP_D = 0.30;
const STEP_H = 0.17;
const STAIR_W = 1.6;
const N_STEPS = 30;
const LANE_Z = -0.22;                 // where he walks across the stairs
const EDGE_Z = -STAIR_W / 2;          // the open side with the railing
const HIDE_Z = EDGE_Z - 0.06;         // just over the edge, clinging below the lip

const treadTop = (x) => -Math.floor(x / STEP_D) * STEP_H;

// =========================================================================
// RENDERER, SCENE, CAMERA
// =========================================================================
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const BG = new THREE.Color(0x0b0d10);
scene.background = BG;
scene.fog = new THREE.FogExp2(BG, 0.05);

// near plane 0.05 (not smaller) keeps distant surfaces from flickering against each other
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 80);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

// --- Lights: warm fluorescent key, cool fill, rim from behind ---
scene.add(new THREE.HemisphereLight(0xc4d6ff, 0x2a2118, 0.55));

const key = new THREE.DirectionalLight(0xffe0b0, 2.8);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -1.1, right: 1.1, top: 1.1, bottom: -1.1, near: 0.1, far: 6 });
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
key.shadow.radius = 4;
scene.add(key, key.target);

const rim = new THREE.DirectionalLight(0x9cc4ff, 1.6);
scene.add(rim, rim.target);

const bounce = new THREE.PointLight(0xffb870, 0.8, 2.5, 2);
scene.add(bounce);

// Overhead station fluorescents (no shadows) so the platform below isn't pitch black
const stationLight = new THREE.DirectionalLight(0xf2f5e6, 0.9);
stationLight.position.set(0.3, 1, 0.2);
scene.add(stationLight);

// The phone's camera flash — a real light in the scene, so it lights up the rat
const flashLight = new THREE.PointLight(0xf2f6ff, 0, 6, 2);
scene.add(flashLight);

// =========================================================================
// ENDLESS STAIRCASE — a fixed set of steps that leapfrog to follow the rat
// =========================================================================
const TREAD_REPEAT = [1, STAIR_W / STEP_D];
const treadVariants = [0, 0.31, 0.57, 0.83].map((o) => new THREE.MeshStandardMaterial({
  map: texFrom(concreteCanvas, { repeat: TREAD_REPEAT, offset: [o, o * 1.7] }),
  bumpMap: texFrom(concreteCanvas, { srgb: false, repeat: TREAD_REPEAT, offset: [o, o * 1.7] }),
  bumpScale: 1.5,
  roughness: 0.92,
  envMapIntensity: 0.35,
}));
const riserMat = new THREE.MeshStandardMaterial({
  map: texFrom(concreteCanvas, { repeat: [STAIR_W / STEP_D, 4] }),
  color: 0x8a857c,
  roughness: 0.95,
  envMapIntensity: 0.3,
});
const sideMat = new THREE.MeshStandardMaterial({
  map: texFrom(concreteCanvas, { repeat: [1, 4] }),
  color: 0x77726a,
  roughness: 1,
});
const noseMat = new THREE.MeshStandardMaterial({ color: 0xd9a300, roughness: 0.65, envMapIntensity: 0.4 });
const metalMat = new THREE.MeshStandardMaterial({ color: 0xa8a69e, metalness: 0.9, roughness: 0.35 });

const STEP_BOX_H = 1.4;
const stepGeo = new THREE.BoxGeometry(STEP_D, STEP_BOX_H, STAIR_W);
const noseGeo = new THREE.BoxGeometry(0.05, 0.005, STAIR_W);
const edgeGeo = new THREE.BoxGeometry(0.008, 0.022, STAIR_W);
const LEDGE_W = 0.13, LEDGE_T = 0.035;
const ledgeGeo = new THREE.BoxGeometry(STEP_D, LEDGE_T, LEDGE_W);
const steps = [];
for (let j = 0; j < N_STEPS; j++) {
  const box = new THREE.Mesh(stepGeo, [riserMat, sideMat, treadVariants[0], sideMat, sideMat, sideMat]);
  box.receiveShadow = true;
  box.castShadow = true;
  const nose = new THREE.Mesh(noseGeo, noseMat);
  nose.receiveShadow = true;
  const edge = new THREE.Mesh(edgeGeo, metalMat);
  edge.receiveShadow = true;
  // a narrow concrete ledge along the open side, a bit below each step: his hiding spot
  const ledge = new THREE.Mesh(ledgeGeo, sideMat);
  ledge.receiveShadow = true;
  scene.add(box, nose, edge, ledge);
  steps.push({ i: null, box, nose, edge, ledge });
}
function updateSteps(focusX) {
  const base = Math.floor(focusX / STEP_D) - 10;
  steps.forEach((s, j) => {
    const i = base + j;
    if (s.i === i) return;
    s.i = i;
    const top = -i * STEP_H;
    s.box.position.set(i * STEP_D + STEP_D / 2, top - STEP_BOX_H / 2, 0);
    s.nose.position.set((i + 1) * STEP_D - 0.03, top + 0.0025, 0);
    s.edge.position.set((i + 1) * STEP_D + 0.003, top - 0.011, 0); // sits proud of the riser
    s.ledge.position.set(i * STEP_D + STEP_D / 2, top - HIDE_SINK - LEDGE_T / 2, -STAIR_W / 2 - LEDGE_W / 2);
    s.box.material[2] = treadVariants[((i % 4) + 4) % 4];
  });
}

// =========================================================================
// MODELS
// =========================================================================
const V3 = THREE.Vector3;
const loader = new GLTFLoader();
const startBtn = document.getElementById('startBtn');

const ratRoot = new THREE.Group();   // position + heading
const ratPitch = new THREE.Group();  // nose-down tilt when hopping down a step
const ratHolder = new THREE.Group(); // fixes the model's own orientation/scale
ratRoot.add(ratPitch);
ratPitch.add(ratHolder);
scene.add(ratRoot);

let mixer = null;
const actions = {};
let currentAction = null;
let noseTip = null;
let mouthDist = 0.15;
let ratEyeHeight = 0.07;
let bodyR = 0;
const bodyALocal = new THREE.Vector3(), bodyBLocal = new THREE.Vector3();
const _bodyA = new THREE.Vector3(), _bodyB = new THREE.Vector3();
let pizza = null;
let ready = false;

function prepMaterials(root, envI) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    o.frustumCulled = false;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => {
      m.envMapIntensity = envI;
      if (m.alphaTest > 0) m.alphaToCoverage = true; // softer fur edges
    });
  });
}

async function loadModels() {
  const [ratGltf, pizzaGltf, stationGltf] = await Promise.all([
    loader.loadAsync('assets/rat.glb'),
    loader.loadAsync('assets/pizza.glb'),
    loader.loadAsync('assets/station.glb', (e) => {
      // (GitHub Pages sends the file compressed, so e.total there is the smaller compressed size;
      // 30.5 MB is the file's real size)
      const pct = Math.min(99, Math.round((e.loaded / Math.max(e.total, 30.5e6)) * 100));
      startBtn.textContent = `Loading station… ${pct}%`;
    }),
  ]);
  station.setModel(stationGltf);

  // ---------- RAT ----------
  const ratScene = ratGltf.scene;
  prepMaterials(ratScene, 0.6);
  ratHolder.add(ratScene);
  ratScene.updateMatrixWorld(true);

  let box = new THREE.Box3().setFromObject(ratScene, true);
  const size = box.getSize(new V3());
  ratScene.scale.multiplyScalar(CONFIG.ratLength / Math.max(size.x, size.y, size.z));
  ratScene.updateMatrixWorld(true);

  // Which way is the model facing? Use the eyes vs. the body center.
  let eyes = null, fur = null;
  ratScene.traverse((o) => {
    if (o.isMesh && /eyes/i.test(o.name)) eyes = o;
    if (o.isMesh && /fur/i.test(o.name)) fur = o;
  });
  const bodyC = new THREE.Box3().setFromObject(fur || ratScene, true).getCenter(new V3());
  const eyeC = eyes ? new THREE.Box3().setFromObject(eyes, true).getCenter(new V3()) : bodyC.clone().add(new V3(0, 0, 1));
  const fwd = eyeC.clone().sub(bodyC).setY(0).normalize();
  ratHolder.rotation.y = Math.atan2(fwd.z, fwd.x); // turn the model so it faces +x
  ratHolder.updateMatrixWorld(true);

  // Stand him on y = 0, centered on his body
  box = new THREE.Box3().setFromObject(ratScene, true);
  const c2 = new THREE.Box3().setFromObject(fur || ratScene, true).getCenter(new V3());
  ratHolder.position.set(-c2.x, -box.min.y, -c2.z);
  ratHolder.updateMatrixWorld(true);
  if (eyes) ratEyeHeight = new THREE.Box3().setFromObject(eyes, true).getCenter(new V3()).y;

  // Bones for stepping down: hips, chest, the spine bones between, and the spine stretch bone
  ratScene.traverse((o) => {
    if (!o.isBone) return;
    if (/^Hips_/.test(o.name)) rig.hips = o;
    else if (/^Spine006_/.test(o.name)) rig.chest = o;
    else if (/^Spine00[1-4]_\d+$/.test(o.name)) rig.spine.push(o); // (not the _end markers)
    else if (/^SpineStretch_\d/.test(o.name)) rig.stretch = o;
    else if (/^SpineStretch_end/.test(o.name)) rig.stretchEnd = o;
    else if (/^Head_Head001_/.test(o.name)) rig.head = o;
    else if (/^Neck_Chest001_/.test(o.name)) rig.neck = o;
    else if (/^ForeHandik[LR]_/.test(o.name)) { rig.front.push(o); rig.frontPaws.push(o); }
    else if (/^LegFootik[LR]_/.test(o.name)) rig.hindPaws.push(o);
  });
  // how high the paw controls sit above the ground when he's standing, and how far ahead his
  // front paws really are (they're further forward than the rough FOOT_F)
  if (rig.frontPaws.length) {
    ratRoot.updateMatrixWorld(true);
    const fp = rig.frontPaws.map((b) => b.getWorldPosition(new V3()));
    PAW_REST_Y = Math.max(0, Math.min(...fp.map((v) => v.y)));
    FRONT_PAW_X = fp.reduce((a, v) => a + v.x, 0) / fp.length - ratRoot.position.x;
    const hp = rig.hindPaws.map((b) => b.getWorldPosition(new V3()));
    if (hp.length) HIND_PAW_X = hp.reduce((a, v) => a + v.x, 0) / hp.length - ratRoot.position.x;
  }
  // the corner of his mouth on the camera side (where the slice is): he bites the crust there
  {
    ratRoot.updateMatrixWorld(true);
    let best = -Infinity;
    ratRoot.traverse((o) => {
      if (!o.isBone || !/^Head_Lip_Corner[LR]_/.test(o.name)) return;
      const z = o.getWorldPosition(new V3()).z;
      if (z > best) { if (lipCorner) lipFar = lipCorner; best = z; lipCorner = o; } else lipFar = o;
    });
    ratRoot.traverse((o) => { if (o.isBone && /^Head_Jaw001_/.test(o.name)) jawBone = o; });
  }
  // in this rig the head and front paws aren't attached to the chest, so they move as a group
  rig.front.unshift(rig.chest, rig.head);
  rig.front = rig.front.filter(Boolean);
  rig.spine.sort((a, b) => a.name.localeCompare(b.name)); // Spine001 (the parent) first
  for (const b of [...rig.front, ...rig.hindPaws, rig.neck, rig.stretch, ...rig.spine, jawBone]) {
    if (b) rig.rest.push({ b, p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() });
  }

  // His body as a capsule, so the floppy slice can't pass through him
  // (this model's meshes aren't named, so use the main body mesh, the biggest one; the whole
  // model's box would include the first half of his tail and make his rump 15cm too long)
  let bodyMesh = fur;
  if (!bodyMesh) ratScene.traverse((o) => {
    if (o.isMesh && (!bodyMesh || o.geometry.attributes.position.count > bodyMesh.geometry.attributes.position.count)) bodyMesh = o;
  });
  ratRoot.updateMatrixWorld(true);
  const furBox = new THREE.Box3().setFromObject(bodyMesh || ratScene, true);
  bodyR = ((furBox.max.z - furBox.min.z) / 2) * 0.85;
  const midY = (furBox.min.y + furBox.max.y) / 2;
  bodyALocal.set(furBox.min.x + bodyR, midY, 0);
  bodyBLocal.set(furBox.max.x - bodyR * 2.4, midY, 0); // stop well short of the mouth, where he holds the tip

  // Find the nose-tip bone so the pizza stays in his mouth
  let best = -Infinity;
  ratScene.traverse((o) => {
    if (!o.isBone || !/Head_Nose/i.test(o.name)) return;
    const p = o.getWorldPosition(new V3());
    if (p.x > best) { best = p.x; noseTip = o; }
  });
  if (noseTip) mouthDist = noseTip.getWorldPosition(new V3()).x;

  mixer = new THREE.AnimationMixer(ratScene);
  const want = {
    idle1: 'idle_A1', idle2: 'idle_A2', idle3: 'idle_A3',
    walkStart: 'walk_start_A', walk_A1: 'walk_A1', walk_A2: 'walk_A2', walk_A3: 'walk_A3', walkEnd: 'walk_end_A',
    runStart: 'run_start_A', run1: 'run_A1', run2: 'run_A2', runEnd: 'run_end_A',
  };
  for (const [k, clipName] of Object.entries(want)) {
    const clip = ratGltf.animations.find((a) => a.name.endsWith(clipName));
    if (clip) actions[k] = mixer.clipAction(clip);
  }
  buildLegPoses(ratGltf.animations.find((a) => a.name.endsWith('run_A1')), ratScene);
  // a longer-striding walk: the same walk with every limb swinging further around its average pose
  const baseWalk = ratGltf.animations.find((a) => a.name.endsWith('walk_A2'));
  if (baseWalk) actions.walk_big = mixer.clipAction(exaggerateClip(baseWalk, 'walk_big', STRIDE_SCALE));

  // ---------- PIZZA ----------
  // Scale it, put the tip at the origin with the crust toward -x, then hand it to the physics
  const pz = pizzaGltf.scene;
  prepMaterials(pz, 0.5);
  const holder = new THREE.Group();
  scene.add(holder);
  holder.add(pz);
  pz.updateMatrixWorld(true);
  let pbox = new THREE.Box3().setFromObject(pz, true);
  pz.scale.multiplyScalar(CONFIG.pizzaLength / pbox.getSize(new V3()).x);
  pz.updateMatrixWorld(true);
  pbox = new THREE.Box3().setFromObject(pz, true);
  const tipZ = (0.185 / 2.44) * CONFIG.pizzaLength; // this slice's tip is a bit off-center
  pz.position.set(-pbox.max.x, -pbox.min.y, -tipZ);
  pizza = new FloppyPizza(pz, scene, { length: CONFIG.pizzaLength, stepD: STEP_D, stepH: STEP_H, holdCrust: true });
  scene.remove(holder);

  setupPhysics();
  setupTail(ratRoot);
  enter('walk');
  updateRat(0, false);
  pizza.reset(holdWorld(new V3()), sliceDir(0));
  ready = true;
}

// =========================================================================
// HELPERS
// =========================================================================
function play(name, { fade = 0.25, loop = true, timeScale = 1 } = {}) {
  const a = actions[name];
  if (!a) return;
  if (currentAction === a) { a.timeScale = timeScale; return; }
  a.reset();
  a.enabled = true;
  a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  a.clampWhenFinished = !loop;
  a.timeScale = timeScale;
  a.setEffectiveWeight(1);
  a.play();
  if (currentAction) a.crossFadeFrom(currentAction, fade, false);
  currentAction = a;
}

const lerpAngle = (a, b, t) => {
  const d = ((((b - a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
  return a + d * t;
};
const angleDiff = (a, b) => Math.abs(lerpAngle(a, b, 1) - a);
const headingOf = (dx, dz) => Math.atan2(-dz, dx); // heading 0 = facing +x
const dirOf = (h, out = new V3()) => out.set(Math.cos(h), 0, -Math.sin(h));
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
const smooth = (t) => t * t * (3 - 2 * t);

// ---------- Stepping down (and up) the stairs ----------
// His pose comes from where his front and back feet are: the front paws reach down a step first,
// the back follows, and his body tilts to match. His belly always clears the step's nose.
const FOOT_F = 0.055;   // body center -> front paws (m)
const FOOT_R = 0.06;    // body center -> back paws (m)
const BELLY = 0.022;    // belly height above his paws (m)
const PAW_DROP = 0.06;  // a paw that just passed an edge eases down over this distance

// height a paw would stand at: the tread, with a gentle ease just past each edge (in the air,
// never inside the step)
function pawY(x) {
  const i = Math.floor(x / STEP_D);
  const into = x - i * STEP_D;
  const top = -i * STEP_H;
  return into < PAW_DROP ? top + STEP_H * (1 - smooth(into / PAW_DROP)) : top;
}

const _pose = { y: 0, pitch: 0 };
function stairPose(x, z, heading) {
  const dx = Math.cos(heading); // how much of his length points down the stairs
  const L = FOOT_F + FOOT_R;
  const xf = x + dx * FOOT_F, xr = x - dx * FOOT_R;
  let yf = pawY(xf), yr = pawY(xr);
  // a step edge between his front and back paws? keep his belly above its nose
  if (Math.abs(xf - xr) > 1e-4) {
    const lo = Math.min(xf, xr), hi = Math.max(xf, xr);
    const k = Math.ceil(lo / STEP_D), ex = k * STEP_D;
    if (ex > lo && ex < hi) {
      const clear = -(k - 1) * STEP_H - BELLY;
      const s = THREE.MathUtils.clamp((ex - xr) / (xf - xr), 0.03, 0.97);
      if (yr + (yf - yr) * s < clear) {
        if (yf < yr) yf = yr + (clear - yr) / s;  // front paws wait higher until there's room
        else yr = (clear - yf * s) / (1 - s);     // (or the back paws, going up)
      }
    }
  }
  const y0 = yr + (yf - yr) * (FOOT_R / L);
  const q0 = THREE.MathUtils.clamp(Math.atan2(yf - yr, L), -MAX_TILT, MAX_TILT); // nose down when the front is lower
  if (!bodyR) { _pose.y = y0; _pose.pitch = q0; return _pose; }

  // A 17cm step is tall for a rat: his body (haunches to chin) is longer than his paws are apart.
  // So his belly and chin must clear the stairs. He tips nose-down (or up) as much as that needs,
  // and only gets lifted for whatever tilting can't fix.
  const liftFor = (q) => Math.max(0, clearanceY(x, z, heading, q) - y0);
  let bestQ = q0, bestLift = liftFor(q0), bestCost = bestLift;
  for (let k = -10; k <= 10; k++) {
    if (!k) continue;
    const q = THREE.MathUtils.clamp(q0 + k * 0.06, -MAX_TILT, MAX_TILT);
    const lift = liftFor(q);
    const cost = lift + 0.02 * Math.abs(q - q0); // prefer tilting over floating
    if (cost < bestCost) { bestCost = cost; bestQ = q; bestLift = lift; }
  }
  _pose.y = y0 + bestLift;
  _pose.pitch = bestQ;
  return _pose;
}
const MAX_TILT = 0.6; // radians (~34°): steeper than this looks like he's falling

/** How far the highest of his paw controls is hanging above the step under it (m). */
function pawGapsBones() {
  let worst = 0;
  for (const b of [...rig.frontPaws, ...rig.hindPaws]) {
    const p = b.getWorldPosition(new V3());
    worst = Math.max(worst, p.y - (treadTop(p.x) + PAW_REST_Y));
  }
  return worst;
}

/** How high his front and back paws are above whatever is under them right now (m). */
function pawGapsNow() {
  const cp = Math.cos(rat.pitch), sp = Math.sin(rat.pitch), base = rat.y + rat.hop - rat.sink;
  const fx = rat.x + FOOT_F * cp, fy = base + FOOT_F * sp;
  const rx = rat.x - FOOT_R * cp, ry = base - FOOT_R * sp;
  return { front: fy - treadTop(fx), back: ry - treadTop(rx) };
}

// The actual solid stairs, with just a hair of rounding at each step's nose so his clearance
// changes smoothly instead of popping as he passes an edge
function solidY(x) {
  const i = Math.floor(x / STEP_D);
  const into = x - i * STEP_D;
  const top = -i * STEP_H;
  return into < 0.025 ? top + STEP_H * (1 - smooth(into / 0.025)) : top;
}

/**
 * Lowest body-center height at which his belly and chin clear the stairs, for a given tilt.
 * Only parts of him that are actually over the stairs (sideways) count.
 */
function clearanceY(x, z, heading, q, chin = true) {
  if (!bodyR) return -Infinity;
  const dx = Math.cos(heading), dz = -Math.sin(heading);
  const cq = Math.cos(q), sq = Math.sin(q);
  const belly = bodyALocal.y - bodyR * 0.85;
  const reach = STAIR_W / 2 + bodyR * 0.6; // a sliver of flank over the edge doesn't count
  let need = -Infinity;
  const probe = (lx, ly) => {
    const along = lx * cq - ly * sq;
    if (Math.abs(z + dz * along) > reach) return;
    need = Math.max(need, solidY(x + dx * along) + 0.003 - (lx * sq + ly * cq));
  };
  const rump = bodyALocal.y - 0.02; // behind his back legs his rump rides higher than his belly
  for (let i = 0; i <= 8; i++) {
    const lx = bodyALocal.x + (bodyBLocal.x - bodyALocal.x) * (i / 8);
    probe(lx, lx < -FOOT_R ? rump : belly);
  }
  if (chin) probe(mouthDist, 0.012); // chin (skipped while his head is lifted level on a step-down)
  return need;
}

// Where he stands next to the open edge before hopping off (body center, on the step)
const EDGE_STAND = 0.05;

// ---------- Walking down the stairs ----------
// He just walks. His body is simulated under real gravity (see stepPhysics / ratphysics.js), so
// stepping down happens by itself: front paws go out over the edge and reach, his weight passes the
// step's nose, he tips and falls onto his front paws, his back end slides over the nose and drops.
// Then he stands a moment on the step (like the pauses in the real clip) and goes on.
let walkV = 0, walkWander = 1, wanderT = 0, walkSpeedSmooth = 0, sniffing = false;
const STRIDE_SCALE = 1.35;       // his walk's stride, exaggerated from the model's walk (see exaggerateClip)
const WALK_STRIDE_SPEED = 0.14 * STRIDE_SCALE; // m/s his paws push back at in the walk cycle at normal playback
const bend = { curl: 0, look: 0 };     // how far his chest curls down (+) or sways up (-) from his hips

function updateWalk(dt) {
  wanderT -= dt;
  // a rat's pace comes in little bursts, now and then a quick pause to sniff
  if (wanderT <= 0) {
    sniffing = walkPhase === 'walk' && Math.random() < 0.18;
    walkWander = sniffing ? 0 : 0.75 + Math.random() * 0.55;
    wanderT = sniffing ? 0.25 + Math.random() * 0.35 : 0.6 + Math.random() * 1.2;
  }
  if (walkPhase !== 'walk') sniffing = false;
  landT += dt;
  const a = actions[CONFIG.walkAnim];
  if (walkPhase === 'settle' && landT > settleFor) walkPhase = 'walk';
  if (walkPhase === 'perch') {
    // sitting up at the edge, looking down; then on he goes
    walkV = 0;
    perchT += dt;
    if (perchT > perchFor) {
      walkPhase = 'walk';
      play(CONFIG.walkAnim, { timeScale: CONFIG.walkAnimSpeed, fade: 0.25 });
    }
  } else {
    // his paws walk him along; a bit more carefully once his front paws are out over a drop
    // (on landing he just keeps going: his legs carry on walking out of the drop)
    const pace = walkPhase === 'walk' ? walkWander : Math.max(walkWander, 0.85); // (no pausing mid-step)
    const goal = CONFIG.walkSpeed * pace * (phys.frontAir > 0.05 ? 0.6 : 1);
    walkV += (goal - walkV) * damp(goal < walkV ? 7 : 5, dt);
    // legs step exactly as fast as he's moving, so planted paws stay put (no skating, no scurrying)
    const v = phys.active ? Math.abs(phys.body.vx) : walkV;
    walkSpeedSmooth += (v - walkSpeedSmooth) * damp(6, dt);
    if (a) a.timeScale = THREE.MathUtils.clamp(walkSpeedSmooth / WALK_STRIDE_SPEED, 0.15, 2.2);
  }
}

// ---------- His body under real gravity (see ratphysics.js) ----------
const phys = {
  body: null, active: false,
  front: { u: 0.11, v: 0 }, hind: { u: 0.02, v: 0 }, nose: null, // measured from the bones each frame
  pts: [], frontAir: 0, hindAir: 0, rearAir: 0, airMax: 0, reach: 0,
};
function setupPhysics() {
  phys.body = new RatBody({ ground: treadTop, stepD: STEP_D, stepH: STEP_H, gyration: 0.07 * CONFIG.ratLength / 0.38 });
  phys.front = { u: FRONT_PAW_X, v: 0 };
  phys.hind = { u: HIND_PAW_X, v: 0 };
  const belly = bodyALocal.y - bodyR * 0.85;
  const rumpU = bodyALocal.x - bodyR * 0.8; // back of his haunches (the capsule end is the middle of them)
  phys.body.belly = { u0: rumpU, u1: bodyBLocal.x, v: belly };
  // his weight is mostly in his haunches: centre of mass a little ahead of his back paws
  phys.com = { u: HIND_PAW_X + (FRONT_PAW_X - HIND_PAW_X) * 0.3, v: bodyALocal.y };
  // contact points: [0] front paws, [1] back paws, [2] nose, then belly and rump
  phys.pts = [
    { u: 0, v: 0, mu: 2, drive: 0 },
    { u: 0, v: 0, mu: 2, drive: 0 },
    { u: mouthDist, v: 0.012, mu: 0, drive: 0 }, // (his head and forelegs brace on whatever his nose meets)
  ];
  for (let i = 0; i <= 8; i++) {
    const u = rumpU + (bodyBLocal.x - rumpU) * (i / 8);
    phys.pts.push({ u, v: u < -FOOT_R ? bodyALocal.y - 0.02 : belly, mu: 0.15, rear: u < HIND_PAW_X });
  }
}

/** Called mid-pose (before the paws get kept out of the concrete): where his paws and nose really are. */
const _pl = new V3();
function measurePaws(dt) {
  if (!phys.active) return;
  const k = dt ? damp(12, dt) : 1;
  const meas = (bones, out) => {
    if (!bones.length) return;
    let u = 0, v = Infinity;
    for (const b of bones) { ratPitch.worldToLocal(b.getWorldPosition(_pl)); u += _pl.x; v = Math.min(v, _pl.y); }
    u /= bones.length;
    out.u += (u - out.u) * k;
    // a paw reaching down (the reach/hang poses) touches sooner; a paw lifted mid-stride still
    // counts as standing (his leg would just straighten), so it never props him up or tips him
    out.v += (Math.min(0, v - PAW_REST_Y) - out.v) * k;
  };
  meas(rig.frontPaws, phys.front);
  meas(rig.hindPaws, phys.hind);
  if (noseTip) {
    ratPitch.worldToLocal(noseTip.getWorldPosition(_pl));
    phys.nose = phys.nose || { u: _pl.x, v: _pl.y };
    phys.nose.u += (_pl.x - phys.nose.u) * k;
    phys.nose.v += (_pl.y - 0.006 - phys.nose.v) * k;
  }
}

const _rp = { x: 0, y: 0, pitch: 0 };
function stepPhysics(dt) {
  const B = phys.body;
  if (!phys.active) {
    B.place(rat.x, rat.y, rat.pitch, phys.com);
    phys.active = true;
    phys.frontAir = phys.hindAir = phys.airMax = 0;
  }
  const P = phys.pts;
  // careful near the next edge: if his back end hasn't come down yet, he creeps until it does
  // (he's nearly as long as a step, so he waits for his haunches before reaching over again)
  const cq = Math.cos(rat.pitch);
  const frontX = rat.x + phys.front.u * cq;
  const toEdge = Math.ceil(frontX / STEP_D) * STEP_D - frontX;
  const rearUp = rat.pitch < -0.25 || phys.rearAir > 0.05;
  const creep = rearUp && phys.frontAir === 0 && toEdge < 0.04 ? 0.7 : 1;
  // at the edge (level, after walking a bit off the last landing): he sits up for a moment
  const edgeI = Math.ceil(frontX / STEP_D);
  if ((walkPhase === 'walk' || walkPhase === 'settle') && !rearUp && phys.frontAir === 0 && toEdge < 0.035 && landT > 0.2 && perchedAt !== edgeI) {
    perchedAt = edgeI;
    if (Math.random() < 0.35) { // (only now and then; mostly he just keeps going)
      walkPhase = 'perch';
      perchT = 0;
      perchFor = 0.5 + Math.random() * 0.7;
      play('idle2', { fade: 0.25 });
    }
  }
  // front paws down on the lower step, back end still up on the nose: he scrambles on through
  const scramble = phys.frontAir === 0 && rearUp && rat.pitch < -0.12;
  const drive = walkPhase === 'perch' ? 0 : scramble ? Math.max(walkV, 0.32) : walkV * creep;
  // (a front paw swung back mid-stride is about to step forward again: his support stays out in front)
  P[0].u = Math.max(phys.front.u, FRONT_PAW_X * 0.95); P[0].v = phys.front.v; P[0].drive = drive;
  P[1].u = phys.hind.u; P[1].v = phys.hind.v; P[1].drive = drive;
  if (phys.nose) { P[2].u = phys.nose.u; P[2].v = phys.nose.v; }
  // front paws down, back end still up on the nose: his back legs push him on over it
  B.bellyDrive = scramble && walkPhase !== 'perch' ? 0.32 : 0;
  // ...his haunches still on the step above get shoved along by his back feet too
  for (let i = 3; i < P.length; i++) if (P[i].rear) {
    if (B.bellyDrive) { P[i].drive = B.bellyDrive; P[i].mu = 0.6; } else { delete P[i].drive; P[i].mu = 0.15; }
  }
  // front paws planted, back end in the air: his hind legs swing down for the step
  // (only once his haunches are off the step: pushing them down while they're on it just pins them)
  B.levelAssist = phys.frontAir === 0 && phys.rearAir > 0.02 && rat.pitch < -0.1 ? 120 : 0;
  if (dt) B.step(dt, P);
  B.root(_rp);
  rat.x = _rp.x; rat.y = _rp.y; rat.pitch = _rp.pitch;

  // which paws are down, and for how long they've been off the ground
  if (P[0].touch && phys.frontAir > 0.12) phys.frontLanded = true; // front paws just came down after a drop
  phys.frontAir = P[0].touch ? 0 : phys.frontAir + dt;
  // his back end (back paws or haunches) on the ground?
  let rear = P[1].touch;
  for (let i = 3; i < P.length; i++) if (P[i].touch && P[i].u < phys.hind.u) rear = true;
  phys.rearAir = rear ? 0 : phys.rearAir + dt;
  if (P[1].touch) {
    // back paws coming down onto a step after being up: that's a landing
    if (phys.hindAir > 0.1 && walkPhase !== 'settle' && phys.frontAir < 0.2 && Math.abs(rat.pitch) < 0.4) {
      walkPhase = 'settle'; // (just the landing squash; his legs keep walking)
      landT = 0;
      settleFor = 0.3;
      walkV = Math.max(walkV, Math.min(0.25, Math.abs(phys.body.vx))); // carries the drop's momentum
    }
    phys.hindAir = 0;
  } else phys.hindAir += dt;
  if (walkPhase !== 'settle' && walkPhase !== 'perch') walkPhase = P[0].touch && P[1].touch && Math.abs(rat.pitch) < 0.15 ? 'walk' : 'step';
}
let walkPhase = 'walk';
let landT = 9;              // seconds since he last landed (for the squash)
let settleFor = 0.6;        // seconds of landing squash
let perchT = 0, perchFor = 0.8, perchedAt = -1; // sitting up at an edge before going over
let leanAmt = 0;            // 0..1 how far his front legs are reaching (drives the reach pose)
const drop = { t: 0, lower: 0 };
const LOOK_DOWN = 0.35;     // radians: head curls down while he reaches over an edge
const REACH_SHOULDERS = 0.8; // radians: shoulders curl down toward the lower step while reaching

// --- held leg poses: front legs reaching forward/down, back legs stretched down ---
// When a pair of paws is out over a drop, those legs stop walking and hold a reach instead.
// The poses are single frames taken from the run animation (where the legs extend furthest).
const legPose = { front: null, hind: null, wFront: 0, wHind: 0, tTuck: 0, tReach: 0, tPush: 0, hindDur: 1, bound: 0, fStride: 0 };
const LEG_OVERRIDE = 30; // high weight so the held pose wins over the walk cycle for those legs

function buildLegPoses(runClip, ratScene) {
  if (!runClip) return;
  let root04 = null, hipsB = null, chestB = null;
  ratScene.traverse((o) => {
    if (!o.isBone) return;
    if (/^Root_04/.test(o.name)) root04 = o;
    if (/^Hips_/.test(o.name)) hipsB = o;
    if (/^Spine006_/.test(o.name)) chestB = o;
  });
  if (!root04 || !hipsB || !chestB) return;
  // his forward and up directions, in the paw controls' parent space
  const fwd = chestB.position.clone().sub(hipsB.position).normalize();
  ratScene.updateMatrixWorld(true);
  const up = new V3(0, 1, 0).applyQuaternion(root04.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();

  const trackFor = (re) => runClip.tracks.filter((t) => re.test(t.name.split('.')[0]));
  const posTracks = (re) => runClip.tracks.filter((t) => re.test(t.name.split('.')[0]) && t.name.endsWith('.position'));
  const bestTime = (re, score) => {
    const tr = posTracks(re);
    if (!tr.length) return runClip.duration * 0.25;
    let best = 0, bestScore = -Infinity;
    for (let i = 0; i <= 40; i++) {
      const t = (runClip.duration * i) / 40;
      let sc = 0;
      for (const k of tr) {
        const v = k.createInterpolant().evaluate(t);
        sc += score(new V3(v[0], v[1], v[2]));
      }
      if (sc > bestScore) { bestScore = sc; best = t; }
    }
    return best;
  };
  const frozen = (name, re, t) => {
    const tracks = trackFor(re).map((k) => {
      const v = Array.from(k.createInterpolant().evaluate(t));
      return new k.constructor(k.name, [0], v);
    });
    const a = mixer.clipAction(new THREE.AnimationClip(name, 1, tracks));
    a.setEffectiveWeight(0);
    a.play();
    return a;
  };
  const FRONT = /^Fore/, HIND = /^Leg/;
  // front legs: a clip we scrub by hand, from paws tucked back to paws reaching forward and down
  legPose.tReach = bestTime(/^ForeHandik/, (p) => p.dot(fwd) - 0.3 * p.dot(up));
  legPose.tTuck = bestTime(/^ForeHandik/, (p) => -p.dot(fwd));
  const fa = mixer.clipAction(new THREE.AnimationClip('reachFront', runClip.duration, trackFor(FRONT)));
  fa.setEffectiveWeight(0);
  fa.play();
  fa.paused = true;
  legPose.front = fa;
  // back legs: one bounding stride from the gallop, scrubbed by hand as he goes over an edge:
  // push off (paws kicked back), swing forward under him, reach down for the landing
  const ha = mixer.clipAction(new THREE.AnimationClip('boundHind', runClip.duration, trackFor(HIND)));
  ha.setEffectiveWeight(0);
  ha.play();
  ha.paused = true;
  legPose.hind = ha;
  legPose.hindDur = runClip.duration;
  legPose.tPush = bestTime(/^LegFootik/, (p) => -p.dot(fwd) - 0.3 * p.dot(up)); // kicked back and down
}

/**
 * A copy of a looping clip with its motion exaggerated: every track swings `k` times as far from
 * its average over the loop (positions and scales scaled, rotations extrapolated). The head, tail
 * and face are left alone. Used to give him a longer stride than the model's walk has.
 */
function exaggerateClip(clip, name, k) {
  const skip = /Head|Tail|Ear|Eye|Lip|Jaw|Nose|Tongue|Face|Whisk|Mouth|Neck/i;
  const tracks = clip.tracks.map((t) => {
    if (skip.test(t.name.split('.')[0])) return t.clone();
    const n = t.getValueSize(), m = t.times.length, v = t.values;
    const out = new Float32Array(v.length);
    if (t.name.endsWith('.quaternion')) {
      const mean = new THREE.Quaternion(0, 0, 0, 0), q = new THREE.Quaternion(), first = new THREE.Quaternion().fromArray(v, 0);
      for (let i = 0; i < m; i++) {
        q.fromArray(v, i * 4);
        const sgn = q.dot(first) < 0 ? -1 : 1;
        mean.x += q.x * sgn; mean.y += q.y * sgn; mean.z += q.z * sgn; mean.w += q.w * sgn;
      }
      mean.normalize();
      for (let i = 0; i < m; i++) {
        q.fromArray(v, i * 4);
        new THREE.Quaternion().copy(mean).slerp(q, k).toArray(out, i * 4);
      }
    } else {
      for (let c = 0; c < n; c++) {
        let mean = 0;
        for (let i = 0; i < m; i++) mean += v[i * n + c];
        mean /= m;
        for (let i = 0; i < m; i++) out[i * n + c] = mean + (v[i * n + c] - mean) * k;
      }
    }
    return new t.constructor(t.name, t.times.slice(), out);
  });
  return new THREE.AnimationClip(name, clip.duration, tracks);
}

/** How far his front and back paws are hanging above the step under them (m), from the paw bones. */
function legGaps() {
  // only paws just past a step's edge count (an ordinary paw lift mid-stride doesn't)
  const gap = (bones) => bones.reduce((m, b) => {
    const p = b.getWorldPosition(new V3());
    const pastEdge = p.x - Math.floor(p.x / STEP_D) * STEP_D;
    return pastEdge < 0.12 ? Math.max(m, p.y - (treadTop(p.x) + PAW_REST_Y)) : m;
  }, 0);
  return { front: gap(rig.frontPaws), hind: gap(rig.hindPaws) };
}

// --- bending the rig: chest down, spine arched between hips and chest, stretch bone stretched ---
const rig = { hips: null, chest: null, head: null, neck: null, front: [], frontPaws: [], hindPaws: [], spine: [], stretch: null, stretchEnd: null, rest: [] };
const _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _ax = new V3(), _fw = new V3(), _hw = new V3(), _bw = new V3(), _a = new V3(), _b = new V3();

function rotateBoneWorld(bone, q) {
  bone.parent.getWorldQuaternion(_q1);
  _q2.copy(_q1).invert().multiply(q).multiply(_q1); // world rotation -> parent space
  bone.quaternion.premultiply(_q2);
  bone.updateMatrixWorld(true);
}
// ---------- Dragging: his head turns toward the slice and tugs at its weight ----------
// The slice is on his camera side, held by a corner of the crust, so he pulls with his head turned
// toward it. Each stride he gives it a tug; harder when it's hanging over an edge or catching.
let headYaw = 0;
function turnHead(dt, walking) {
  if (!rig.head) return;
  let goal = 0;
  if (pizza?.held && state === 'walk') {
    const a = actions[CONFIG.walkAnim];
    const phase = a && a.isRunning() ? (a.time / a.getClip().duration) % 1 : 0;
    const tug = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);   // once per stride
    const pulling = walking && walkSpeedSmooth > 0.03 ? 1 : 0.4;
    // the slice hanging down over an edge pulls harder
    const hang = THREE.MathUtils.clamp((mouthWorld(_hy).y - pizza.tip().y - 0.03) / 0.12, 0, 1);
    goal = -(0.24 + 0.12 * hang + (0.13 + 0.07 * hang) * tug * pulling); // (negative: toward +z, the slice)
  }
  headYaw += (goal - headYaw) * (dt ? damp(goal ? 9 : 5, dt) : 1);
  // jaw open a little around the crust while he's holding it
  jawOpen += ((pizza?.held ? 0.22 : 0) - jawOpen) * (dt ? damp(8, dt) : 1);
  if (Math.abs(headYaw) >= 0.002) applyHeadYaw();
  if (jawBone && noseTip && jawOpen > 0.005) {
    rig.head.getWorldPosition(_hb); noseTip.getWorldPosition(_hh);
    const fwd = _hh.sub(_hb).normalize();
    const axis = _hu.set(0, 1, 0).cross(fwd).normalize();      // turning about this tips his chin down
    rotateBoneWorld(jawBone, _hq.setFromAxisAngle(axis, jawOpen));
  }
}
let jawOpen = 0;
function applyHeadYaw() {
  ratPitch.getWorldQuaternion(_q0);
  const up = _hu.set(0, 1, 0).applyQuaternion(_q0);
  const base = (rig.neck || rig.chest).getWorldPosition(_hb);
  const q = _hq.setFromAxisAngle(up, headYaw);
  if (rig.neck) rotateBoneWorld(rig.neck, _hq2.setFromAxisAngle(up, headYaw * 0.5));
  moveBoneWorld(rig.head, rig.head.getWorldPosition(_hh).sub(base).applyQuaternion(q).add(base));
  rotateBoneWorld(rig.head, q);
}
const _hy = new V3(), _hu = new V3(), _hb = new V3(), _hh = new V3(), _hq = new THREE.Quaternion(), _hq2 = new THREE.Quaternion();

// ---------- His tail: a springy chain on top of the animation ----------
// Each segment lags behind where the animation points it (so it swings and flicks when he lurches,
// drops or lands), droops under gravity toward the tip, and swishes side to side more the faster
// he goes. It never pokes into the stairs.
const tail = { bones: [], cur: [], vel: [], t: 0 };
function setupTail(root) {
  const byName = (re) => { let f = null; root.traverse((o) => { if (!f && o.isBone && re.test(o.name)) f = o; }); return f; };
  let b = byName(/^Tail\.?001_/); // (the loader drops the dots from bone names)
  while (b) {
    tail.bones.push(b);
    // next segment of the main chain: Tail.005, then .006 ... .013, then its end marker
    b = b.children.find((c) => c.isBone && /^Tail\.?0(0[5-9]|1[0-3])_/.test(c.name))
      || b.children.find((c) => c.isBone && /^Tail\.?013_end/.test(c.name) && tail.bones.length > 1);
  }
}
const _ta = new V3(), _tb = new V3(), _td = new V3(), _tt = new V3(), _tl = new V3(), _tq = new THREE.Quaternion();
const _up = new V3(0, 1, 0);
function updateTail(dt, speed) {
  const B = tail.bones, n = B.length;
  if (n < 3) return;
  tail.t += dt;
  const sway = 0.12 + 0.5 * THREE.MathUtils.clamp(speed / 0.4, 0, 1); // swish amount
  const w = 6 + 8 * THREE.MathUtils.clamp(speed / 0.4, 0, 1);        // swish speed
  for (let i = 0; i < n - 1; i++) {
    const b = B[i], next = B[i + 1];
    b.getWorldPosition(_ta);
    next.getWorldPosition(_tb);
    const len = _ta.distanceTo(_tb);
    if (len < 1e-5) continue;
    _td.subVectors(_tb, _ta).divideScalar(len);               // where the animation points it
    const u = (i + 1) / (n - 1);                               // 0 at his rump .. 1 at the tip
    _tl.crossVectors(_td, _up);
    if (_tl.lengthSq() > 1e-6) _tl.normalize();
    _tt.copy(_td)
      .addScaledVector(_up, -0.45 * u * u)                     // droops, more toward the tip
      .addScaledVector(_tl, sway * u * Math.sin(w * tail.t - 5 * u)) // swish travelling down it
      .normalize();
    // the lagging direction springs toward that (a little bouncy)
    if (!tail.cur[i] || !dt) { tail.cur[i] = _tt.clone(); tail.vel[i] = new V3(); }
    const c = tail.cur[i], v = tail.vel[i];
    const k = 90 - 40 * u, damping = 9 - 4 * u;                // tip is looser than the base
    v.addScaledVector(_tt.clone().sub(c), k * dt).multiplyScalar(Math.exp(-damping * dt));
    c.addScaledVector(v, dt).normalize();
    // keep the tail out of the stairs
    const floor = treadTop(_ta.x + c.x * len) + 0.006;
    if (_ta.y + c.y * len < floor) { c.y += (floor - _ta.y - c.y * len) / len; c.normalize(); v.multiplyScalar(0.5); }
    // turn this segment from where the animation put it to the lagged direction (at most ~45°)
    _tq.setFromUnitVectors(_td, c);
    const ang = 2 * Math.acos(Math.min(1, Math.abs(_tq.w)));
    if (ang > 0.8) _tq.slerp(new THREE.Quaternion(), 1 - 0.8 / ang);
    rotateBoneWorld(b, _tq);
  }
}

function moveBoneWorld(bone, worldPos) {
  bone.position.copy(bone.parent.worldToLocal(_bw.copy(worldPos)));
  bone.updateMatrixWorld(true);
}

// The walk clips don't animate every channel of these bones, so put them back to their rest pose
// each frame before the animation and bending are applied (otherwise the bend would pile up).
function restoreRig() {
  for (const r of rig.rest) { r.b.position.copy(r.p); r.b.quaternion.copy(r.q); r.b.scale.copy(r.s); }
}

// His back as a curve: nearly level by his hips, curling down toward his shoulders.
// `curl` is how far (radians) his shoulders end up turned nose-down relative to his hips.
function applyBend(curl, look = 0) {
  if (!rig.chest || (Math.abs(curl) < 0.002 && Math.abs(look) < 0.002 && !walkingNow)) return;
  ratPitch.getWorldQuaternion(_q0);
  const lateral = new V3(0, 0, 1).applyQuaternion(_q0);
  const forward = new V3(1, 0, 0).applyQuaternion(_q0);
  const up = new V3(0, 1, 0).applyQuaternion(_q0);
  const hips = rig.hips.getWorldPosition(new V3());
  const rel = (p) => { const d = p.clone().sub(hips); return { u: d.dot(forward), v: d.dot(up) }; };

  if (Math.abs(curl) >= 0.002) {
    const chest0 = rig.chest.getWorldPosition(new V3());
    const c0 = rel(chest0);
    const S = Math.max(0.03, c0.u);
    const theta = (s) => -curl * Math.pow(THREE.MathUtils.clamp(s / S, 0, 1), 1.5);
    const along = (s, off) => {           // point at distance s along the curved back, raised by `off`
      let u = 0, v = 0;
      const n = 10, ds = s / n;
      for (let i = 0; i < n; i++) { const t = theta((i + 0.5) * ds); u += Math.cos(t) * ds; v += Math.sin(t) * ds; }
      const t = theta(s);
      return hips.clone().addScaledVector(forward, u - Math.sin(t) * off).addScaledVector(up, v + Math.cos(t) * off);
    };
    // where everything sits on the straight back, before bending
    const spineRest = rig.spine.map((b) => ({ b, r: rel(b.getWorldPosition(new V3())) }));
    const frontRest = rig.front.map((b) => b.getWorldPosition(new V3()));

    // spine bones (all children of the first): placed on the curve and turned along it
    let parentTurn = 0;
    spineRest.forEach(({ b, r }, i) => {
      moveBoneWorld(b, along(r.u, r.v));
      const turn = theta(r.u);
      rotateBoneWorld(b, new THREE.Quaternion().setFromAxisAngle(lateral, i === 0 ? turn : turn - parentTurn));
      if (i === 0) parentTurn = turn;
    });
    // chest, head and front paws ride on the end of the curve, turned with it
    const chestTo = along(S, c0.v);
    const q = new THREE.Quaternion().setFromAxisAngle(lateral, theta(S));
    rig.front.forEach((b, i) => {
      moveBoneWorld(b, frontRest[i].clone().sub(chest0).applyQuaternion(q).add(chestTo));
      rotateBoneWorld(b, q);
    });
    // stretch bone: aim its end at where the chest went, and lengthen it to reach
    if (rig.stretch && rig.stretchEnd) {
      rig.stretch.getWorldPosition(_a);
      rig.stretchEnd.getWorldPosition(_b);
      const cur = _b.clone().sub(_a);
      const want = cur.clone().add(chestTo.clone().sub(chest0));
      rotateBoneWorld(rig.stretch, new THREE.Quaternion().setFromUnitVectors(cur.clone().normalize(), want.clone().normalize()));
      rig.stretch.scale.y *= want.length() / cur.length();
      rig.stretch.updateMatrixWorld(true);
    }
  }
  // look down where he's stepping: curl his neck and head down around the base of the neck
  if (rig.head && Math.abs(look) >= 0.002) {
    const base = (rig.neck || rig.chest).getWorldPosition(new V3());
    const ql = new THREE.Quaternion().setFromAxisAngle(lateral, look);
    if (rig.neck) rotateBoneWorld(rig.neck, new THREE.Quaternion().setFromAxisAngle(lateral, look * 0.5));
    moveBoneWorld(rig.head, rig.head.getWorldPosition(new V3()).sub(base).applyQuaternion(ql).add(base));
    rotateBoneWorld(rig.head, ql);
  }
  measurePaws(lastDt); // (physics needs where his paws are before they're nudged out of the concrete)
  // nose never into a step: lift the front of him just enough
  if (noseTip) {
    const n = noseTip.getWorldPosition(new V3());
    const lift = treadTop(n.x) + 0.008 - n.y;
    if (lift > 0) for (const b of rig.front) moveBoneWorld(b, b.getWorldPosition(new V3()).add(new V3(0, lift, 0)));
  }
  // paws: never into a step (they're not stretched, just kept out of the concrete)
  for (const b of [...rig.frontPaws, ...rig.hindPaws]) {
    const p = b.getWorldPosition(new V3());
    const floor = treadTop(p.x) + PAW_REST_Y;
    if (p.y < floor) moveBoneWorld(b, p.setY(floor));
  }
}
let walkingNow = false;
let lastDt = 0;
let PAW_REST_Y = 0.006; // paw controls sit this far above the ground when standing (measured at load)
let FRONT_PAW_X = 0.11; // how far ahead of his body center his front paws are (measured at load)

let HIND_PAW_X = 0.02;  // how far ahead of his body center his back paws are (measured at load)

// Like the real Pizza Rat: he bites one corner of the crust and drags the slice along beside
// and behind him, on the camera side so you can see it. It trails over each edge after him and
// flops down the riser.
const CARRY_ANGLE = 0.35;                                     // slice splayed out a little from his side
const sliceDir = (h, out) => dirOf(h + Math.PI + CARRY_ANGLE, out);      // crust -> tip (backward)
const crustSide = (h, out) => dirOf(h - Math.PI / 2 + CARRY_ANGLE, out); // along the crust, away from him
const BITE_IN = 0.015;  // he bites the crust rim this far in from its corner
let lipCorner = null;    // the corner of his mouth on the slice's side (found at load)
let lipFar = null;       // ...and the other corner
let jawBone = null;      // his lower jaw (opened a little around the crust)
/** Which way his face points (flat), so the crust he's biting turns with his head. */
let holdHeading = 0;
function updateHoldHeading(dt) {
  let h = rat.heading;
  if (rig.head && noseTip) {
    rig.head.getWorldPosition(_hA); noseTip.getWorldPosition(_hB);
    const dx = _hB.x - _hA.x, dz = _hB.z - _hA.z, dy = _hB.y - _hA.y;
    const flat = Math.hypot(dx, dz), k = THREE.MathUtils.clamp(flat / (Math.hypot(flat, dy) * 0.6 + 1e-6) - 0.5, 0, 1);
    // (pointing nearly straight down his face has no clear heading, so lean on his body's then)
    if (flat > 1e-4) h = lerpAngle(rat.heading, headingOf(dx, dz), k);
  }
  holdHeading = !dt ? h : lerpAngle(holdHeading, h, damp(14, dt));
}
const _hA = new V3(), _hB = new V3();
/** Where the middle of the crust's end goes, so the rim runs across the front of his mouth,
 *  between his teeth, with the crust's corner just past the middle and the rest out the side. */
function holdWorld(out) {
  if (lipCorner && lipFar && noseTip) {
    lipCorner.getWorldPosition(_hA); lipFar.getWorldPosition(_hB); noseTip.getWorldPosition(_hN);
    out.addVectors(_hA, _hB).multiplyScalar(0.5);               // middle of his mouth
    const lipY = out.y;
    out.lerp(_hN, 0.5);                                         // forward, to his front teeth
    out.y = lipY + 0.005;                                       // up between his teeth
  } else if (lipCorner) lipCorner.getWorldPosition(out);
  else mouthWorld(out);
  out.y -= (pizza?.crustTop ?? 0.02) * 0.5;                    // rim's middle between his teeth
  crustSide(holdHeading, _hs);
  out.addScaledVector(_hs, -0.02);                             // the (rounded) corner past the middle
  return out.addScaledVector(_hs, pizza?.crustNear ?? 0.06);   // -> middle of the crust's end
}
const _hN = new V3();
const _hs = new V3(), _hf = new V3();

// His body's two ends in the world: haunches (rigid with his hips) and the front of his body
// (follows his chest, which reaches down when he steps)
const _chestW = new V3();
function bodyEnds(a, b) {
  ratPitch.localToWorld(a.copy(bodyALocal));
  ratPitch.localToWorld(b.copy(bodyBLocal));
  if (rig.chest && Math.abs(bend.curl) > 0.002) rig.chest.getWorldPosition(b); // follows his curved back
}

function updatePizza(dt) {
  bodyEnds(_bodyA, _bodyB);
  pizza.setBody(_bodyA, _bodyB, bodyR);
  updateHoldHeading(dt);
  pizza.update(dt, holdWorld(_mouth), sliceDir(holdHeading, _sd));
}

const _sd = new V3();
function mouthWorld(out) {
  if (noseTip) noseTip.getWorldPosition(out);
  else ratRoot.localToWorld(out.set(mouthDist, 0.03, 0));
  out.y -= 0.012;
  return out;
}

// =========================================================================
// THE STORY — a little state machine
//   walk    -> dragging the pizza down forever
//   startle -> FLASH! he freezes and drops the slice
//   flee    -> bolts for the open edge and hops over
//   hide    -> clinging below the lip; peeks over now and then
//   return  -> flap closed: climbs back, grabs the slice, keeps going
// =========================================================================
const rat = { x: 0.1, y: 0, z: LANE_Z, heading: 0, target: 0, sink: 0, hop: 0, pitch: 0 };
let state = 'none';
let stateT = 0;
let peekT = 0, peeking = false;
let returnPhase = 'jump';
let fleePhase = 'run', phaseT = 0;
const approach = new V3();
let grabHeading = 0;

const HIDE_SINK = 0.12;   // he hides on a ledge this far below the step
const PEEK_REAR = 0.75;   // how far he rears up on his hind legs to peek (radians)
const JUMP_CROUCH = 0.14, JUMP_LEAP = 0.38; // seconds: crouch on the ledge, then leap up

function enter(next) {
  state = next;
  stateT = 0;
  switch (next) {
    case 'walk':
      walkV = 0.03;
      walkPhase = 'walk';
      phys.active = false;
      play(CONFIG.walkAnim, { timeScale: CONFIG.walkAnimSpeed, fade: 0.3 });
      break;
    case 'startle':
      sound.shutter();
      sound.squeak();
      fx.flash = 1.25;
      fx.shake = 1;
      addViews(40000 + Math.random() * 60000);
      play('idle1', { fade: 0.08, timeScale: 0.25 });
      break;
    case 'flee':
      play('runStart', { loop: false, fade: 0.1, timeScale: 1.2 });
      sound.scurry(0.7);
      fleePhase = 'run';
      break;
    case 'hide':
      play('idle2', { fade: 0.4 });
      peekT = 0;
      peeking = false;
      break;
    case 'return':
      play('idle3', { fade: 0.3 });
      returnPhase = 'jump';
      phaseT = 0;
      break;
  }
}

// Where to stand to pick the slice back up (it may have slid since he dropped it).
// He comes up behind the tip already facing down the stairs, so after the grab he just
// keeps walking instead of spinning around with the slice.
function updateApproach() {
  // come up to the crust end, facing along the slice (so it sticks out in front of him again)
  const crust = pizza.holdPoint();
  const toTip = pizza.direction(_w).negate();        // crust -> tip
  grabHeading = THREE.MathUtils.clamp(lerpAngle(0, headingOf(toTip.x, toTip.z) - Math.PI - CARRY_ANGLE, 1), -0.8, 0.8);
  // his mouth goes to the corner of the crust (on the near side of the slice)
  approach.copy(crust).addScaledVector(crustSide(grabHeading, _v), -(pizza.crustNear - BITE_IN));
  approach.addScaledVector(dirOf(grabHeading, _v), -mouthDist);
  approach.y = 0;
  approach.z = Math.max(approach.z, EDGE_Z + 0.08);
  // keep his haunches on the same step (he's longer than a step); the slice slides into his mouth
  const minX = Math.floor(approach.x / STEP_D) * STEP_D - bodyALocal.x * Math.cos(grabHeading) + 0.012;
  if (approach.x < minX) approach.x = minX;
}

const _v = new V3(), _w = new V3(), _mouth = new V3();

function updateRat(dt, tagOn) {
  stateT += dt;
  let turnRate = 6;

  switch (state) {
    case 'walk': {
      updateWalk(dt);
      rat.target = 0;
      rat.z += (LANE_Z - rat.z) * damp(1.5, dt);
      if (tagOn && (walkPhase === 'walk' || walkPhase === 'settle' || walkPhase === 'perch')) enter('startle'); // mid-slide? finish the step first
      break;
    }
    case 'startle': {
      if (pizza.held && stateT > 0.06) {
        // he flings it a little as he flinches
        pizza.drop(dirOf(rat.heading, _v).multiplyScalar(0.2).setY(0.12));
      }
      rat.target = -0.6; // whips his head toward the camera
      turnRate = 14;
      rat.hop = 0.035 * Math.sin(Math.PI * Math.min(stateT / 0.3, 1));
      if (stateT > 0.75) enter('flee');
      break;
    }
    case 'flee': {
      rat.hop = 0;
      turnRate = 16;
      if (stateT > 0.25 && fleePhase === 'run' && currentAction !== actions.run1) play('run1', { timeScale: 1.3, fade: 0.1 });
      const standZ = EDGE_Z + EDGE_STAND;
      // drift to the middle of the step he's on, so he hides (and later jumps back) on one step,
      // never straddling an edge
      if (fleePhase !== 'drop') {
        // haunches on this step, nose out over the next (lower) one: he is longer than a step
        const safeX = Math.floor(rat.x / STEP_D) * STEP_D - bodyALocal.x + 0.03;
        rat.x += (safeX - rat.x) * damp(5, dt);
      }
      if (fleePhase === 'run') {
        // dash to the open edge
        rat.target = Math.PI / 2;
        if (angleDiff(rat.heading, rat.target) < 0.7) rat.z = Math.max(standZ, rat.z - CONFIG.runSpeed * dt);
        if (rat.z <= standZ + 1e-4) fleePhase = 'turn';
      } else if (fleePhase === 'turn') {
        // swing parallel to the edge so his whole body can drop past it
        rat.target = 0;
        if (angleDiff(rat.heading, 0) < 0.15) { fleePhase = 'drop'; phaseT = 0; }
      } else {
        // hop sideways off the edge, then drop below the lip
        rat.target = 0;
        phaseT += dt;
        const t = Math.min(phaseT / 0.4, 1);
        rat.z = standZ + (HIDE_Z - standZ) * smooth(Math.min(t * 1.7, 1));
        rat.sink = HIDE_SINK * smooth(THREE.MathUtils.clamp((t - 0.35) / 0.65, 0, 1)) - 0.02 * Math.sin(Math.PI * Math.min(t / 0.45, 1));
        rat.pitch = -0.3 * Math.sin(Math.PI * t);
        if (t >= 1) { rat.sink = HIDE_SINK; enter('hide'); }
      }
      break;
    }
    case 'hide': {
      // standing on the ledge below the lip; to peek he rears up on his hind legs
      peekT += dt;
      if (!peeking && peekT > CONFIG.peekEvery) { peeking = true; peekT = 0; sound.sniff(); }
      if (peeking && peekT > 1.8) { peeking = false; peekT = 0; }
      rat.sink += (HIDE_SINK - rat.sink) * damp(10, dt);
      rat.z += (HIDE_Z - rat.z) * damp(6, dt);
      rat.pitch += ((peeking ? PEEK_REAR : 0) - rat.pitch) * damp(peeking ? 6 : 4, dt);
      rat.hop = FOOT_R * Math.sin(Math.max(0, rat.pitch)); // pivot on his back paws, not his middle
      rat.target = peeking ? -0.25 : 0; // peeks toward his pizza
      if (!tagOn && stateT > CONFIG.minHideTime) enter('return');
      break;
    }
    case 'return': {
      if (tagOn) {
        // still climbing out? just duck back down. Already out in the open? caught again!
        if (returnPhase === 'jump' && phaseT < JUMP_CROUCH) { state = 'hide'; stateT = 0; peeking = false; peekT = 0; play('idle2', { fade: 0.3 }); }
        else enter('startle');
        break;
      }
      // he only wants the pizza once the slice has stopped sliding around
      if (returnPhase !== 'grab') updateApproach();
      if (returnPhase === 'jump') {
        // crouch on the ledge, then leap up and over onto the step
        rat.target = 0;
        rat.hop = 0;
        phaseT += dt;
        if (phaseT < JUMP_CROUCH) {
          rat.pitch += (0.15 - rat.pitch) * damp(12, dt);
          rat.sink = HIDE_SINK + 0.006 * Math.sin((Math.PI / 2) * (phaseT / JUMP_CROUCH));
        } else {
          if (currentAction !== actions.runStart) play('runStart', { loop: false, fade: 0.06, timeScale: 1.4 });
          const u = Math.min((phaseT - JUMP_CROUCH) / JUMP_LEAP, 1);
          // up first (clearing the lip), then over onto the step
          rat.sink = HIDE_SINK * (1 - smooth(Math.min(u / 0.5, 1))) - 0.03 * Math.sin(Math.PI * Math.min(u / 0.75, 1));
          rat.z = HIDE_Z + (EDGE_Z + EDGE_STAND - HIDE_Z) * smooth(THREE.MathUtils.clamp((u - 0.35) / 0.65, 0, 1));
          rat.pitch = 0.45 * Math.sin(Math.PI * u);
          if (u >= 1) {
            rat.sink = 0;
            returnPhase = 'sneak';
            play('walk_A1', { timeScale: 0.7 });
          }
        }
      } else if (returnPhase === 'sneak') {
        _v.set(approach.x - rat.x, 0, approach.z - rat.z);
        const dist = _v.length();
        rat.target = headingOf(_v.x, _v.z);
        if (angleDiff(rat.heading, rat.target) < 0.5 && dist > 0) {
          const step = Math.min(dist, 0.16 * dt);
          rat.x += (_v.x / dist) * step;
          rat.z += (_v.z / dist) * step;
        }
        if (dist < 0.012) { returnPhase = 'grab'; play('idle3', { fade: 0.2 }); }
      } else if (returnPhase === 'grab') {
        rat.target = grabHeading;
        if (angleDiff(rat.heading, rat.target) < 0.08) {
          pizza.grab(); // chomp
          enter('walk');
        }
      }
      break;
    }
  }

  rat.heading = lerpAngle(rat.heading, rat.target, damp(turnRate, dt));

  // On the steps, his height and tilt come from his paws (see stairPose). Off the edge
  // (dropping, hiding, climbing back) he hangs at the lip and each phase sets his tilt.
  const offEdge = state === 'hide' || (state === 'flee' && fleePhase === 'drop') ||
    (state === 'return' && returnPhase === 'jump');
  const walking = state === 'walk' && Math.abs(lerpAngle(0, rat.heading, 1)) < 0.35;
  let bendGoal = 0;
  let lookGoal2 = 0;
  if (walking && phys.body) {
    stepPhysics(dt);
    const out = THREE.MathUtils.clamp(phys.frontAir / 0.15, 0, 1); // front paws out over a drop
    leanAmt += (out - leanAmt) * (dt ? damp(10, dt) : 1);
    if (walkPhase === 'settle') {
      // landed: absorbing it with a squash and his back flexing, springing straight
      const sq = Math.exp(-landT * 9) * Math.sin(Math.min(landT / 0.12, 1) * Math.PI);
      rat.y -= 0.01 * sq;
      bendGoal = -0.25 * Math.exp(-landT * 6) * Math.cos(landT * 14);
    } else if (phys.frontAir > 0 && rat.pitch > -0.5) {
      // reaching over the edge: shoulders and head curl down toward the step below
      bendGoal = REACH_SHOULDERS * leanAmt;
      lookGoal2 = -LOOK_DOWN * leanAmt;
    } else if (rat.pitch < -0.3 && phys.frontAir === 0) {
      // front paws down, back end still up: shoulders level out a touch, so his back sways
      bendGoal = Math.max(-0.15, (rat.pitch + 0.3) * 0.3);
    }
    // a quick sniff at the step when he pauses
    if (sniffing && walkPhase === 'walk') lookGoal2 = -0.3;
    // tipped steeply nose-down: he lifts his head to land on his paws, not his face
    if (walkPhase !== 'settle' && rat.pitch < -0.4) lookGoal2 = Math.min(0.8, (-rat.pitch - 0.4) * 1.1);
  } else if ((phys.active = false) || offEdge) {
    // dropping to, standing on, or jumping up from the ledge beside his step (sink/hop set by the phase)
    rat.y += (treadTop(rat.x) - rat.y) * (dt ? damp(12, dt) : 1);
  } else {
    const p = stairPose(rat.x, rat.z, rat.heading);
    rat.pitch += (p.pitch - rat.pitch) * (dt ? damp(18, dt) : 1);
    rat.y = !dt ? p.y : rat.y + (p.y - rat.y) * damp(p.y > rat.y ? 40 : 30, dt); // the safety net below stops any dip
  }
  bend.curl += (bendGoal - bend.curl) * (dt ? damp(10, dt) : 1);
  bend.look += (lookGoal2 - bend.look) * (dt ? damp(8, dt) : 1);

  // Safety net: with his actual tilt, his belly, rump and chin stay above the stairs
  if (!phys.active && bodyR && Math.abs(rat.z) < STAIR_W / 2 + bodyR) {
    const need = clearanceY(rat.x, rat.z, rat.heading, rat.pitch);
    const cur = rat.y + rat.hop - rat.sink;
    // walking: correct at once; turning on the spot etc.: rise quickly instead of popping
    if (cur < need) rat.y += walking || !dt ? need - cur : Math.min(need - cur, 2.5 * dt);
  }

  ratRoot.position.set(rat.x, rat.y + rat.hop - rat.sink, rat.z);
  ratRoot.rotation.y = rat.heading;
  ratPitch.rotation.z = rat.pitch;
  restoreRig();
  mixer.update(dt);
  ratRoot.updateMatrixWorld(true);
  walkingNow = walking;
  lastDt = dt;
  applyBend(bend.curl, bend.look);
  turnHead(dt, walking);
  updateTail(dt, phys.active ? Math.abs(phys.body.vx) + Math.abs(phys.body.vy) * 0.5 : state === 'flee' || state === 'return' ? 0.4 : 0.1);
  // legs: front legs reach out further the further he leans; back legs hang while he slides/drops
  // front legs: reach out and down while over a drop; when they hit the step, one stride from the
  // gallop (plant, push back, swing through) so he lands running, then the walk takes over
  if (phys.frontLanded) { phys.frontLanded = false; if (walking) legPose.fStride = 1e-4; }
  if (legPose.fStride > 0) { legPose.fStride += dt / 0.6; if (legPose.fStride >= 1 || !walking) legPose.fStride = 0; }
  const goalF = !walking ? 0 : legPose.fStride > 0 ? 1 : THREE.MathUtils.clamp(leanAmt * 2.5, 0, 1);
  // back legs: from the moment he tips over an edge they do one bound (push off, swing, reach,
  // land), timed to take him through the drop; then they go back to walking
  const cqb = Math.cos(rat.pitch);
  const overEdge = Math.floor((rat.x + phys.front.u * cqb) / STEP_D) > Math.floor((rat.x + phys.hind.u * cqb) / STEP_D);
  const bounding = walking && walkPhase === 'step' && (overEdge || rat.pitch < -0.25);
  if (bounding) legPose.bound = Math.min(1, legPose.bound + dt / 0.75);
  else if (walkPhase !== 'step') legPose.bound = 0;
  const goalH = bounding || (walking && walkPhase === 'settle' && landT < 0.12) ? 1 : 0;
  if (legPose.hind && legPose.hind.paused) {
    legPose.hind.time = (legPose.tPush + legPose.bound * 0.95 * legPose.hindDur) % legPose.hindDur;
  }
  if (legPose.front) legPose.front.time = legPose.fStride > 0
    ? (legPose.tReach + legPose.fStride * 0.9 * legPose.hindDur) % legPose.hindDur
    : THREE.MathUtils.lerp(legPose.tTuck, legPose.tReach, leanAmt);
  legPose.wFront += (goalF - legPose.wFront) * (dt ? damp(8, dt) : 1);
  legPose.wHind += (goalH - legPose.wHind) * (dt ? damp(goalH ? 16 : 14, dt) : 1); // (back to walking quickly)
  legPose.front?.setEffectiveWeight(LEG_OVERRIDE * legPose.wFront);
  legPose.hind?.setEffectiveWeight(LEG_OVERRIDE * legPose.wHind);
}

// =========================================================================
// CAMERA + EFFECTS
// =========================================================================
const camFocus = new V3(0.2, 0, LANE_Z);
const camOffset = new V3(0.12, 0.3, 0.68);
const camOffsetGoal = new V3();
const LOOK = new V3(0, -0.05, -0.2); // aim a little past him so the station shows behind
const lookGoal = new V3();
const fx = { flash: 0, shake: 0 };

// The staircase's average slope. The camera glides down this line at a steady rate instead of
// following each hop, so he never drops out of the bottom of the frame on a step.
const slopeY = (x) => -(x / STEP_D - 0.5) * STEP_H;

function updateCamera(dt) {
  if (!pizza || state === 'walk' || state === 'none' || (state === 'return' && returnPhase !== 'rise')) {
    _w.set(rat.x + 0.08, slopeY(rat.x) + 0.02, rat.z - 0.05);
    camOffsetGoal.set(0.12, 0.3, 0.68);
    lookGoal.set(0, -0.05, -0.2);
  } else {
    lookGoal.set(0, -0.03, -0.15);
    // frame the abandoned slice and his hiding spot
    const tip = pizza.tip();
    _w.set(tip.x * 0.5 + rat.x * 0.5, slopeY(tip.x) * 0.5 + slopeY(rat.x) * 0.5 + 0.02, tip.z * 0.5 + HIDE_Z * 0.5);
    camOffsetGoal.set(0.1, 0.36, 0.8);
  }
  camFocus.lerp(_w, damp(2.2, dt));
  camOffset.lerp(camOffsetGoal, damp(1.5, dt));
  LOOK.lerp(lookGoal, damp(1.5, dt));
  camera.position.copy(camFocus).add(camOffset);
  if (fx.shake > 0.001) {
    const s = 0.01 * fx.shake;
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s;
  }
  camera.lookAt(_v.copy(camFocus).add(LOOK));

  key.position.copy(camFocus).add(_v.set(0.7, 1.8, 1.0));
  key.target.position.copy(camFocus);
  rim.position.copy(camFocus).add(_v.set(-1.0, 1.1, -0.4));
  rim.target.position.copy(camFocus);
  bounce.position.copy(camFocus).add(_v.set(0.2, 0.12, 0.35));
  flashLight.position.copy(camera.position).add(_v.set(0.04, 0.02, 0));
}

// --- HUD (phone camera overlay) ---
const hud = document.getElementById('hud');
const flashDiv = document.getElementById('flash');
const viewsEl = document.getElementById('views');
const viewCountEl = document.getElementById('viewCount');
const timecodeEl = document.getElementById('timecode');
let views = 0, viewsShown = 0, hudTime = 0;

function addViews(n) {
  views += n;
  viewsEl.classList.remove('bump');
  void viewsEl.offsetWidth;
  viewsEl.classList.add('bump');
}
function formatViews(n) {
  if (n < 1000) return Math.round(n).toString();
  if (n < 1e6) return (n / 1e3).toFixed(1) + 'K';
  return (n / 1e6).toFixed(1) + 'M';
}

function updateFx(dt, tagOn) {
  flashDiv.style.opacity = Math.min(1, fx.flash).toFixed(3);
  flashLight.intensity = fx.flash * 12;
  renderer.toneMappingExposure = 1.05 + fx.flash * 1.1;
  fx.flash *= Math.exp(-dt * 5);
  fx.shake *= Math.exp(-dt * 6);

  hud.classList.toggle('on', tagOn);
  if (tagOn) {
    hudTime += dt;
    if (state === 'hide') views += dt * 50000 * (1 + views / 1e6); // going viral
  }
  viewsShown += (views - viewsShown) * damp(6, dt);
  viewCountEl.textContent = formatViews(viewsShown);
  const ms = Math.floor(hudTime * 30);
  const pad = (n) => String(n).padStart(2, '0');
  timecodeEl.textContent = `${pad(Math.floor(ms / 1800))}:${pad(Math.floor(ms / 30) % 60)}:${pad(ms % 30)}`;

  sound.setScrape(state === 'walk' ? 0.7 + 0.3 * Math.sin(performance.now() / 70) : 0);
}

// =========================================================================
// INPUT: paper controller (webcam) + keyboard backup
// =========================================================================
const sound = new Sound();
// Paper markers flicker in and out of tracking, so "closed" means gone for about a second
const tracker = new Tracker({ triggerId: CONFIG.triggerId, dictionary: CONFIG.tagDictionary, inShapes: CONFIG.tagInShape, seenFrames: 3, lostFrames: 30 });
const station = new Station(scene, {
  stepD: STEP_D, stepH: STEP_H, stairW: STAIR_W, sound,
  stationName: CONFIG.stationName, mosaicName: CONFIG.mosaicName, plaqueName: CONFIG.plaqueName,
  line: CONFIG.line, lineColor: CONFIG.lineColor,
  trainEvery: CONFIG.trainEvery, firstTrain: CONFIG.firstTrain, express: CONFIG.expressTrain,
});
let keyHeld = false;

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { keyHeld = true; e.preventDefault(); }
  if (e.key === 'h') document.body.classList.toggle('hide-cam'); // hide/show webcam preview
  if (e.key === 't') station.startTrain(camFocus.x);             // call a train right now
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') keyHeld = false;
});

startBtn.addEventListener('click', () => {
  sound.start();
  tracker.start();
  station.enabled = true;
  document.getElementById('start').classList.add('gone');
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// =========================================================================
// MAIN LOOP
// =========================================================================
const clock = new THREE.Clock();
let detectFrame = false;

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);

  detectFrame = !detectFrame; // run computer vision every other frame (~30 fps)
  if (detectFrame) tracker.update();
  const tagOn = tracker.visible || keyHeld;

  if (ready) {
    updateRat(dt, tagOn);
    updatePizza(dt);
  }
  updateCamera(dt);
  updateSteps(camFocus.x);
  station.update(dt, camFocus);
  updateFx(dt, tagOn);
  renderer.render(scene, camera);
}
loop();

loadModels()
  .then(() => {
    startBtn.disabled = false;
    startBtn.textContent = 'Start';
  })
  .catch((err) => {
    console.error(err);
    startBtn.textContent = 'Could not load models';
  });

// For debugging in the browser console.
// pizzaRat.advance(3, true) fast-forwards 3 seconds with the tag "showing".
window.pizzaRat = {
  CONFIG, rat, enter, station, camera, ratRoot,
  get pizza() { return pizza; },
  get state() { return state; },
  get returnPhase() { return returnPhase; },
  get fleePhase() { return fleePhase; },
  get walkPhase() { return walkPhase; },
  drop,
  legPose,
  phys, tail,
  legGaps: () => legGaps(),
  /** how high his front and back paws are above whatever is under them (m) */
  pawGaps() { return { worst: pawGapsBones() }; },
  bend,
  rigInfo: () => ({ hips: rig.hips?.name, chest: rig.chest?.name, spine: rig.spine.map((b) => b.name), stretch: rig.stretch?.name }),
  clearance: (x, z, heading, pitch) => clearanceY(x, z, heading, pitch),
  body: () => ({ A: bodyALocal.toArray(), B: bodyBLocal.toArray(), r: bodyR, mouthDist }),
  /** how deep his body pokes into the stairs right now (m), checked around his capsule and nose */
  clipDepth() {
    const a = new V3(), b = new V3();
    bodyEnds(a, b);
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const c = a.clone().lerp(b, i / 8);
      pts.push(c.clone().add(new V3(0, -bodyR * 0.8, 0)), c.clone().add(new V3(0, 0, bodyR * 0.9)), c.clone().add(new V3(0, 0, -bodyR * 0.9)));
    }
    if (noseTip) pts.push(noseTip.getWorldPosition(new V3()));
    let worst = 0;
    this._worstAt = null;
    pts.forEach((p, i) => {
      if (Math.abs(p.z) > STAIR_W / 2) return; // beside the stairs: nothing to hit
      const d = treadTop(p.x) - p.y;
      if (d > worst) { worst = d; this._worstAt = { i, n: pts.length, x: p.x - rat.x }; }
    });
    return worst;
  },
  get anim() { return Object.entries(actions).filter(([, a]) => a.isRunning() && a.getEffectiveWeight() > 0.01).map(([k, a]) => `${k}:${a.getEffectiveWeight().toFixed(2)}`).join(' '); },
  approach,
  advance(seconds, tagOn = false) {
    for (let t = 0; t < seconds; t += 1 / 60) {
      updateRat(1 / 60, tagOn);
      updatePizza(1 / 60);
      updateCamera(1 / 60);
      updateSteps(camFocus.x);
      station.update(1 / 60, camFocus);
      updateFx(1 / 60, tagOn);
    }
    renderer.render(scene, camera);
  },
};
