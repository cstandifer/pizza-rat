// =========================================================================
// 🐀 RAT BODY PHYSICS — his body is a real rigid body falling under gravity.
//
// It lives in the vertical plane down the stairs (x = down the stairs, y = up). It has mass,
// a moment of inertia, velocity and spin, and real gravity (9.8 m/s²). Contact points on his body
// (paws, belly, rump, nose) can't go into the stairs, and his belly can't pass through a step's nose.
// Paws that touch the ground grip it and walk him forward (friction); the belly slides.
//
// So when he walks out over an edge, nothing is scripted: once his weight is past the step's nose
// he tips over it and falls, rotating, until his front paws hit the step below; then his back end
// slides over the nose and drops. Solver: position-based rigid-body dynamics (Müller et al., "Detailed
// Rigid Body Simulation with Extended Position Based Dynamics", 2020), in 2D, with small substeps.
//
// Coordinates: "local" = his own frame (the rat root's pitched frame): u forward, v up, origin at
// the root (ground level under him when he stands).
// =========================================================================

export const GRAVITY = 9.8;
const SUBSTEP = 1 / 240;

export class RatBody {
  /**
   * @param {object} o
   * @param {(x:number)=>number} o.ground   height of the stairs' top surface at x
   * @param {number} o.stepD                step depth (edges at multiples of it)
   * @param {number} o.stepH                step height
   * @param {number} o.gyration             radius of gyration (m) — how hard he is to spin
   */
  constructor({ ground, stepD, stepH, gyration = 0.075 }) {
    this.ground = ground;
    this.stepD = stepD;
    this.stepH = stepH;
    this.invI = 1 / (gyration * gyration); // mass = 1
    this.com = { u: 0, v: 0 };              // centre of mass, local
    this.cx = 0; this.cy = 0; this.th = 0;  // centre of mass (world) and tilt (nose up +)
    this.vx = 0; this.vy = 0; this.w = 0;
    this.belly = null;                      // { u0, u1, v } the underside line that rests on step noses
    this.impact = 0;                        // biggest downward speed lost to a contact this frame
    this.levelAssist = 0;                   // rad/s² per rad: swinging his back end down to the step
    this.bellyDrive = 0;                    // m/s: his back legs pushing him over a step's nose
    this.minTilt = -1.0;                    // radians: his muscles fight tipping further than this
    this.maxTilt = 0.6;
    this._prev = { cx: 0, cy: 0, th: 0 };
    this._gripping = true; this._touching = true;
  }

  /** Put him at a root position/tilt, at rest. */
  place(x, y, pitch, com) {
    this.com = { ...com };
    this.th = pitch;
    const c = Math.cos(pitch), s = Math.sin(pitch);
    this.cx = x + c * com.u - s * com.v;
    this.cy = y + s * com.u + c * com.v;
    this.vx = this.vy = this.w = 0;
  }

  /** Root position (where the rat model's origin goes). */
  root(out) {
    const c = Math.cos(this.th), s = Math.sin(this.th);
    out.x = this.cx - (c * this.com.u - s * this.com.v);
    out.y = this.cy - (s * this.com.u + c * this.com.v);
    out.pitch = this.th;
    return out;
  }

  // local point -> world, for a given state
  _world(u, v, cx, cy, th, out) {
    const c = Math.cos(th), s = Math.sin(th);
    const du = u - this.com.u, dv = v - this.com.v;
    out.x = cx + c * du - s * dv;
    out.y = cy + s * du + c * dv;
    return out;
  }

  // move the body so that the point at world offset r (from the COM) shifts by lambda along n
  _apply(rx, ry, nx, ny, lambda, st = this) {
    st.cx += nx * lambda;
    st.cy += ny * lambda;
    st.th += (rx * ny - ry * nx) * lambda * this.invI;
  }
  _w(rx, ry, nx, ny) {
    const rn = rx * ny - ry * nx;
    return 1 + rn * rn * this.invI;
  }

