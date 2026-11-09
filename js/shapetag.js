// =========================================================================
// 🍎 TAG HIDDEN IN A BLACK SHAPE — finds an ArUco tag printed inside a solid black shape, like the
// one inside the Apple logo on the paper phone.
//
// The normal ArUco reader starts by looking for the white edge round a tag's black border (a square
// outline). Inside the apple there's no such edge: the tag's black border melts into the apple's
// black. So instead:
//   1. sort the picture into light and dark, each spot judged against its surroundings (so shadows
//      across the paper don't matter)
//   2. find white spots completely enclosed by one dark shape (the tag's white squares in the apple)
//   3. the tightest box round a cluster of those spots is the tag's inner grid (6x6 squares). (That needs the
//      tag's white squares to reach all four sides of its grid; they do in tag 0.) Each side of the
//      box is then fitted to the spots, so a phone tilted away from the camera still lines up.
//   4. grow the box by one square all round (the black border) and hand it to the normal ArUco
//      reader, which checks that border is black and reads the code exactly as for any other tag
// =========================================================================

const TILE = 8;           // px: light/dark is judged per tile...
const REACH = 8;          // ...against the darkest and lightest grey within this many tiles (~±70 px)
const MIN_CONTRAST = 24;  // grey levels: an area flatter than this has no print in it (counts as dark)
const MIN_HOLE = 4;       // px: white specks smaller than this are noise
const MAX_HOLES = 64;     // a shape with more white spots than this isn't a tag
const MIN_SQUARE = 3;     // px: the tag's squares have to be at least this big on camera to read

export class ShapeTagFinder {
  constructor() {
    this._w = 0;
    this._h = 0;
  }

  /**
   * Tags found inside dark shapes. Call right after detector.detect() (it reuses that greyscale image).
   * @returns {Array<{id:number, corners:{x:number,y:number}[]}>}
   */
  find(detector) {
    const grey = detector.grey;
    const W = grey.width, H = grey.height;
    if (!W || !H) return [];
    this._alloc(W, H);
    this._threshold(grey.data, W, H);
    const n = detector.dictionary.markSize - 2; // squares across the tag's inner grid (6 for 6x6 tags)
    const markers = [];
    for (const group of this._holeGroups(W, H)) {
      const quad = this._markerQuad(group, n, W, H);
      if (!quad) continue;
      markers.push(...detector.findMarkers(grey, detector.clockwiseCorners([quad]), 49));
    }
    return markers;
  }

  _alloc(W, H) {
    if (W === this._w && H === this._h) return;
    this._w = W;
    this._h = H;
    this.white = new Uint8Array(W * H);
    this.rowStart = new Int32Array(H + 1);
    this.cap = 1 << 15; // runs (grows if a busy picture needs more)
    this.X0 = new Int32Array(this.cap);
    this.X1 = new Int32Array(this.cap);
    this.Y = new Int32Array(this.cap);
    this.P = new Int32Array(this.cap);
    this.C = new Uint8Array(this.cap);
    this.tw = Math.ceil(W / TILE);
    this.th = Math.ceil(H / TILE);
    const nt = this.tw * this.th;
    this.tmin = new Uint8Array(nt);
    this.tmax = new Uint8Array(nt);
    this.tmp = new Uint8Array(nt);
  }

