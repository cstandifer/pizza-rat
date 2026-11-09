// =========================================================================
// 🚇 THE STATION — Spring Street, built from the "Subway Station & R46
// Subway" model, plus the railing on our staircase and the trains.
//
// The far side of the staircase is open: a railing, then a drop to the
// platform and tracks. Pizza Rat hides by hopping over that edge.
// =========================================================================
import * as THREE from 'three';
import {
  texFrom, tileCanvas, sootCanvas, columnSignCanvas, bandCanvas, namePlaqueCanvas, mosaicSignCanvas,
} from './textures.js';

const S = 0.85;              // model units -> meters (the model's platforms run a bit large)
const PLAT_Y = -1.4;         // platform surface, relative to the camera focus height
const MODEL_EDGE_Z = 2.6;    // in the model, where the near platform ends and the track pit begins
const OUR_EDGE_Z = -1.9;     // where we want that platform edge, in our world
const ENV_Z = OUR_EDGE_Z - MODEL_EDGE_Z * S;
const ENV_X0 = 14;           // which part of the station is behind us at the start
const PARALLAX = 0.9;        // the station slides by slowly so it never runs out
const PAIRS = 4;             // the model's train is one 2-car pair; we chain 4 of them (8 cars)

// Express timing, matched to assets/sounds/subway-passing.mp3:
// the nose reaches us when the recording gets loud (4s) and the tail clears as it fades (15.5s)
const PASS_HEAD_TIME = 4.0;
const PASS_TAIL_TIME = 15.5;
const PASS_AUDIO_LEN = 46;

// Trains you can hear in assets/sounds/nyc-subway-loop.mp3 (seconds into the recording).
// Found by listening for the rumble, the brake squeal, the door chime, and the lurch out.
const LOOP_TRAINS = [
  // Local: nose reaches us at 57s, brakes squeal to a stop at 68.5s, announcement ~84-93s,
  // door chime at 97.5s, lurches out at 110.5s and accelerates away.
  // (v0 = 13 m/s, about 29 mph, also parks a car's doors right behind the stairs)
  { kind: 'local', arrive: 57, stop: 68.5, depart: 110.5, v0: 13, accel: 1.0 },
  // trains roaring through without stopping
  { kind: 'pass', head: 129, tail: 141 },
  { kind: 'pass', head: 155.3, speed: 25 },
];
const APPROACH = 4;           // seconds of headlights in the tunnel before the nose arrives
const DOOR_SLIDE = 0.72;      // how far each door leaf slides open (model units)
const DOOR_OPEN_DELAY = 2.0;  // seconds after the train stops before the doors open
const DOOR_CLOSE_AT = 98.0;   // recording time the doors close: right after the chime at 97.5s
const DOOR_MOVE_TIME = 1.3;   // seconds for the doors to slide

const easeInOut = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** How open the doors are (0-1) at recording time `lt` for a stopping train. */
function doorOpenAmount(ev, lt) {
  if (ev.kind !== 'local') return 0;
  const opening = easeInOut((lt - (ev.stop + DOOR_OPEN_DELAY)) / DOOR_MOVE_TIME);
  const closing = easeInOut((lt - DOOR_CLOSE_AT) / DOOR_MOVE_TIME);
  return opening * (1 - closing);
}

// Spring St layout, in the station model's own units: our platform with columns, the local
// track, a row of steel I-beams, the express tracks, and the far platform's tiled wall.
const BEAM_Z = -3.35;         // I-beams between the local and express tracks
const BEAM_SPACING = 3.2;
const FAR_WALL_Z = -15.55;    // tiled wall across the tracks
const FAR_COLUMN_Z = -10.6;   // column line on the far platform
const COLUMN_Z = 3.3;         // column line on the platform, behind the stairs
const COLUMN_SPACING = 5.3;
const TRACK_BED_Y = -1.5;
const RAIL_Y = -1.05;         // top of the rails
const CEILING_Y = 4.4;

/**
 * How far the train's nose is past us (meters) at recording time `lt`, or null if it's not around.
 * `parkNose`: where the stopping train's nose should end up (so a doorway is behind the stairs).
 */
