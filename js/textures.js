// =========================================================================
// 🎨 PROCEDURAL TEXTURES — drawn with the 2D canvas, so there are no image files.
// =========================================================================
import * as THREE from 'three';

export function makeCanvas(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  return c;
}

export function texFrom(canvasEl, { srgb = true, repeat = [1, 1], offset = [0, 0] } = {}) {
  const t = new THREE.CanvasTexture(canvasEl);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(...repeat);
  t.offset.set(...offset);
  t.anisotropy = 8;
  return t;
}

const rand = (a, b) => a + Math.random() * (b - a);

// Worn concrete with stains and flattened gum
export const concreteCanvas = makeCanvas(512, 512, (g, w, h) => {
  g.fillStyle = '#6e6a63';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 14000; i++) {
    const v = rand(70, 140);
    g.fillStyle = `rgba(${v},${v * 0.97},${v * 0.92},${rand(0.25, 0.65)})`;
    const s = Math.random() < 0.9 ? 1 : 2;
    g.fillRect(Math.random() * w, Math.random() * h, s, s);
  }
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * w, y = Math.random() * h, r = rand(20, 110);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(28,24,20,0.28)');
    gr.addColorStop(1, 'rgba(28,24,20,0)');
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 10; i++) {
    const x = Math.random() * w, y = Math.random() * h, r = rand(3, 8);
    g.fillStyle = '#3b3733';
    g.beginPath();
    g.ellipse(x, y, r, r * 0.8, Math.random() * 3, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(140,135,128,0.5)';
    g.stroke();
  }
});

// Classic white subway tile, 4 x 4 tiles per repeat (each 15cm x 7.5cm)
export const tileCanvas = makeCanvas(512, 256, (g, w, h) => {
  g.fillStyle = '#8c877b';
  g.fillRect(0, 0, w, h);
  const tw = w / 4, th = h / 4;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const x = c * tw + 3, y = r * th + 3, ww = tw - 6, hh = th - 6;
      const v = rand(222, 236);
      g.fillStyle = `rgb(${v},${v - 4},${v - 16})`;
      g.fillRect(x, y, ww, hh);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(x, y, ww, 3);
      g.fillStyle = 'rgba(60,50,40,0.18)';
      g.fillRect(x, y + hh - 4, ww, 4);
    }
  }
  for (let i = 0; i < 18; i++) {
    const x = Math.random() * w;
    const gr = g.createLinearGradient(0, h, 0, h * Math.random());
    gr.addColorStop(0, 'rgba(70,55,35,0.22)');
    gr.addColorStop(1, 'rgba(70,55,35,0)');
    g.fillStyle = gr;
    g.fillRect(x, 0, rand(6, 36), h);
  }
});

// Sooty concrete for the track pit
export const sootCanvas = makeCanvas(256, 256, (g, w, h) => {
  g.fillStyle = '#2a2826';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 5000; i++) {
    const v = rand(20, 70);
    g.fillStyle = `rgba(${v},${v},${v * 0.95},0.6)`;
    g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
});

// Black station sign with white lettering and a colored line bullet, e.g. "Spring St" + 6
export function stationSignCanvas(name, line, lineColor = '#ff6319') {
  return makeCanvas(1024, 210, (g, w, h) => {
    g.fillStyle = '#111214';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 14, w, 6);
    const maxW = w - 96 - (line ? 150 : 0);
    let size = 120;
    do {
      g.font = `bold ${size}px Helvetica, Arial, sans-serif`;
      size -= 4;
    } while (g.measureText(name).width > maxW && size > 40);
    g.textBaseline = 'middle';
    g.fillText(name, 48, h / 2 + 12);
    if (line) {
      const r = 62, cx = w - 48 - r, cy = h / 2 + 12;
      g.fillStyle = lineColor;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ffffff';
      g.font = 'bold 96px Helvetica, Arial, sans-serif';
      g.textAlign = 'center';
      g.fillText(line, cx, cy + 4);
    }
  });
}