  // ---- 1. light or dark, judged locally -------------------------------------------------------
  _threshold(px, W, H) {
    const { tw, th, tmin, tmax, white } = this;
    for (let ty = 0; ty < th; ty++) {
      for (let tx = 0; tx < tw; tx++) {
        let mn = 255, mx = 0;
        const y1 = Math.min(H, (ty + 1) * TILE), x0 = tx * TILE, x1 = Math.min(W, x0 + TILE);
        for (let y = ty * TILE; y < y1; y++) {
          for (let i = y * W + x0, e = y * W + x1; i < e; i++) {
            const v = px[i];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
        }
        tmin[ty * tw + tx] = mn;
        tmax[ty * tw + tx] = mx;
      }
    }
    this._spread(tmin, false);
    this._spread(tmax, true);
    // light = brighter than halfway between the darkest and lightest grey nearby
    for (let y = 0; y < H; y++) {
      const trow = ((y / TILE) | 0) * tw;
      for (let x = 0, i = y * W; x < W; x++, i++) {
        const t = trow + ((x / TILE) | 0);
        const mn = tmin[t], mx = tmax[t];
        white[i] = mx - mn >= MIN_CONTRAST && px[i] * 2 > mn + mx ? 1 : 0;
      }
    }
  }

  // min (or max) over the neighbouring REACH tiles, in two passes (across, then down)
  _spread(a, isMax) {
    const { tw, th, tmp } = this;
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        let v = a[y * tw + x];
        for (let k = Math.max(0, x - REACH), e = Math.min(tw - 1, x + REACH); k <= e; k++) {
          const u = a[y * tw + k];
          if (isMax ? u > v : u < v) v = u;
        }
        tmp[y * tw + x] = v;
      }
    }
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        let v = tmp[y * tw + x];
        for (let k = Math.max(0, y - REACH), e = Math.min(th - 1, y + REACH); k <= e; k++) {
          const u = tmp[k * tw + x];
          if (isMax ? u > v : u < v) v = u;
        }
        a[y * tw + x] = v;
      }
    }
  }

  // ---- 2. white spots enclosed by one dark shape, grouped by shape and closeness ---------------
  // Each row is cut into runs of light or dark; runs that touch the row above join up (union-find).
  // Dark shapes join diagonally too (8-connected), white spots only edge to edge (4-connected).
  _holeGroups(W, H) {
    const { white } = this;
    // runs, row by row
    let n = 0;
    const rowStart = this.rowStart;
    for (let y = 0; y < H; y++) {
      rowStart[y] = n;
      const row = y * W;
      for (let x = 0; x < W; ) {
        const c = white[row + x], x0 = x;
        while (x < W && white[row + x] === c) x++;
        if (n === this.cap) this._grow();
        this.X0[n] = x0; this.X1[n] = x - 1; this.Y[n] = y; this.C[n] = c; this.P[n] = n;
        n++;
      }
    }
    rowStart[H] = n;
    const { X0, X1, Y, C, P } = this;
    const find = (a) => {
      let r = a;
      while (P[r] !== r) r = P[r];
      while (P[a] !== r) { const nx = P[a]; P[a] = r; a = nx; }
      return r;
    };
    const union = (a, b) => {
      a = find(a); b = find(b);
      if (a !== b) { if (a < b) P[b] = a; else P[a] = b; }
    };
    // join runs to the row above; note where light meets dark
    const adj = [];
    for (let y = 0; y < H; y++) {
      const r0 = rowStart[y], r1 = rowStart[y + 1];
      for (let j = r0; j + 1 < r1; j++) adj.push(j, j + 1); // side by side in the row
      if (y === 0) continue;
      let i = rowStart[y - 1];
      for (let j = r0; j < r1; j++) {
        const b0 = X0[j], b1 = X1[j], cj = C[j];
        while (X1[i] < b0 - 1) i++;
        for (let k = i; k < r0 && X0[k] <= b1 + 1; k++) {
          const shares = X0[k] <= b1 && b0 <= X1[k];
          if (C[k] === cj) { if (shares || cj === 0) union(k, j); }
          else if (shares) adj.push(k, j);
        }
      }
    }
    // each shape's / spot's box, size and whether it touches the picture's edge
    const comp = new Map();
    for (let k = 0; k < n; k++) {
      const r = find(k);
      let c = comp.get(r);
      if (!c) comp.set(r, (c = { x0: W, y0: H, x1: -1, y1: -1, area: 0, edge: false, white: C[k] === 1, around: null, runs: null }));
      if (X0[k] < c.x0) c.x0 = X0[k];
      if (X1[k] > c.x1) c.x1 = X1[k];
      if (Y[k] < c.y0) c.y0 = Y[k];
      if (Y[k] > c.y1) c.y1 = Y[k];
      c.area += X1[k] - X0[k] + 1;
      if (X0[k] === 0 || X1[k] === W - 1 || Y[k] === 0 || Y[k] === H - 1) c.edge = true;
    }
    // which dark shapes each white spot touches
    for (let a = 0; a < adj.length; a += 2) {
      let w = find(adj[a]), d = find(adj[a + 1]);
      if (!comp.get(w).white) [w, d] = [d, w];
      const c = comp.get(w);
      if (c.edge || c.area < MIN_HOLE) continue;
      if (!c.around) c.around = [];
      if (!c.around.includes(d)) c.around.push(d);
    }
    // keep the spots one dark shape encloses: the shape whose box goes round the spot. Any other dark
    // shape it touches must be an island inside it (a black square in the middle of a white patch).
    const holesOf = new Map();
    for (const [r, c] of comp) {
      if (!c.white || !c.around) continue;
      let outer = 0;
      for (const L of c.around) {
        const b = comp.get(L);
        if (b.x0 < c.x0 && b.y0 < c.y0 && b.x1 > c.x1 && b.y1 > c.y1) {
          if (outer) { outer = -1; break; }
          outer = L;
        } else if (!(b.x0 >= c.x0 && b.y0 >= c.y0 && b.x1 <= c.x1 && b.y1 <= c.y1)) {
          outer = -1;
          break;
        }
      }
      if (outer <= 0) continue;
      c.runs = [];
      let list = holesOf.get(outer);
      if (!list) holesOf.set(outer, (list = []));
      list.push(c);
    }
    for (let k = 0; k < n; k++) if (C[k]) { const c = comp.get(find(k)); if (c.runs) c.runs.push(k); }

    // within a shape, spots that sit close together (gaps under ~3 squares) belong to one tag
    const groups = [];
    for (const holes of holesOf.values()) {
      if (holes.length > MAX_HOLES) continue;
      const sizes = holes.map((h) => Math.min(h.x1 - h.x0, h.y1 - h.y0) + 1).sort((a, b) => a - b);
      const gap = 3 * sizes[sizes.length >> 1];
      const parent = holes.map((_, i) => i);
      const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
      for (let i = 0; i < holes.length; i++) {
        for (let j = i + 1; j < holes.length; j++) {
          const a = holes[i], b = holes[j];
          const gx = Math.max(a.x0 - b.x1, b.x0 - a.x1, 0), gy = Math.max(a.y0 - b.y1, b.y0 - a.y1, 0);
          if (gx <= gap && gy <= gap) parent[root(i)] = root(j);
        }
      }
      const byRoot = new Map();
      holes.forEach((h, i) => {
        const r = root(i);
        if (!byRoot.has(r)) byRoot.set(r, []);
        byRoot.get(r).push(h);
      });
      for (const g of byRoot.values()) groups.push(g);
    }
    return groups;
  }

  _grow() {
    const cap = this.cap * 2;
    for (const k of ['X0', 'X1', 'Y', 'P']) { const a = new Int32Array(cap); a.set(this[k]); this[k] = a; }
    const c = new Uint8Array(cap); c.set(this.C); this.C = c;
    this.cap = cap;
  }

  // ---- 3 + 4. the box round a group of white spots -> the whole tag's four corners ------------
  _markerQuad(group, n, W, H) {
    const { X0, X1, Y } = this;
    // outline of the white spots: the ends of their runs (pixel corners, so the box is the true edge)
    const pts = [];
    for (const h of group) {
      for (const k of h.runs) {
        const y = Y[k], a = X0[k], b = X1[k] + 1;
        pts.push([a, y], [b, y], [a, y + 1], [b, y + 1]);
      }
    }
    if (pts.length < 8) return null;
    const hull = convexHull(pts);
    if (hull.length < 3) return null;
    const rect = minAreaRect(hull);
    if (!rect) return null;
    const [s1, s2] = rect.sides;
    if (Math.min(s1, s2) < n * MIN_SQUARE || Math.max(s1, s2) > 1.6 * Math.min(s1, s2)) return null;
    const grid = fitSides(hull, rect.corners) || rect.corners;
    // the grid is the middle of the tag (6x6 of 8x8): grow it by one square all round, in perspective
    const m = squareToQuad(grid);
    const o = -1 / n, f = 1 + 1 / n;
    const quad = [m(o, o), m(f, o), m(f, f), m(o, f)];
    for (const p of quad) if (!(p.x >= 1 && p.y >= 1 && p.x <= W - 2 && p.y <= H - 2)) return null;
    return quad;
  }
}