function noseDistance(ev, lt, trainLen, parkNose) {
  if (ev.kind === 'local') {
    const T = ev.stop - ev.arrive;
    const stopD = parkNose ?? (ev.v0 * T) / 2; // where the nose ends up
    const v0 = (2 * stopD) / T;                 // arrival speed that brakes to a stop right there
    const decel = v0 / T;                       // steady braking from v0 to a stop
    ev = { ...ev, v0 };
    if (lt < ev.arrive - APPROACH) return null;
    if (lt < ev.arrive) return ev.v0 * (lt - ev.arrive);
    if (lt < ev.stop) { const t = lt - ev.arrive; return ev.v0 * t - (decel * t * t) / 2; }
    if (lt < ev.depart) return stopD;
    const t = lt - ev.depart;
    const d = stopD + 0.5 * ev.accel * t * t;
    return d - trainLen > 90 ? null : d;
  }
  const v = ev.speed ?? trainLen / (ev.tail - ev.head);
  if (lt < ev.head - APPROACH) return null;
  const d = v * (lt - ev.head);
  return d - trainLen > 90 ? null : d;
}

export class Station {
  constructor(scene, {
    stepD, stepH, stairW, sound,
    stationName = 'Spring Street',  // on the column signs
    mosaicName = 'SPRING ST.',      // the big wall mosaics
    plaqueName = 'SPRING',          // the little wall plaques
    line = '6', lineColor = '#00933c',
    trainEvery = 60, firstTrain = 14, express = true,
  }) {
    this.lineColor = lineColor;
    this.mosaicName = mosaicName;
    this.plaqueName = plaqueName;
    this.scene = scene;
    this.stepD = stepD;
    this.stepH = stepH;
    this.edgeZ = -stairW / 2;
    this.sound = sound;
    this.trainEvery = trainEvery;
    this.express = express;  // true: roars through without stopping. false: stops, chimes, announces.
    this.enabled = false;    // trains start coming once the experience has started
    this.clock = 0;
    this.nextTrain = firstTrain;
    this.stationName = stationName;
    this.line = line;

    this.env = new THREE.Group(); // the station model lives in here
    this.env.scale.setScalar(S);
    scene.add(this.env);

    this.train = new THREE.Group();
    this.train.scale.setScalar(S);
    this.train.visible = false;
    scene.add(this.train);
    this.trainLen = 100;
    this.passSpeed = 16;

    // Warm light spilling out of the windows onto the platform and stairs
    this.windowLight = new THREE.PointLight(0xffe7b0, 0, 9, 1.6);
    scene.add(this.windowLight);

    this.tr = { state: 'idle', x: -999, v: 0, t: 0, stopX: 0, clack: 0, chimed: 0, recorded: false };
    this._buildRailing();
  }