// Two-line black column sign, like the ones bolted to the station's columns
export function columnSignCanvas(lines) {
  return makeCanvas(512, 360, (g, w, h) => {
    g.fillStyle = '#141516';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#6b6d70';
    g.lineWidth = 8;
    g.strokeRect(10, 10, w - 20, h - 20);
    g.fillStyle = '#f2f2f2';
    g.font = 'bold 92px Helvetica, Arial, sans-serif';
    g.textBaseline = 'top';
    lines.forEach((t, i) => g.fillText(t, 40, 60 + i * 120));
  });
}

// Navy mosaic stripe that runs along the tile wall
export const navyBandCanvas = makeCanvas(512, 32, (g, w, h) => {
  for (let x = 0; x < w; x += 8) {
    for (let y = 0; y < h; y += 8) {
      const v = rand(-12, 12);
      g.fillStyle = `rgb(${44 + v},${46 + v},${110 + v})`;
      g.fillRect(x, y, 7, 7);
    }
  }
  g.fillStyle = 'rgba(30,30,40,0.6)';
  for (let x = 7; x < w; x += 8) g.fillRect(x, 0, 1, h);
  for (let y = 7; y < h; y += 8) g.fillRect(0, y, w, 1);
});

// Small black tile plaque with the name, e.g. "SPRING"
export function namePlaqueCanvas(text, { bg = '#0f0f10', fg = '#ffffff' } = {}) {
  return makeCanvas(256, 64, (g, w, h) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = fg;
    g.font = 'bold 44px Helvetica, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + 2);
    g.strokeStyle = 'rgba(70,70,70,0.6)';
    for (let x = 0; x <= w; x += 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y <= h; y += 16) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  });
}

// Solid tile band in any color (e.g. the royal blue stripe at Spring St)
export function bandCanvas(r, gr, b) {
  return makeCanvas(512, 32, (g, w, h) => {
    for (let x = 0; x < w; x += 8) {
      for (let y = 0; y < h; y += 8) {
        const v = rand(-14, 14);
        g.fillStyle = `rgb(${r + v},${gr + v},${b + v})`;
        g.fillRect(x, y, 7, 7);
      }
    }
    g.fillStyle = 'rgba(20,20,30,0.5)';
    for (let x = 7; x < w; x += 8) g.fillRect(x, 0, 1, h);
    for (let y = 7; y < h; y += 8) g.fillRect(0, y, w, 1);
  });
}