// ---- geometry -----------------------------------------------------------------------------------

function convexHull(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// smallest rectangle round the hull (one of its sides always lies along a hull edge)
function minAreaRect(hull) {
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uy, v = -p[0] * uy + p[1] * ux;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ux, uy, u0, u1, v0, v1 };
  }
  if (!best) return null;
  const { ux, uy, u0, u1, v0, v1 } = best;
  const at = (u, v) => ({ x: u * ux - v * uy, y: u * uy + v * ux });
  return { corners: [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)], sides: [u1 - u0, v1 - v0] };
}

// Refit each side of the rectangle to the hull points lying along it, so a grid seen in perspective
// (a trapezoid, not a rectangle) gets its true corners. Returns null if that doesn't look right.
function fitSides(hull, corners) {
  let lines = [];
  for (let k = 0; k < 4; k++) lines.push(lineThrough(corners[k], corners[(k + 1) % 4]));
  const side = Math.min(
    Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y),
    Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y)
  );
  const tol = 0.12 * side;
  for (let pass = 0; pass < 2; pass++) {
    lines = lines.map((L) => {
      const near = hull.filter((p) => Math.abs((p[0] - L.px) * L.nx + (p[1] - L.py) * L.ny) <= tol);
      if (near.length < 2) return L;
      // they must spread along at least a third of the side to pin its angle
      let t0 = Infinity, t1 = -Infinity;
      for (const p of near) {
        const t = (p[0] - L.px) * L.dx + (p[1] - L.py) * L.dy;
        if (t < t0) t0 = t;
        if (t > t1) t1 = t;
      }
      if (t1 - t0 < side / 3) return L;
      return fitLine(near) || L;
    });
  }
  const out = [];
  for (let k = 0; k < 4; k++) {
    const p = intersect(lines[(k + 3) % 4], lines[k]);
    if (!p || Math.hypot(p.x - corners[k].x, p.y - corners[k].y) > 0.25 * side) return null;
    out.push(p);
  }
  return out;
}