  /**
   * Advance the simulation.
   * @param {number} dt
   * @param {Array<{u:number,v:number,mu:number,drive?:number,touch?:boolean}>} points
   *        contact points (local). drive = speed (m/s, +x) a gripping paw walks the body at.
   *        On return each point's `touch` says whether it touched the stairs this frame.
   */
  step(dt, points) {
    const n = Math.max(1, Math.ceil(dt / SUBSTEP));
    const h = dt / n;
    for (const p of points) p.touch = false;
    this.bellyTouch = false;
    this.impact = 0;
    const P = { x: 0, y: 0 }, P0 = { x: 0, y: 0 };
    let gripping = this._gripping, touching = this._touching;
    for (let k = 0; k < n; k++) {
      const prev = this._prev;
      prev.cx = this.cx; prev.cy = this.cy; prev.th = this.th;
      // integrate: gravity, his own muscles, then move
      this.vy -= GRAVITY * h;
      // Muscles. With a paw gripping the step, his legs brace against tipping past ~57° nose-down
      // (or 35° nose-up). In the air he does what rats do (the righting reflex): twists to stop
      // spinning. Resting on just his belly or nose he has nothing to push with, so gravity wins.
      const th = this.th;
      if (gripping) {
        const over = th < this.minTilt ? th - this.minTilt : th > this.maxTilt ? th - this.maxTilt : 0;
        this.w += (-700 * over - (over ? 35 * this.w : 0) - (4 + this.levelAssist) * th) * h;
      } else if (!touching) {
        this.w *= Math.exp(-10 * h);
      }
      this.w *= Math.exp(-3 * h);          // a little rotational damping (fur on concrete)
      this.cx += this.vx * h;
      this.cy += this.vy * h;
      this.th += this.w * h;

      // --- contacts with the treads ---
      let wall = false;
      for (const p of points) {
        this._world(p.u, p.v, this.cx, this.cy, this.th, P);
        const g = this.ground(P.x);
        const d = g - P.y;
        if (d <= 0) continue;
        this._world(p.u, p.v, prev.cx, prev.cy, prev.th, P0);
        let rx = P.x - this.cx, ry = P.y - this.cy;
        // overlap that was already there last substep is pushed out without adding any speed
        // (only a real collision this substep changes his velocity)
        const d0 = Math.max(0, this.ground(P0.x) - P0.y);
        // inside a step: out through the riser face if that's the shorter way (or it came in that way)
        const edgeX = Math.ceil(P.x / this.stepD) * this.stepD;
        const side = edgeX - P.x;
        // (only if it actually came in through the face, not down from above onto the step)
        if (side < d && (P0.x >= edgeX - 1e-4 || P0.y < this.ground(P0.x) - 0.002)) {
          const l = Math.min(side, 0.004) / this._w(rx, ry, 1, 0);
          this._apply(rx, ry, 1, 0, l);
          if (d0 > 0) this._apply(rx, ry, 1, 0, l, prev);
          wall = true; // against a riser's face: nothing to stand or grip on
          continue;
        }
        p.touch = true;
        const ln = Math.min(d, 0.004) / this._w(rx, ry, 0, 1); // (deep overlaps come out gradually)
        this._apply(rx, ry, 0, 1, ln);
        if (d0 > 0) this._apply(rx, ry, 0, 1, Math.min(d0, d, 0.004) / this._w(rx, ry, 0, 1), prev);
        this.impact = Math.max(this.impact, -(P.y - P0.y) / h);
        // friction along the tread (paws grip and walk; belly slides)
        this._world(p.u, p.v, this.cx, this.cy, this.th, P);
        rx = P.x - this.cx; ry = P.y - this.cy;
        const slip = (P.x - P0.x) - (p.drive || 0) * h;
        const wt = this._w(rx, ry, 1, 0);
        let lt = -slip / wt;
        const maxT = p.mu * ln;
        if (Math.abs(lt) > maxT) lt = Math.sign(lt) * maxT;
        this._apply(rx, ry, 1, 0, lt);
      }

      // --- his belly resting on a step's nose (the corner can't poke into him) ---
      if (this.belly) {
        const { u0, u1, v } = this.belly;
        const c = Math.cos(this.th), s = Math.sin(this.th);
        const k0 = Math.floor((this.cx - 0.35) / this.stepD), k1 = Math.ceil((this.cx + 0.35) / this.stepD);
        for (let e = k0; e <= k1; e++) {
          const ex = e * this.stepD, ey = -(e - 1) * this.stepH; // top corner of the step ending at ex
          // corner in his frame
          const dx = ex - this.cx, dy = ey - this.cy;
          const lu = c * dx + s * dy + this.com.u, lv = -s * dx + c * dy + this.com.v;
          if (lu < u0 || lu > u1) continue;
          // his underside curves up toward his chest and rump (so a corner rolls onto it smoothly)
          const a = u1 - lu, b = lu - u0;
          const rise = (a < 0.045 ? (0.045 - a) ** 2 / 0.045 : 0) + (b < 0.06 ? (0.06 - b) ** 2 / 0.06 : 0); // (round haunches)
          const d = lv - (v + rise);
          if (d <= 0 || d > 0.08) continue;
          // push him along his own "up" so the corner sits on his belly line
          const nx = -s, ny = c;
          const ln = Math.min(d, 0.003) / this._w(dx, dy, nx, ny);
          this._apply(dx, dy, nx, ny, ln);
          this.bellyTouch = true;
          // fur sliding over the concrete nose: a little friction along his body
          const tx = c, ty = s;
          const lcx = this.cx, lcy = this.cy;
          // how fast his belly is sliding past the corner (this substep)
          const bx = (lcx - prev.cx) - (this.th - prev.th) * dy, by = (lcy - prev.cy) + (this.th - prev.th) * dx;
          // (with his back legs scrabbling at the edge he pushes himself along it at bellyDrive)
          const slip = bx * tx + by * ty - this.bellyDrive * h;
          let lt = -slip / this._w(dx, dy, tx, ty);
          const maxT = (this.bellyDrive ? 0.7 : 0.15) * ln;
          if (Math.abs(lt) > maxT) lt = Math.sign(lt) * maxT;
          this._apply(dx, dy, tx, ty, lt);
        }
      }

      gripping = false; touching = this.bellyTouch || wall;
      for (const p of points) if (p.touch) { touching = true; if (p.drive !== undefined) gripping = true; }
      // velocities from what actually happened
      this.vx = (this.cx - prev.cx) / h;
      this.vy = (this.cy - prev.cy) / h;
      this.w = (this.th - prev.th) / h;
      // (no rat moves faster than this; keeps a bad overlap from ever launching him)
      const sp = Math.hypot(this.vx, this.vy);
      if (sp > 3) { this.vx *= 3 / sp; this.vy *= 3 / sp; }
      this.w = Math.max(-15, Math.min(15, this.w));
    }
    this._gripping = gripping; this._touching = touching;
  }
}
