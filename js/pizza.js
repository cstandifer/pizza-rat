// =========================================================================
// 🍕 FLOPPY PIZZA — the slice is simulated as a bendy strip (a chain of points
// with gravity, friction and stair collisions), and the 3D model is bent to
// follow it. That's what lets it sag over step edges and flop when dropped.
//
//   node 0 = the tip (in his mouth)  ...  node N = the crust
// =========================================================================
import * as THREE from 'three';

const V3 = THREE.Vector3;
const GRAVITY = -9.8;

export class FloppyPizza {
  /**
   * @param {THREE.Object3D} source  Pizza model, already scaled so the tip is at the
   *                                 origin, the crust points toward -x, and the bottom is y = 0.
   *                                 Its parent must be at the world origin with no rotation.
   */
  constructor(source, scene, { length, stepD, stepH, nodes = 12, holdCrust = false }) {
    this.L = length;
    // which end is in his mouth: the crust (tip leading, like the real Pizza Rat) or the tip
    this.holdCrust = holdCrust;
    this.hA = holdCrust ? nodes : 0;         // the node held in his mouth
    this.hB = holdCrust ? nodes - 1 : 1;     // the next one, held just in front of it
    this.N = nodes;
    this.seg = length / nodes;
    this.stepD = stepD;
    this.stepH = stepH;

    // Stiffness: how far each pair of segments may fold. The crust end is stiff,
    // the tip end is floppy (like a real NYC slice).
    this.minBend = [];
    for (let i = 0; i <= nodes - 2; i++) {
      const u = i / (nodes - 2);
      this.minBend.push(2 * this.seg * THREE.MathUtils.lerp(0.955, 0.995, u * u)); // (a bit stiffer)
    }
    // Longer-range stiffness so it can droop over a step but never fold back on itself
    this.longLinks = [];
    for (let i = 0; i + 4 <= nodes; i += 2) this.longLinks.push([i, i + 4, 4 * this.seg * 0.9]);
    this.longLinks.push([0, nodes, length * 0.88]);

    this.p = [];
    this.q = [];
    for (let i = 0; i <= nodes; i++) {
      this.p.push(new V3(-i * this.seg, 0, 0));
      this.q.push(new V3(-i * this.seg, 0, 0));
    }

    this.held = true;
    this.pinBlend = 1;
    this.pinTip = new V3();
    this.pinNext = new V3();
    this.back = new V3(-1, 0, 0);
    // The rat's body as a capsule (segment A-B, radius r) the slice can't pass through
    this.bodyA = new V3();
    this.bodyB = new V3();
    this.bodyR = 0;
    this._ab = new V3();
    this._n = new V3();
    this.heading = new V3(-1, 0, 0); // which way the slice points (flat, tip -> crust)

    // Bake the model into "slice space" and keep the rest pose so we can bend it every frame
    source.updateMatrixWorld(true);
    this.parts = [];
    source.traverse((o) => {
      if (!o.isMesh) return;
      const geo = o.geometry.clone();
      geo.applyMatrix4(o.matrixWorld);
      const pos = geo.attributes.position;
      const nrm = geo.attributes.normal;
      pos.setUsage(THREE.DynamicDrawUsage);
      nrm.setUsage(THREE.DynamicDrawUsage);
      const rest = Float32Array.from(pos.array);
      const restN = Float32Array.from(nrm.array);
      const mesh = new THREE.Mesh(geo, o.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.parts.push({ geo, rest, restN });
    });
    source.parent?.remove(source);
    // how wide the crust is (the slice's widest part), so he can hold it by a corner
    let zMin = Infinity, zMax = -Infinity;
    for (const { rest } of this.parts) for (let v = 2; v < rest.length; v += 3) { zMin = Math.min(zMin, rest[v]); zMax = Math.max(zMax, rest[v]); }
    this.halfWidth = isFinite(zMin) ? (zMax - zMin) / 2 : 0.06;
    // the crust end: how far its corners are from the centre line (z), and how thick it is (y)
    let cMin = Infinity, cMax = -Infinity, cTop = 0;
    for (const { rest } of this.parts) for (let v = 0; v < rest.length; v += 3) {
      if (rest[v] > -0.85 * length) continue;
      cMin = Math.min(cMin, rest[v + 2]); cMax = Math.max(cMax, rest[v + 2]); cTop = Math.max(cTop, rest[v + 1]);
    }
    this.crustNear = isFinite(cMax) ? cMax : 0.06;  // corner on the +z side (the side nearest him when he drags it)
    this.crustTop = cTop || 0.02;

    this._nt = Array.from({ length: nodes + 1 }, () => new V3());
  }

  treadTop(x) {
    return -Math.floor(x / this.stepD) * this.stepH;
  }

  /** Put the slice somewhere instantly, lying straight out of his mouth along dir. */
  reset(mouth, dir) {
    for (let i = 0; i <= this.N; i++) {
      const k = this.holdCrust ? this.N - i : i;
      this.p[i].copy(mouth).addScaledVector(dir, k * this.seg);
      this.q[i].copy(this.p[i]);
    }
  }

  /** He lets go. `vel` is a little toss so it flops instead of just sitting there. */
  drop(vel) {
    this.held = false;
    const h = 1 / 180;
    for (let i = 0; i <= this.N; i++) this.q[i].addScaledVector(vel, -h);
  }

  grab() {
    this.held = true;
    this.pinBlend = 0;
  }

  /** Where the rat's body is this frame (a capsule from a to b with radius r). */
  setBody(a, b, r) {
    this.bodyA.copy(a);
    this.bodyB.copy(b);
    this.bodyR = r;
  }

  // push a point out of the rat's body, sideways or up (never down into the stairs)
  _avoidBody(i) {
    if (!this.bodyR) return;
    const p = this.p[i], A = this.bodyA, ab = this._ab.subVectors(this.bodyB, A);
    const t = Math.max(0, Math.min(1, ((p.x - A.x) * ab.x + (p.y - A.y) * ab.y + (p.z - A.z) * ab.z) / ab.lengthSq()));
    const n = this._n.set(p.x - (A.x + ab.x * t), p.y - (A.y + ab.y * t), p.z - (A.z + ab.z * t));
    if (n.lengthSq() >= this.bodyR * this.bodyR) return;
    if (n.y < 0) n.y = 0;
    if (n.lengthSq() < 1e-8) n.set(-ab.z, 0, ab.x); // dead center: shove it to his side
    n.normalize();
    p.set(A.x + ab.x * t + n.x * this.bodyR, Math.max(p.y, A.y + ab.y * t + n.y * this.bodyR), A.z + ab.z * t + n.z * this.bodyR);
  }

  /** Where the tip is and which way the slice points (tip -> crust), for the rat to come back to. */
  tip() { return this.p[0]; }
  /** The end he holds in his mouth. */
  holdPoint() { return this.p[this.hA]; }
  direction(out = new V3()) {
    return out.subVectors(this.p[2], this.p[0]).setY(0).normalize();
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} mouth  world position of the rat's mouth
   * @param {THREE.Vector3} back   direction the slice sticks out of his mouth
   */
  update(dt, mouth, back) {
    this.back.copy(back);
    if (this.held) {
      this.pinBlend = Math.min(1, this.pinBlend + dt / 0.3);
      this.pinTip.copy(mouth);
      this.pinNext.copy(mouth).addScaledVector(back, this.seg).y -= this.seg * 0.25;
    }
    const steps = 3;
    const h = Math.min(dt, 1 / 30) / steps;
    for (let s = 0; s < steps; s++) this._step(h);
    this._deform();
  }

  _step(h) {
    const { p, q, N } = this;
    const hA = this.hA, hB = this.hB;
    const pinned = (i) => this.held && (i === hA || i === hB);

    // Verlet integration
    for (let i = 0; i <= N; i++) {
      if (pinned(i)) continue;
      const vx = (p[i].x - q[i].x) * 0.995;
      const vy = (p[i].y - q[i].y) * 0.995;
      const vz = (p[i].z - q[i].z) * 0.995;
      q[i].copy(p[i]);
      p[i].x += vx;
      p[i].y += vy + GRAVITY * h * h;
      p[i].z += vz;
    }
    if (this.held) {
      p[hA].lerp(this.pinTip, this.pinBlend); q[hA].copy(p[hA]);
      p[hB].lerp(this.pinNext, this.pinBlend); q[hB].copy(p[hB]);
    }

    for (let it = 0; it < 8; it++) {
      for (let i = 0; i < N; i++) this._dist(i, i + 1, this.seg, this.seg, pinned);
      for (let i = 0; i < N - 1; i++) this._dist(i, i + 2, this.minBend[i], Infinity, pinned);
      for (const [a, b, min] of this.longLinks) this._dist(a, b, min, Infinity, pinned);
      this._straighten(pinned);
      for (let i = 0; i <= N; i++) if (!pinned(i)) { this._avoidBody(i); this._collide(i); }
      for (let i = 0; i < N; i++) this._edge(i, pinned);
    }
  }

  // A slice flops up and down, but it can't curl sideways like a noodle:
  // keep every point on one vertical plane through the slice.
  _straighten(pinned) {
    const { p, N } = this;
    let dx, dz;
    if (this.held) { dx = this.back.x; dz = this.back.z; }
    else { dx = p[N].x - p[0].x; dz = p[N].z - p[0].z; }
    const l = Math.hypot(dx, dz);
    if (l > 1e-3) this.heading.set(dx / l, 0, dz / l);
    const hx = this.heading.x, hz = this.heading.z;
    const px = -hz, pz = hx; // sideways
    let ax = 0, az = 0;
    if (this.held) { ax = p[this.hA].x; az = p[this.hA].z; }
    else { for (let i = 0; i <= N; i++) { ax += p[i].x; az += p[i].z; } ax /= N + 1; az /= N + 1; }
    for (let i = 0; i <= N; i++) {
      if (pinned(i)) continue;
      const lat = (p[i].x - ax) * px + (p[i].z - az) * pz;
      p[i].x -= px * lat * 0.6;
      p[i].z -= pz * lat * 0.6;
    }
  }

  // keep two nodes between min and max distance apart
  _dist(a, b, min, max, pinned) {
    const pa = this.p[a], pb = this.p[b];
    const dx = pb.x - pa.x, dy = pb.y - pa.y, dz = pb.z - pa.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
    const target = d < min ? min : d > max ? max : d;
    if (target === d) return;
    const wa = pinned(a) ? 0 : 1, wb = pinned(b) ? 0 : 1;
    if (wa + wb === 0) return;
    const k = (d - target) / d / (wa + wb);
    pa.x += dx * k * wa; pa.y += dy * k * wa; pa.z += dz * k * wa;
    pb.x -= dx * k * wb; pb.y -= dy * k * wb; pb.z -= dz * k * wb;
  }

  // stairs are a step-shaped floor: push points up onto treads, or back off a riser
  _collide(i) {
    const p = this.p[i], q = this.q[i];
    const r = 0.003;
    const top = this.treadTop(p.x);
    if (p.y >= top + r) return;
    const iNow = Math.floor(p.x / this.stepD);
    const iPrev = Math.floor(q.x / this.stepD);
    if (iPrev > iNow && q.y < top + r) {
      // slid backward into the face of a riser
      p.x = (iNow + 1) * this.stepD + r;
      q.x = p.x;
      return;
    }
    p.y = top + r;
    q.y = p.y;
    // friction on concrete
    q.x += (p.x - q.x) * 0.35;
    q.z += (p.z - q.z) * 0.35;
  }

  // don't let the straight bit between two nodes cut through a step's nose
  _edge(i, pinned) {
    const a = this.p[i], b = this.p[i + 1];
    const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
    const k = Math.ceil(lo / this.stepD);
    const ex = k * this.stepD;
    if (ex > hi || ex <= lo) return;
    const cornerY = -(k - 1) * this.stepH + 0.004; // top of the upper step at its edge
    const t = (ex - a.x) / (b.x - a.x);
    const y = a.y + (b.y - a.y) * t;
    if (y >= cornerY) return;
    const push = cornerY - y;
    if (!pinned(i)) a.y += push;
    if (!pinned(i + 1)) b.y += push;
  }

  // bend every vertex of the model to follow the chain
  _deform() {
    const { p, N, L, _nt: nt } = this;
    for (let i = 0; i <= N; i++) {
      if (i === 0) nt[i].subVectors(p[1], p[0]);
      else if (i === N) nt[i].subVectors(p[N], p[N - 1]);
      else nt[i].subVectors(p[i + 1], p[i - 1]);
      nt[i].normalize();
    }
    for (const part of this.parts) {
      const pos = part.geo.attributes.position.array;
      const nrm = part.geo.attributes.normal.array;
      const rest = part.rest, restN = part.restN;
      for (let v = 0; v < rest.length; v += 3) {
        const x0 = rest[v], y0 = rest[v + 1], z0 = rest[v + 2];
        const s = (-x0 / L) * N;
        const i = s < 0 ? 0 : s >= N ? N - 1 : Math.floor(s);
        const t = s - i;
        const a = p[i], b = p[i + 1];
        const cx = a.x + (b.x - a.x) * t, cy = a.y + (b.y - a.y) * t, cz = a.z + (b.z - a.z) * t;
        const tt = t < 0 ? 0 : t > 1 ? 1 : t;
        let Tx = nt[i].x + (nt[i + 1].x - nt[i].x) * tt;
        let Ty = nt[i].y + (nt[i + 1].y - nt[i].y) * tt;
        let Tz = nt[i].z + (nt[i + 1].z - nt[i].z) * tt;
        const tl = Math.hypot(Tx, Ty, Tz) || 1;
        Tx /= tl; Ty /= tl; Tz /= tl;
        // up vector, made perpendicular to the strip
        let Nx = -Ty * Tx, Ny = 1 - Ty * Ty, Nz = -Ty * Tz;
        const nl = Math.hypot(Nx, Ny, Nz) || 1;
        Nx /= nl; Ny /= nl; Nz /= nl;
        // side vector = (-T) x N
        const Zx = -(Ty * Nz - Tz * Ny), Zy = -(Tz * Nx - Tx * Nz), Zz = -(Tx * Ny - Ty * Nx);
        pos[v] = cx + Nx * y0 + Zx * z0;
        pos[v + 1] = cy + Ny * y0 + Zy * z0;
        pos[v + 2] = cz + Nz * y0 + Zz * z0;
        const nx = restN[v], ny = restN[v + 1], nz = restN[v + 2];
        nrm[v] = -Tx * nx + Nx * ny + Zx * nz;
        nrm[v + 1] = -Ty * nx + Ny * ny + Zy * nz;
        nrm[v + 2] = -Tz * nx + Nz * ny + Zz * nz;
      }
      part.geo.attributes.position.needsUpdate = true;
      part.geo.attributes.normal.needsUpdate = true;
    }
  }
}
