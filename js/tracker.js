// =========================================================================
// 📷 ARUCO TRACKER — watches the webcam for the tag on your paper phone.
// Based on the class base code (js-aruco), using js-aruco2 so it can read OpenCV's 6x6 tags.
//
// Dictionaries (CONFIG.tagDictionary in main.js):
//   'ARUCO_6X6_1000'  the 6x6 tags (OpenCV DICT_6X6_50 / 100 / 250 / 1000 — same IDs in all four)
//   'ARUCO'           the "Original ArUco" tags the base code used
//
// The tag is printed UNDER the phone flap:
//   flap closed  -> no tag visible -> rat keeps dragging
//   flap pulled  -> tag visible    -> FLASH, rat hides
// =========================================================================

import { ShapeTagFinder } from './shapetag.js';

export class Tracker {
  /**
   * @param {object} opts
   * @param {number|null} opts.triggerId  Which tag ID counts. null = any tag.
   * @param {string} opts.dictionary      Which ArUco dictionary the printed tag comes from
   * @param {number|null} opts.maxErrors  How many misread squares a tag can have and still count
   *                                      (null = the library's default for that dictionary)
   * @param {boolean} opts.inShapes       Also find a tag printed inside a solid black shape (the apple)
   * @param {number} opts.seenFrames      Detections in a row needed to count as "pulled"
   * @param {number} opts.lostFrames      Misses in a row needed to count as "closed"
   */
  constructor({ triggerId = null, dictionary = 'ARUCO_6X6_1000', maxErrors = 3, inShapes = true, seenFrames = 2, lostFrames = 8 } = {}) {
    this.triggerId = triggerId;
    this.dictionary = dictionary;
    this.maxErrors = dictionary === 'ARUCO' ? null : maxErrors;
    this.shapes = inShapes ? new ShapeTagFinder() : null;
    this.seenFrames = seenFrames;
    this.lostFrames = lostFrames;

    this.video = document.getElementById('webcam');
    this.preview = document.getElementById('camPreview');
    this.pctx = this.preview.getContext('2d');
    this.status = document.getElementById('status');

    // Off-screen canvas the computer vision reads pixels from
    this.work = document.createElement('canvas');
    this.work.width = 640;
    this.work.height = 480;
    this.wctx = this.work.getContext('2d', { willReadFrequently: true });

    this.detector = null;
    this.ready = false;
    this.visible = false; // debounced result: is the tag showing?
    this._seen = 0;
    this._lost = 0;
    this.lastMarkers = [];
  }

  async start() {
    try {
      this.detector = this._makeDetector();
    } catch (err) {
      console.error(err);
      this.status.textContent = 'Tag reader failed to load — hold space';
      this.status.style.color = '#ff8a80';
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
      });
      this.video.srcObject = stream;
      await new Promise((r) => (this.video.onloadedmetadata = r));
      await this.video.play();
      this.ready = true;
      this.status.textContent = 'Looking for tag…';
    } catch (err) {
      console.warn('Webcam unavailable:', err);
      this.status.textContent = 'No camera — hold space';
      this.status.style.color = '#ff8a80';
    }
  }

  _makeDetector() {
    const dict = AR.DICTIONARIES[this.dictionary];
    if (!dict) throw new Error(`ArUco dictionary "${this.dictionary}" isn't loaded (see the <script> tags in index.html)`);
    let detector;
    if (this.maxErrors === null) {
      detector = new AR.Detector({ dictionaryName: this.dictionary });
    } else {
      // (the library accepts a code that's off by fewer than maxHammingDistance squares)
      const maxHammingDistance = this.maxErrors + 1;
      // (skip the library measuring all 1000 codes against each other at startup; we set the tolerance anyway)
      if (dict.tau == null) dict.tau = maxHammingDistance;
      detector = new AR.Detector({ dictionaryName: this.dictionary, maxHammingDistance });
    }
    fasterLookup(detector.dictionary);
    return detector;
  }

  // Call once per animation frame
  update() {
    if (!this.ready || this.video.readyState < this.video.HAVE_ENOUGH_DATA) return this.visible;

    this.wctx.drawImage(this.video, 0, 0, 640, 480);
    const img = this.wctx.getImageData(0, 0, 640, 480);
    const markers = this.detector.detect(img);
    const isHit = (m) => this.triggerId === null || m.id === this.triggerId;
    // no ordinary tag in view? look for one hidden inside a black shape (the apple)
    if (this.shapes && !markers.some(isHit)) {
      for (const m of this.shapes.find(this.detector)) {
        if (!markers.some((o) => o.id === m.id && near(o, m))) markers.push(m);
      }
    }
    const hits = markers.filter(isHit);
    this.lastMarkers = hits;

    if (hits.length) {
      this._seen++;
      this._lost = 0;
    } else {
      this._lost++;
      this._seen = 0;
    }
    if (!this.visible && this._seen >= this.seenFrames) this.visible = true;
    if (this.visible && this._lost >= this.lostFrames) this.visible = false;

    this._drawPreview(markers);
    return this.visible;
  }

  _drawPreview(markers) {
    const c = this.pctx;
    const sx = this.preview.width / 640;
    const sy = this.preview.height / 480;
    c.drawImage(this.video, 0, 0, this.preview.width, this.preview.height);
    markers.forEach((m) => {
      const hit = this.triggerId === null || m.id === this.triggerId;
      c.beginPath();
      m.corners.forEach((p, i) => (i ? c.lineTo(p.x * sx, p.y * sy) : c.moveTo(p.x * sx, p.y * sy)));
      c.closePath();
      c.lineWidth = 3;
      c.strokeStyle = hit ? '#ff2e88' : '#888';
      c.stroke();
    });
    this.status.textContent = this.visible
      ? `Tag ${this.lastMarkers[0]?.id ?? ''} — flap pulled!`
      : 'Flap closed';
  }
}

// When a square on camera isn't exactly a known code, the library compares it with every code in the
// dictionary one character at a time (~1.5 ms per square for the 1000 6x6 codes). This does the same
// comparison with bit arithmetic, same answers, ~50x faster.
function fasterLookup(dictionary) {
  const CHUNK = 24; // bits per number (safe for JS bitwise maths)
  const toChunks = (str) => {
    const out = [];
    for (let e = str.length; e > 0; e -= CHUNK) out.push(parseInt(str.slice(Math.max(0, e - CHUNK), e), 2));
    return out;
  };
  const popcount = (v) => {
    v -= (v >>> 1) & 0x55555555;
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  };
  const codes = dictionary.codeList.map(toChunks);
  dictionary.find = function (bits) {
    const str = bits.map((row) => row.join('')).join('');
    const exact = this.codes[str];
    if (exact) return { id: exact.id, distance: 0 };
    const v = toChunks(str);
    let best;
    for (let i = 0; i < codes.length; i++) {
      let d = 0;
      for (let k = 0; k < v.length; k++) d += popcount(v[k] ^ codes[i][k]);
      if (d < this.tau && (!best || d < best.distance)) best = { id: this.codes[this.codeList[i]].id, distance: d };
    }
    return best;
  };
}

// do two detections sit on the same spot?
function near(a, b) {
  const c = (m) => m.corners.reduce((s, p) => ({ x: s.x + p.x / 4, y: s.y + p.y / 4 }), { x: 0, y: 0 });
  const p = c(a), q = c(b);
  return Math.hypot(p.x - q.x, p.y - q.y) < 20;
}