function lineThrough(a, b) {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const dx = (b.x - a.x) / len, dy = (b.y - a.y) / len;
  return { px: a.x, py: a.y, dx, dy, nx: -dy, ny: dx };
}

// least-squares line through points (their main direction)
function fitLine(pts) {
  let mx = 0, my = 0;
  for (const p of pts) { mx += p[0]; my += p[1]; }
  mx /= pts.length; my /= pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) {
    const x = p[0] - mx, y = p[1] - my;
    sxx += x * x; sxy += x * y; syy += y * y;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dx = Math.cos(ang), dy = Math.sin(ang);
  return { px: mx, py: my, dx, dy, nx: -dy, ny: dx };
}

function intersect(a, b) {
  const den = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / den;
  return { x: a.px + t * a.dx, y: a.py + t * a.dy };
}

// perspective map of the unit square onto a quad (corners for (0,0), (1,0), (1,1), (0,1)) — Heckbert
function squareToQuad([p0, p1, p2, p3]) {
  const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y;
  let g = 0, h = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + h * p3.x, c = p0.x;
  const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + h * p3.y, f = p0.y;
  return (u, v) => {
    const w = g * u + h * v + 1;
    return { x: (a * u + b * v + c) / w, y: (d * u + e * v + f) / w };
  };
}