// Mosaic station-name sign: text drawn tiny, then scaled up with no smoothing so it reads
// as little tiles. Spring St style: white letters on dark navy, framed in royal blue.
export function mosaicSignCanvas(name, { field = '#16204a', letters = '#f4f1e8', border = '#1f45b0' } = {}) {
  const small = makeCanvas(96, 24, (g, w, h) => {
    g.fillStyle = border;
    g.fillRect(0, 0, w, h);
    g.fillStyle = field;
    g.fillRect(2, 2, w - 4, h - 4);
    g.fillStyle = letters;
    g.font = 'bold 15px "Arial Narrow", Helvetica, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(name, w / 2, h / 2 + 1, w - 8);
  });
  return makeCanvas(1152, 288, (g, w, h) => {
    g.imageSmoothingEnabled = false;
    g.drawImage(small, 0, 0, w, h);
    // grout lines between the little mosaic tiles, plus a little color wobble per tile
    for (let x = 0; x < w; x += 12) {
      for (let y = 0; y < h; y += 12) {
        g.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},${rand(0, 0.08)})`;
        g.fillRect(x, y, 11, 11);
      }
    }
    g.fillStyle = 'rgba(40,40,50,0.45)';
    for (let x = 11; x < w; x += 12) g.fillRect(x, 0, 1, h);
    for (let y = 11; y < h; y += 12) g.fillRect(0, y, w, 1);
  });
}

// One subway car side: ribbed stainless steel, doors, lit windows with riders
export function trainSideCanvases() {
  const W = 1536, H = 248;
  const doors = [0.1, 0.36, 0.64, 0.9];
  const winTop = 0.3 * H, winBot = 0.6 * H;
  const riders = [];
  for (let i = 0; i < 14; i++) riders.push({ x: Math.random() * W, s: rand(0.8, 1.15) });

  const isDoor = (x) => doors.some((d) => Math.abs(x / W - d) < 0.035);

  const color = makeCanvas(W, H, (g) => {
    g.fillStyle = '#b9bdc1';
    g.fillRect(0, 0, W, H);
    for (let x = 0; x < W; x += 6) {
      g.fillStyle = x % 12 ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.10)';
      g.fillRect(x, 0, 3, H);
    }
    // roof shadow and skirt
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(0, 0, W, 10);
    g.fillStyle = '#5d6166';
    g.fillRect(0, H - 18, W, 18);
    // windows
    for (let x = 0; x < W; x += 2) {
      if (!isDoor(x)) {
        g.fillStyle = '#1b2329';
        g.fillRect(x, winTop, 2, winBot - winTop);
      }
    }
    // window frames between panes
    g.fillStyle = '#8d9196';
    for (let x = 0; x < W; x += W / 14) if (!isDoor(x)) g.fillRect(x - 4, winTop, 8, winBot - winTop);
    // doors with their own windows
    doors.forEach((d) => {
      const x = d * W - 0.033 * W, w = 0.066 * W;
      g.fillStyle = '#a7abb0';
      g.fillRect(x, 0.12 * H, w, 0.84 * H);
      g.strokeStyle = '#4a4d51';
      g.lineWidth = 3;
      g.strokeRect(x, 0.12 * H, w, 0.84 * H);
      g.beginPath();
      g.moveTo(x + w / 2, 0.12 * H);
      g.lineTo(x + w / 2, 0.96 * H);
      g.stroke();
      g.fillStyle = '#1b2329';
      g.fillRect(x + 8, winTop, w / 2 - 14, winBot - winTop - 10);
      g.fillRect(x + w / 2 + 6, winTop, w / 2 - 14, winBot - winTop - 10);
    });
    g.fillStyle = '#222';
    g.font = 'bold 11px Helvetica, Arial, sans-serif';
    g.fillText(String(Math.floor(rand(1000, 9999))), 0.22 * W, 0.8 * H);
  });

  const emissive = makeCanvas(W, H, (g) => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    const lit = g.createLinearGradient(0, winTop, 0, winBot);
    lit.addColorStop(0, '#fff3d0');
    lit.addColorStop(1, '#d8c79a');
    for (let x = 0; x < W; x += 2) {
      if (!isDoor(x)) { g.fillStyle = lit; g.fillRect(x, winTop + 4, 2, winBot - winTop - 8); }
    }
    doors.forEach((d) => {
      const x = d * W - 0.033 * W, w = 0.066 * W;
      g.fillStyle = lit;
      g.fillRect(x + 8, winTop, w / 2 - 14, winBot - winTop - 10);
      g.fillRect(x + w / 2 + 6, winTop, w / 2 - 14, winBot - winTop - 10);
    });
    // soft rider silhouettes behind frosted, scratched glass
    g.save();
    g.filter = 'blur(2.5px)';
    g.fillStyle = 'rgba(40,34,28,0.7)';
    riders.forEach(({ x, s }) => {
      if (isDoor(x)) return;
      g.beginPath();
      g.ellipse(x, winTop + 30 * s, 7 * s, 9 * s, 0, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.ellipse(x, winBot + 2, 17 * s, 22 * s, 0, 0, Math.PI * 2);
      g.fill();
    });
    g.restore();
    // window frames between panes
    g.fillStyle = '#000';
    for (let x = 0; x < W; x += W / 14) if (!isDoor(x)) g.fillRect(x - 4, winTop, 8, winBot - winTop);
  });
  return { color, emissive };
}