  /** Called once the station .glb has loaded. */
  setModel(gltf) {
    const root = gltf.scene;
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.receiveShadow = true;
      o.castShadow = false;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => (m.envMapIntensity = 0.5));
    });
    root.updateMatrixWorld(true);

    // Pull the train (two R46 cars: TrainEmpty and TrainEmpty001) out of the station so it can move
    const cars = [];
    root.traverse((o) => { if (/^TrainEmpty/.test(o.name)) cars.push(o); });
    if (cars.length) {
      const pair = new THREE.Group();
      cars.forEach((car) => {
        const m = car.matrixWorld.clone();
        car.removeFromParent();
        m.decompose(car.position, car.quaternion, car.scale);
        pair.add(car);
      });
      pair.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(pair);
      const len = box.max.x - box.min.x + 0.6;
      for (let k = 0; k < PAIRS; k++) {
        const p = k === 0 ? pair : pair.clone();
        p.position.x = -box.max.x - k * len;  // nose at x = 0, cars trail toward -x
        p.position.y = RAIL_Y - box.min.y;     // wheels on the rails
        p.position.z = -(box.min.z + box.max.z) / 2; // centered on the track
        this.train.add(p);
      }
      // The car shells are "see-through" materials because of their windows. See-through surfaces
      // don't hide what's behind them, so the far-side doors showed through the near wall.
      // Cut the windows out instead: solid body, open windows, correct depth.
      const fixed = new Set();
      pair.traverse((o) => {
        if (!o.isMesh) return;
        const m = o.material;
        if (fixed.has(m) || !m.transparent) return;
        fixed.add(m);
        m.transparent = false;
        m.depthWrite = true;
        m.alphaTest = 0.5;
        m.alphaToCoverage = true;
        m.needsUpdate = true;
      });

      // Sliding doors: each doorway is two leaves (plus their glass, frames, stickers and
      // rubber seals). Parts named "...Laterales2..." slide toward +x, the rest toward -x.
      this.doors = [];
      this.train.updateMatrixWorld(true);
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      this.train.children.forEach((p) => {
        if (!p.isGroup) return;
        p.traverse((o) => {
          if (!o.isMesh || !/PuertasLaterales/.test(o.name)) return;
          const dir = /Laterales2/.test(o.name) ? 1 : -1;
          // the slide, measured along the car, converted into this part's own coordinates
          p.localToWorld(a.set(0, 0, 0));
          p.localToWorld(b.set(dir * DOOR_SLIDE, 0, 0));
          o.parent.worldToLocal(a);
          o.parent.worldToLocal(b);
          this.doors.push({ mesh: o, base: o.position.clone(), slide: b.sub(a).clone() });
        });
      });

      // Where are the doorways along the train (meters behind the nose)? Used to park the
      // stopping train with a doorway right behind the stairs, so you see the doors open.
      const box2 = new THREE.Box3(), c = new THREE.Vector3();
      this.doorways = [];
      this.train.position.set(0, 0, 0);
      this.train.updateMatrixWorld(true);
      for (const d of this.doors) {
        if (!/^PuertasLaterales_/.test(d.mesh.name)) continue; // one leaf per doorway
        box2.setFromObject(d.mesh).getCenter(c);
        this.doorways.push(-(c.x + (DOOR_SLIDE / 2) * S)); // middle of the doorway
      }
      // pick the doorway in the middle third of the train
      const target = PAIRS * len * S * 0.45;
      this.parkNose = this.doorways.reduce((best, x) => (Math.abs(x - target) < Math.abs(best - target) ? x : best), target);

      this.trainLen = PAIRS * len * S;
      this.trainZ = (box.min.z + box.max.z) / 2;
      this.trainFloorY = box.min.y;
    }
    this.passSpeed = this.trainLen / (PASS_TAIL_TIME - PASS_HEAD_TIME);

    // Headlight on the lead car
    this.headlight = new THREE.SpotLight(0xfff0cc, 40, 45, 0.45, 0.6, 1.5);
    this.headlight.position.set(0.3, 0.5, this.trainZ ?? 0);
    this.headlight.target.position.set(12, -0.5, this.trainZ ?? 0);
    this.train.add(this.headlight, this.headlight.target);

    // Past the I-beams, keep only the model's floors, track beds and rails. Its tunnel arch,
    // walls and far-platform props don't look like Spring St, so we build those ourselves.
    root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    root.traverse((o) => {
      if (!o.isMesh) return;
      box.setFromObject(o);
      const divider = o.material?.name === 'SeparadorAndanas'; // the model's arched track divider
      if (divider || (box.min.z < BEAM_Z - 0.3 && !/Suelo|Vias/.test(o.name))) o.visible = false;
    });

    this.env.add(root);
    this._buildSpringSt();
  }

  // Spring St (see the reference photo): dark green columns with "Spring Street" signs on our
  // platform, a row of steel I-beams past the local track, then the express tracks and the far
  // wall: white tile, royal blue band, big "SPRING ST." mosaics and little "SPRING" plaques.
  _buildSpringSt() {
    const X0 = -60, X1 = 80, W = X1 - X0, CX = (X0 + X1) / 2;

    // --- far wall ---
    // The wall is ~17m away, where the depth buffer can't separate surfaces a few mm apart
    // (they flicker: "z-fighting"). So the base and tile sit side by side instead of
    // overlapping, and everything stuck on the wall is pushed out a bit and drawn on top.
    const BASE_H = 0.45;
    const tileH = CEILING_Y - BASE_H;
    const repeat = 0.6 / S; // one texture repeat = 60cm in the real world
    const tile = new THREE.Mesh(
      new THREE.PlaneGeometry(W, tileH),
      new THREE.MeshStandardMaterial({
        map: texFrom(tileCanvas, { repeat: [W / repeat, tileH / (0.3 / S)] }),
        roughness: 0.25,
        envMapIntensity: 1.0,
      })
    );
    tile.position.set(CX, BASE_H + tileH / 2, FAR_WALL_Z);
    const base = new THREE.Mesh(
      new THREE.PlaneGeometry(W, BASE_H),
      new THREE.MeshStandardMaterial({ map: texFrom(sootCanvas, { repeat: [W / 1.5, 1] }), color: 0x8a8580, roughness: 1 })
    );
    base.position.set(CX, BASE_H / 2, FAR_WALL_Z);
    this.env.add(tile, base);

    const onWall = (map) => new THREE.MeshStandardMaterial({
      map, roughness: 0.3, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    const DECAL_Z = FAR_WALL_Z + 0.03;
    const band = new THREE.Mesh(new THREE.PlaneGeometry(W, 0.55), onWall(texFrom(bandCanvas(31, 69, 176), { repeat: [W / 1.2, 2] })));
    band.position.set(CX, 3.55, DECAL_Z);
    this.env.add(band);

    const mosaicMat = onWall(texFrom(mosaicSignCanvas(this.mosaicName)));
    const plaqueMat = onWall(texFrom(namePlaqueCanvas(this.plaqueName, { bg: '#f1eee4', fg: '#141414' })));
    for (let x = X0 + 4; x < X1; x += 16) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.85), mosaicMat);
      m.position.set(x, 2.25, DECAL_Z);
      this.env.add(m);
      for (const dx of [5, 8, 11]) {
        const p = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.23), plaqueMat);
        p.position.set(x + dx, 2.95, DECAL_Z);
        this.env.add(p);
      }
    }

    // --- steel I-beams between the local and express tracks (instanced: flange, web, flange) ---
    const beamMat = new THREE.MeshStandardMaterial({ color: 0x2b2522, roughness: 0.6, metalness: 0.4 });
    const beamH = CEILING_Y - TRACK_BED_Y;
    const parts = [
      [new THREE.BoxGeometry(0.03, beamH, 0.32), -0.13],
      [new THREE.BoxGeometry(0.26, beamH, 0.03), 0],
      [new THREE.BoxGeometry(0.03, beamH, 0.32), 0.13],
    ];
    const count = Math.ceil(W / BEAM_SPACING);
    const m4 = new THREE.Matrix4();
    for (const [geo, dx] of parts) {
      const inst = new THREE.InstancedMesh(geo, beamMat, count);
      for (let k = 0; k < count; k++) {
        m4.makeTranslation(X0 + k * BEAM_SPACING + dx, TRACK_BED_Y + beamH / 2, BEAM_Z);
        inst.setMatrixAt(k, m4);
      }
      inst.receiveShadow = true;
      this.env.add(inst);
    }

    // --- columns on our platform ---
    const colMat = new THREE.MeshStandardMaterial({ color: 0x1b2622, roughness: 0.45, metalness: 0.3, envMapIntensity: 0.6 });
    const colGeo = new THREE.BoxGeometry(0.45, CEILING_Y, 0.45);
    const signMat = new THREE.MeshStandardMaterial({
      map: texFrom(columnSignCanvas(this.stationName.split(' '))),
      roughness: 0.4,
      envMapIntensity: 0.5,
    });
    const signGeo = new THREE.PlaneGeometry(0.42, 0.3);
    for (let x = -50; x <= 20; x += COLUMN_SPACING) {
      const c = new THREE.Mesh(colGeo, colMat);
      c.position.set(x, CEILING_Y / 2, COLUMN_Z);
      c.castShadow = true;
      c.receiveShadow = true;
      const sign = new THREE.Mesh(signGeo, signMat); // faces the track, like in the photo
      sign.position.set(x, 2.1, COLUMN_Z - 0.226);
      sign.rotation.y = Math.PI;
      const sign2 = new THREE.Mesh(signGeo, signMat); // and one facing the stairs
      sign2.position.set(x, 2.1, COLUMN_Z + 0.226);
      this.env.add(c, sign, sign2);

      // the same columns on the far platform, across the express tracks
      const fc = new THREE.Mesh(colGeo, colMat);
      fc.position.set(x + 2.6, CEILING_Y / 2, FAR_COLUMN_Z);
      const fs = new THREE.Mesh(signGeo, signMat);
      fs.position.set(x + 2.6, 2.1, FAR_COLUMN_Z + 0.226);
      this.env.add(fc, fs);
    }
  }

  // Railing along the open side of the stairs (locked to the stairs, not the station)
  _buildRailing() {
    const metal = new THREE.MeshStandardMaterial({ color: 0x8f8d86, metalness: 0.85, roughness: 0.35 });
    this.postSpacing = 1.2;
    this.posts = [];
    const postGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.95, 12);
    for (let k = 0; k < 12; k++) {
      const p = new THREE.Mesh(postGeo, metal);
      p.castShadow = true;
      this.scene.add(p);
      this.posts.push(p);
    }
    const slope = Math.atan2(-this.stepH, this.stepD);
    this.topRail = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 16, 16), metal);
    this.topRail.rotation.z = slope - Math.PI / 2;
    this.topRail.castShadow = true;
    this.midRail = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 16, 10), metal);
    this.midRail.rotation.z = slope - Math.PI / 2;
    this.scene.add(this.topRail, this.midRail);
  }

  startTrain(focusX) {
    if (this.tr.state !== 'idle') return;
    if (this.express) {
      // Recorded audio if we have it; otherwise the synthesized layers follow the train
      const recorded = this.sound?.playPass?.() ?? false;
      Object.assign(this.tr, {
        state: 'express', v: this.passSpeed, t: 0, clack: 0, recorded,
        x: focusX - this.passSpeed * PASS_HEAD_TIME,
      });
    } else {
      Object.assign(this.tr, { state: 'arriving', x: focusX - 150, v: 17, t: 0, stopX: focusX + 48, clack: 0, chimed: 0, recorded: false });
    }
    this.train.visible = true;
  }

  _scheduleNext() {
    const gap = this.trainEvery * (0.8 + Math.random() * 0.4);
    this.nextTrain = this.clock + Math.max(gap, this.express ? PASS_AUDIO_LEN + 8 : 20);
  }

  /** Slide the doors: 0 = closed, 1 = open. */
  setDoors(f) {
    if (!this.doors || f === this._doorF) return;
    this._doorF = f;
    for (const d of this.doors) d.mesh.position.copy(d.base).addScaledVector(d.slide, f);
  }

  // Send a train past whenever one roars by in the looping station recording
  _syncToRecording(lt, focus) {
    const tr = this.tr;
    let active = null, nose = 0;
    for (const ev of LOOP_TRAINS) {
      const d = noseDistance(ev, lt, this.trainLen, this.parkNose);
      if (d !== null) { active = ev; nose = d; break; }
    }
    if (!active) {
      if (tr.state === 'synced') { tr.state = 'idle'; this.train.visible = false; }
      this.setDoors(0);
      return false;
    }
    tr.state = 'synced';
    this.setDoors(doorOpenAmount(active, lt));
    const head = focus.x + nose;
    const tail = head - this.trainLen;
    this.train.visible = true;
    this.train.position.set(head, focus.y + PLAT_Y, ENV_Z);
    const d = focus.x < tail ? tail - focus.x : focus.x > head ? focus.x - head : 0;
    this.windowLight.position.set(THREE.MathUtils.clamp(focus.x, tail, head), focus.y + PLAT_Y + 1.6, ENV_Z + 1.8);
    this.windowLight.intensity = 4 * Math.exp(-d / 4);
    this.sound?.setTrain({ prox: 0, speed: 0 }); // the recording has the sound
    return true;
  }

  _updateTrain(dt, focus) {
    const tr = this.tr;
    if (this.enabled) this.clock += dt;

    // With the station recording playing, trains follow the recording (the T key still works)
    const lt = this.sound?.loopTime?.();
    if (lt != null && tr.state !== 'express' && tr.state !== 'arriving' && tr.state !== 'stopped' && tr.state !== 'departing') {
      if (this._syncToRecording(lt, focus)) return;
      this.windowLight.intensity = 0;
      return;
    }

    if (tr.state === 'idle') {
      if (this.enabled && this.clock > this.nextTrain) this.startTrain(focus.x);
      else { this.windowLight.intensity = 0; this.sound?.setTrain({ prox: 0, speed: 0 }); return; }
    }
    tr.t += dt;
    let braking = false, accel = false;
    if (tr.state === 'express') {
      if (tr.x - this.trainLen > focus.x + 80) {
        tr.state = 'idle';
        this.train.visible = false;
        this._scheduleNext();
      }
    } else if (tr.state === 'arriving') {
      const remaining = tr.stopX - tr.x;
      if (remaining < 70) {
        braking = tr.v > 0.2;
        const a = (tr.v * tr.v) / (2 * Math.max(remaining, 0.05));
        tr.v = Math.max(0, tr.v - a * dt);
      }
      if (tr.v < 0.05 && remaining < 0.6) { tr.state = 'stopped'; tr.t = 0; tr.v = 0; }
    } else if (tr.state === 'stopped') {
      // (no recording) doors open after the first chime, close after the second
      this.setDoors(easeInOut((tr.t - 1.2) / DOOR_MOVE_TIME) * (1 - easeInOut((tr.t - 7.0) / DOOR_MOVE_TIME)));
      if (tr.chimed === 0 && tr.t > 0.8) { tr.chimed = 1; this.sound?.chime(); }
      if (tr.chimed === 1 && tr.t > 3.5) { tr.chimed = 2; this.sound?.announce('Stand clear of the closing doors, please.'); }
      if (tr.chimed === 2 && tr.t > 6.8) { tr.chimed = 3; this.sound?.chime(); }
      if (tr.t > 8.5) { tr.state = 'departing'; tr.t = 0; }
    } else if (tr.state === 'departing') {
      accel = true;
      tr.v = Math.min(19, tr.v + 1.1 * dt);
      if (tr.x - this.trainLen > focus.x + 80) {
        tr.state = 'idle';
        this.train.visible = false;
        this._scheduleNext();
      }
    }
    tr.x += tr.v * dt;
    this.train.position.set(tr.x, focus.y + PLAT_Y, ENV_Z);

    // How close is any part of the train to us?
    const tail = tr.x - this.trainLen;
    const d = focus.x < tail ? tail - focus.x : focus.x > tr.x ? focus.x - tr.x : 0;
    const prox = Math.exp(-d / 30);
    this.windowLight.position.set(THREE.MathUtils.clamp(focus.x, tail, tr.x), focus.y + PLAT_Y + 1.6, ENV_Z + 1.8);
    this.windowLight.intensity = 4 * Math.exp(-d / 4);

    if (tr.recorded) {
      // the recording already has the rumble and clatter
      this.sound?.setTrain({ prox: 0, speed: 0 });
      return;
    }
    // wheels clacking over rail joints
    tr.clack += tr.v * dt;
    if (tr.clack > 4.3) { tr.clack = 0; this.sound?.clack(prox, tr.v); }
    this.sound?.setTrain({ prox, speed: tr.v, braking, accel });
  }

  update(dt, focus) {
    // The station follows us down the endless stairs, sliding by slowly
    this.env.position.set(PARALLAX * focus.x + ENV_X0, focus.y + PLAT_Y, ENV_Z);

    // railing posts stand on the treads at the open edge
    const base = Math.floor(focus.x / this.postSpacing) - 5;
    this.posts.forEach((p, k) => {
      const x = (base + k) * this.postSpacing;
      const top = -Math.floor(x / this.stepD) * this.stepH;
      p.position.set(x, top + 0.475, this.edgeZ + 0.03);
    });
    const lineY = -(focus.x / this.stepD) * this.stepH + this.stepH;
    this.topRail.position.set(focus.x, lineY + 0.86, this.edgeZ + 0.03);
    this.midRail.position.set(focus.x, lineY + 0.45, this.edgeZ + 0.03);

    this._updateTrain(dt, focus);
  }
}
