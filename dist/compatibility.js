import { Vector3 } from 'three';

// Compatibility view for browsers without WebGL. Rust remains the sole owner
// of generation, heat, fuel, suppression, and spreading; this is a visual adapter.
const TAU = Math.PI * 2;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const fract = x => x - Math.floor(x);
const hash = (x, z, s = 0) => fract(Math.sin(x * 127.1 + z * 311.7 + s * 73.31) * 43758.5453);
const blend = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;
const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const smooth = (a, b, value) => { const t = clamp((value - a) / (b - a)); return t * t * (3 - 2 * t); };
const noiseTable = (() => {
  const a = new Float32Array(2048); let s = 74973;
  for (let i = 0; i < a.length; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; a[i] = (s >>> 0) / 4294967296; }
  return a;
})();
function noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = noiseTable[((iy & 7) << 8) + (ix & 255)], b = noiseTable[((iy & 7) << 8) + ((ix + 1) & 255)];
  const c = noiseTable[(((iy + 1) & 7) << 8) + (ix & 255)], d = noiseTable[(((iy + 1) & 7) << 8) + ((ix + 1) & 255)];
  return a + (b - a) * u + ((c - a) + (d - c - b + a) * u) * v;
}
const fbm = (x, y) => noise2(x, y) * .57 + noise2(x * 2.03 + 11.8, y * 2 + 8.2) * .28 + noise2(x * 4.11 + 27.7, y * 4 + 6.9) * .15;
const COMPAT_QUALITY = {
  low: { smokeWidth: 320, smokeLimit: 280, smokeBudget: 2.6, emberLimit: 32, treePixelCutoff: 1.8 },
  medium: { smokeWidth: 480, smokeLimit: 650, smokeBudget: 4, emberLimit: 64, treePixelCutoff: .9 },
  high: { smokeWidth: 640, smokeLimit: 1000, smokeBudget: 5.5, emberLimit: 96, treePixelCutoff: .7 },
};
const HEAT_COLORS = [[49,86,118], [81,182,170], [255,204,105], [243,78,54]];
const FUEL_COLORS = [[66,59,54], [216,162,93], [129,179,110]];

function reconstructField(data, scratch, width, height, x0, y0, x1, y1) {
  // A one-pixel, mass-conserving reconstruction filter smooths the sampled
  // optical volume. It does not move or create physical smoke parcels.
  const left = Math.max(0, x0 - 1), right = Math.min(width - 1, x1 + 1);
  const top = Math.max(0, y0 - 1), bottom = Math.min(height - 1, y1 + 1);
  for (let y = Math.max(0, top - 1); y <= Math.min(height - 1, bottom + 1); y++) {
    for (let x = left; x <= right; x++) {
      const i = y * width + x;
      scratch[i] = data[i] * .5 + (x > 0 ? data[i - 1] : 0) * .25 + (x + 1 < width ? data[i + 1] : 0) * .25;
    }
  }
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
    const i = y * width + x;
    data[i] = scratch[i] * .5 + (y > 0 ? scratch[i - width] : 0) * .25 + (y + 1 < height ? scratch[i + width] : 0) * .25;
  }
}

function makePine(variant, charStage) {
  const image = canvas(132, 310), c = image.getContext('2d');
  const cx = 66, base = 301, top = 8;
  const palettes = [[74,93,47],[58,83,48],[67,91,60],[91,103,53],[52,77,58],[79,92,52]];
  const pine = palettes[variant % palettes.length];
  const brown = [91,65,37], charcoal = [24,26,22];
  const color = charStage === 1 ? blend(pine, brown, .68) : charStage === 2 ? blend(brown, charcoal, .65) : charStage === 3 ? charcoal : pine;
  const trunk = c.createLinearGradient(cx - 4, 0, cx + 5, 0);
  trunk.addColorStop(0, charStage > 1 ? '#20201a' : '#6e6042');
  trunk.addColorStop(.4, charStage > 1 ? '#353127' : '#a08b60');
  trunk.addColorStop(1, charStage > 1 ? '#151812' : '#413c29');
  c.fillStyle = trunk;
  c.beginPath(); c.moveTo(cx - 4.3, base); c.lineTo(cx - 1.1, top + 6); c.lineTo(cx + 1, top); c.lineTo(cx + 4.5, base); c.closePath(); c.fill();
  // Drooping, serrated sprays rather than stacked solid triangles.
  for (let tier = 0; tier < 15; tier++) {
    const u = tier / 15, y = 265 - tier * 16.7, radius = 57 * Math.pow(1 - u, .88);
    for (let j = 0; j < 9; j++) {
      const angle = j / 9 * TAU + tier * 2.399 + variant * .71;
      const side = Math.cos(angle), away = Math.sin(angle);
      const r = radius * (.81 + hash(tier, j, variant) * .22);
      const endX = cx + side * r, endY = y + away * r * .15 + 12 + hash(j, tier) * 5;
      const brightness = .75 + (-side * .11) + (-away * .12) + hash(j, tier, variant) * .16;
      c.strokeStyle = charStage > 1 ? '#28291f' : '#5d5938';
      c.lineWidth = Math.max(.7, 2.1 - tier * .09);
      c.beginPath(); c.moveTo(cx, y - 15); c.quadraticCurveTo(cx + side * r * .62, y - 2, endX, endY); c.stroke();
      if (charStage === 3 && hash(tier, j, variant) > .12) continue;
      const fill = color.map(v => Math.round(v * brightness));
      c.fillStyle = rgb(fill);
      c.beginPath(); c.moveTo(cx, y - 19);
      for (let k = 1; k <= 7; k++) {
        const t = k / 7, serration = k % 2 ? 4.6 : -.8;
        c.lineTo(cx + side * r * t + serration * (side < 0 ? -1 : 1), y - 15 + (endY - y + 15) * t - Math.sin(t * Math.PI) * 5);
      }
      for (let k = 7; k >= 1; k--) {
        const t = k / 7;
        c.lineTo(cx + side * r * t - side * Math.sin(t * Math.PI) * 13, y - 10 + (endY - y + 10) * t + (k % 2 ? 7 : 2));
      }
      c.closePath(); c.fill();
      // Fine needles add a broken, natural outline at full resolution.
      for (let n = 0; n < 13; n++) {
        const t = .18 + n / 15 * .8, x = cx + side * r * t;
        const yy = y - 13 + (endY - y + 13) * t;
        const length = (1 - u * .55) * (3 + hash(n, j, tier + variant) * 7);
        c.strokeStyle = rgb(fill.map((v, k) => clamp(v + (n % 3 ? 5 : 21) + (k === 0 ? 3 : 0), 0, 255)));
        c.lineWidth = .7;
        c.beginPath(); c.moveTo(x, yy); c.lineTo(x - length * .36, yy + length); c.moveTo(x, yy); c.lineTo(x + length * .44, yy + length * .8); c.stroke();
      }
    }
  }
  return image;
}

function radialSprite(inner, outer, size = 128) {
  const image = canvas(size, size), c = image.getContext('2d');
  const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner); g.addColorStop(1, outer);
  c.fillStyle = g; c.fillRect(0, 0, size, size); return image;
}

function flameFrame(frame) {
  const image = canvas(128, 192), c = image.getContext('2d'), pixels = c.createImageData(128, 192), t = frame / 16 * 8;
  // A rising, domain-warped density field creates filaments and hollow curls.
  // All noise octaves repeat after eight flow units, closing the atlas loop.
  for (let y = 0; y < 192; y++) for (let x = 0; x < 128; x++) {
    const px = (x - 63.5) / 64, rise = 1 - y / 191;
    const flow = fbm(px * 2.8 + 47, rise * 3 - t), curl = (flow - .5) * (.28 + rise * .63);
    const distorted = px + curl, broad = fbm(distorted * 4.3 + 13, rise * 6.2 - t * 2);
    const fine = fbm(distorted * 11.7 + flow * 2.7 + 72, rise * 14 - t * 4);
    const width = .51 * Math.pow(Math.max(.01, 1 - rise), .43) + .055;
    const radial = Math.exp(-distorted * distorted / (width * width) * 1.7);
    const density = radial * (.48 + broad * .72) + (broad - .51) * .38 + (fine - .5) * .16 - rise * .24;
    const edge = smooth(.17, .47, density), filament = .62 + fine * .38;
    const alpha = edge * filament * smooth(0, .055, 1 - rise) * smooth(0, .09, rise) * .94;
    const heat = smooth(.42, .89, density) * (1 - rise * .54), core = smooth(.77, .99, density) * (1 - rise);
    const o = (y * 128 + x) * 4;
    pixels.data[o] = 218 + heat * 34 + core * 3;
    pixels.data[o + 1] = 53 + heat * 109 + core * 28;
    pixels.data[o + 2] = 6 + heat * 27 + core * 18;
    pixels.data[o + 3] = alpha * 255;
  }
  c.putImageData(pixels, 0, 0); return image;
}

function smokeKernels() {
  const result = [];
  for (let variant = 0; variant < 6; variant++) {
    const density = new Float32Array(64 * 64);
    let sum = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const nx = (x - 31.5) / 32, ny = (y - 31.5) / 32;
      const coarse = fbm(nx * 2.1 + variant * 23.3, ny * 2.3 + variant * 3.7);
      const detail = fbm(nx * 6.5 + coarse * 2 + 61, ny * 6.5 + variant * 17);
      const radius = Math.hypot(nx, ny) + (coarse - .5) * .27;
      const edge = 1 - smooth(.12, .98, radius);
      const value = edge * (.4 + coarse * .47 + detail * .26);
      density[y * 64 + x] = value; sum += value;
    }
    const inverseMean = density.length / sum;
    for (let i = 0; i < density.length; i++) density[i] *= inverseMean;
    result.push(density);
  }
  return result;
}

/** Canvas visual adapter. Set these Rust-owned arrays before render():
 * fireStates: stride 4 [surface, crown, smolder, heatRelease] per tree.
 * smokeParticles: stride 8 [x,y,z,diameter,opacity,temperature,age,seed].
 * emberParticles: stride 8 [x,y,z,heat,diameter,age,seed,reserved].
 * No smoke or embers are spawned or integrated by this renderer.
 */
export class CompatibilityRenderer {
  constructor(sim) {
    this.sim = sim; this.domElement = canvas(1, 1);
    this.context = this.domElement.getContext('2d', { alpha: false, desynchronized: true });
    if (!this.context) throw new Error('A Canvas 2D context is required for the compatibility view.');
    this.shadowMap = { enabled: false, autoUpdate: false, needsUpdate: false };
    this.info = { render: { calls: 1, triangles: 0 }, memory: { geometries: 0, textures: 0 } };
    this.toneMappingExposure = 1.12; this.visualTime = 0;
    this.quality = 'medium'; this.settings = COMPAT_QUALITY.medium; this.overlay = 'natural'; this.snapshotSequence = undefined;
    this.weather = { windSpeed: 14, windAngle: -Math.PI / 4, rain: 0, night: false };
    this.fireStates = new Float32Array(0); this.smokeParticles = new Float32Array(0); this.emberParticles = new Float32Array(0);
    this.width = this.height = 1; this.pixelRatio = 1;
    this.vector = new Vector3(); this.camera = null; this.ground = canvas(1, 1); this.forestLayer = canvas(1, 1);
    this.signature = ''; this.projected = []; this.terrain = []; this.terrainKey = ''; this.terrainSamples = new Map(); this.terrainFingerprint = '';
    this.forestDirty = true; this.stageSignature = ''; this.lastStageCheck = -Infinity; this.renderMs = 0;
    this.tintCache = new Map(); this.cameraEpoch = 0; this._particleKey = ''; this._candidatePool = []; this._candidates = []; this._visibleSmoke = [];
    this._fireKey = ''; this._firePool = []; this._activeFires = [];
    this.smokeLayer = canvas(1, 1); this.smokeContext = this.smokeLayer.getContext('2d'); this.smokeField = null;
    this.smokeStats = { rebuilds: 0, buildMs: 0, drawn: 0, candidates: 0, fieldPixels: 0 };
    this.pines = Array.from({ length: 4 }, (_, stage) => Array.from({ length: 6 }, (_, variant) => makePine(variant, stage)));
    this.nightPines = this.pines.map(row => row.map(pine => { const image = canvas(132, 310), c = image.getContext('2d'); c.filter = 'brightness(.48) saturate(.65)'; c.drawImage(pine, 0, 0); return image; }));
    this.flames = Array.from({ length: 16 }, (_, i) => flameFrame(i));
    this.glow = radialSprite('rgba(255,135,36,.5)', 'rgba(255,80,0,0)');
    this.smokeKernels = smokeKernels();
    this.shadow = radialSprite('rgba(10,18,9,.48)', 'rgba(10,18,9,0)');
    this.noise = canvas(128, 128);
    const n = this.noise.getContext('2d');
    for (let i = 0; i < 1800; i++) { n.fillStyle = i % 3 ? 'rgba(196,177,115,.07)' : 'rgba(0,0,0,.06)'; n.fillRect(hash(i, 1) * 128, hash(i, 2) * 128, 1 + hash(i, 3), 1); }
  }

  setPixelRatio(value) { this.pixelRatio = Math.min(1.5, Math.max(.5, value || 1)); this.signature = ''; }
  setSize(width, height) {
    this.width = Math.max(1, width); this.height = Math.max(1, height);
    this.domElement.width = Math.round(this.width * this.pixelRatio); this.domElement.height = Math.round(this.height * this.pixelRatio);
    this.domElement.style.width = `${this.width}px`; this.domElement.style.height = `${this.height}px`;
    this.ground.width = this.forestLayer.width = this.domElement.width; this.ground.height = this.forestLayer.height = this.domElement.height; this.signature = ''; this.forestDirty = true;
    this._resizeSmokeLayer();
  }

  setQuality(level) {
    if (!COMPAT_QUALITY[level] || level === this.quality) return;
    this.quality = level; this.settings = COMPAT_QUALITY[level]; this.signature = ''; this._resizeSmokeLayer();
  }

  setOverlay(mode) {
    if (!['natural', 'heat', 'fuel'].includes(mode) || mode === this.overlay) return;
    this.overlay = mode; this.forestDirty = true; this.stageSignature = ''; this.lastStageCheck = -Infinity;
  }

  _resizeSmokeLayer() {
    const width = Math.max(160, Math.min(this.settings.smokeWidth, Math.round(this.width * .55)));
    const height = Math.max(100, Math.round(width * this.height / this.width));
    this.smokeLayer.width = width; this.smokeLayer.height = height;
    this.smokeField = new Float32Array(width * height); this.smokeRed = new Float32Array(width * height);
    this.smokeGreen = new Float32Array(width * height); this.smokeBlue = new Float32Array(width * height);
    this.smokeScratch = new Float32Array(width * height);
    this.smokePixels = this.smokeContext.createImageData(width, height); this._particleKey = ''; this.smokeStats.fieldPixels = width * height;
  }

  _pineSprite(tree, stage, heat, burn) {
    const natural = (this.weather.night ? this.nightPines : this.pines)[stage][tree.variant];
    if (this.overlay === 'natural') return natural;
    const bin = Math.round(clamp(this.overlay === 'heat' ? heat : 1 - burn) * 7);
    const key = `${this.overlay}:${bin}:${stage}:${tree.variant}:${Number(this.weather.night)}`;
    if (this.tintCache.has(key)) return this.tintCache.get(key);
    const palette = this.overlay === 'heat' ? HEAT_COLORS : FUEL_COLORS, t = bin / 7 * (palette.length - 1), i = Math.min(palette.length - 2, Math.floor(t));
    const image = canvas(132, 310), c = image.getContext('2d'); c.drawImage(natural, 0, 0);
    c.globalCompositeOperation = 'source-atop'; c.globalAlpha = .77; c.fillStyle = rgb(blend(palette[i], palette[i + 1], t - i)); c.fillRect(0, 0, 132, 310);
    this.tintCache.set(key, image); if (this.tintCache.size > 240) this.tintCache.delete(this.tintCache.keys().next().value);
    return image;
  }

  project(x, y, z) {
    this.vector.set(x, y, z).project(this.camera);
    return { x: (this.vector.x * .5 + .5) * this.width, y: (-this.vector.y * .5 + .5) * this.height, z: this.vector.z };
  }

  _prepare(data) {
    this.cameraEpoch++;
    const focus = this.sim.focus || { x: 0, z: 0 };
    const terrainKey = `${Math.floor(focus.x / 32)},${Math.floor(focus.z / 32)}|${this.sim.revision()}`;
    if (terrainKey !== this.terrainKey) {
      this.terrainKey = terrainKey; this.terrain = [];
      const fingerprint = `${this.sim.height(0, 0)}:${this.sim.height(31, 17)}`;
      if (fingerprint !== this.terrainFingerprint || this.terrainSamples.size > 7000) { this.terrainSamples.clear(); this.terrainFingerprint = fingerprint; }
      const ox = Math.floor(focus.x / 32) * 32, oz = Math.floor(focus.z / 32) * 32;
      for (let z = -320; z <= 320; z += 16) for (let x = -320; x <= 320; x += 16) {
        const wx = ox + x, wz = oz + z;
        const key = `${wx},${wz}`; let point = this.terrainSamples.get(key);
        if (!point) { point = { x: wx, z: wz, y: this.sim.height(wx, wz) }; this.terrainSamples.set(key, point); }
        this.terrain.push(point);
      }
    }
    const m = this.camera.matrixWorldInverse.elements, w = this.camera.matrixWorld.elements;
    const focal = this.camera.projectionMatrix.elements[5] * this.height * .5;
    const nearMargin = Math.max(2, this.camera.near * 4);
    const rx = w[0], rz = w[2], rl = Math.hypot(rx, rz) || 1;
    this.rightX = rx / rl; this.rightZ = rz / rl; this.projected = [];
    for (let i = 0; i < data.length; i += 10) {
      const x = data[i], y = data[i + 1], z = data[i + 2], h = data[i + 3], radius = data[i + 4];
      const depth = -(m[2] * x + m[6] * y + m[10] * z + m[14]);
      const crownDepth = depth - m[6] * h * 1.03;
      // A billboard cannot straddle the camera plane: its projected crown
      // would flip behind the root and stretch into a screen-sized smear.
      if (depth <= nearMargin || crownDepth <= nearMargin) continue;
      const b = this.project(x, y, z), t = this.project(x, y + h * 1.03, z);
      if (b.z < -1 || b.z > 1.001 || t.z < -1 || t.z > 1.001) continue;
      const width = radius * 2.5 * focal / depth, height = Math.max(3, Math.hypot(t.x - b.x, t.y - b.y));
      if (!Number.isFinite(width + height) || width > this.width * 1.5 || height > this.height * 2.5) continue;
      if (width < this.settings.treePixelCutoff || b.x + width < -30 || b.x - width > this.width + 30 || Math.min(t.y, b.y) > this.height + 80 || Math.max(t.y, b.y) < -100 || b.z > 1.001) continue;
      const grove = hash(Math.floor(x / 48), Math.floor(z / 48), 8), variant = Math.min(5, Math.floor((grove * .58 + hash(x, z) * .42) * 6));
      this.projected.push({ i, x, y, z, h, radius, b, t, width, height, depth, fog: clamp((depth - 110) / 230) * .83, variant });
    }
    this.projected.sort((a, b) => b.depth - a.depth);
    this._paintGround();
    this.forestDirty = true;
  }

  _paintGround() {
    const c = this.ground.getContext('2d'); c.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    const night = this.weather.night, fog = night ? [24,39,44] : [80,96,84];
    const bg = c.createLinearGradient(0, 0, 0, this.height); bg.addColorStop(0, rgb(fog)); bg.addColorStop(1, night ? '#14211d' : '#3e4a31');
    c.fillStyle = bg; c.fillRect(0, 0, this.width, this.height);
    const pp = this.terrain.map(p => this.project(p.x, p.y - .04, p.z));
    const tiles = [], m = this.camera.matrixWorldInverse.elements;
    for (let j = 0; j < 40; j++) for (let i = 0; i < 40; i++) {
      const k = j * 41 + i, a = this.terrain[k];
      const points = [pp[k], pp[k + 1], pp[k + 42], pp[k + 41]];
      if (points.some(p => p.z < -1 || p.z > 1.01)) continue;
      if (points.every(p => p.x < -10) || points.every(p => p.x > this.width + 10) || points.every(p => p.y < -10) || points.every(p => p.y > this.height + 10)) continue;
      const depth = -(m[2] * a.x + m[6] * a.y + m[10] * a.z + m[14]);
      tiles.push({ k, a, points, depth });
    }
    tiles.sort((a, b) => b.depth - a.depth);
    for (const { k, a, points, depth } of tiles) {
      const broad = (Math.sin(a.x * .062 + Math.sin(a.z * .041)) + Math.cos(a.z * .073)) * .25 + .5;
      const slope = clamp((this.terrain[k + 1].y - a.y + this.terrain[k + 41].y - a.y) * .06, -.15, .15);
      let color = blend([48,61,37], [85,90,52], broad * .72 + .12 + slope);
      const trailX = Math.sin(a.z * .026) * 12 + Math.sin(a.z * .011 + 1) * 5 - 4;
      const path = Math.abs(a.x + 8 - trailX) < 9 && Math.abs(a.z) < 135;
      const clearing = Math.hypot(a.x + 8, a.z + 8) < 20;
      if (path || clearing) color = blend(color, [119,109,73], clearing ? .55 : .32);
      if (night) color = color.map((v, n) => Math.round(v * (n === 2 ? .46 : .34)));
      color = blend(color, fog, clamp((depth - 140) / 300) * .9);
      c.fillStyle = rgb(color); c.strokeStyle = c.fillStyle; c.lineWidth = 1.1;
      c.beginPath(); points.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.closePath(); c.fill(); c.stroke();
    }
    // Textural grain and soft canopy shadows keep the floor from reading as a grid.
    c.fillStyle = c.createPattern(this.noise, 'repeat'); c.fillRect(0, 0, this.width, this.height);
    for (const tree of this.projected) {
      if (tree.width < 4 || tree.depth > 230) continue;
      const p = this.project(tree.x + tree.h * .38, tree.y, tree.z + tree.h * .21);
      const dx = p.x - tree.b.x, dy = p.y - tree.b.y, length = Math.hypot(dx, dy);
      c.save(); c.globalAlpha = .7 * (1 - tree.fog); c.translate(tree.b.x + dx * .45, tree.b.y + dy * .45);
      c.rotate(Math.atan2(dy, dx)); c.drawImage(this.shadow, -length * .65 - tree.width * .3, -tree.width * .28, length * 1.3 + tree.width * .6, tree.width * .56); c.restore();
    }
    // Weathered stone ring and scattered rocks in the opening.
    for (let i = 0; i < 26; i++) {
      const a = i / 11 * TAU, x = i < 11 ? Math.cos(a) * 8.3 - 1 : (hash(i, 5) - .5) * 180;
      const z = i < 11 ? Math.sin(a) * 6.1 + 2 : (hash(i, 7) - .5) * 180;
      const y = this.sim.height(x, z), p = this.project(x, y, z), top = this.project(x, y + (i < 11 ? .7 : 1.2), z);
      const size = Math.max(1.5, Math.abs(top.y - p.y) * 1.35);
      c.fillStyle = night ? '#313b32' : '#797b63';
      c.beginPath(); c.moveTo(p.x - size, p.y); c.lineTo(p.x - size * .65, p.y - size); c.lineTo(p.x + size * .1, p.y - size * 1.15); c.lineTo(p.x + size, p.y - size * .4); c.lineTo(p.x + size * .6, p.y + size * .3); c.closePath(); c.fill();
      c.fillStyle = night ? '#465047' : '#a1a58a'; c.beginPath(); c.moveTo(p.x - size * .65, p.y - size); c.lineTo(p.x + size * .1, p.y - size * 1.15); c.lineTo(p.x + size * .65, p.y - size * .5); c.lineTo(p.x - size * .2, p.y - size * .4); c.closePath(); c.fill();
    }
  }

  _fire(tree, surface, crown, release, time) {
    const c = this.context, seed = hash(tree.x, tree.z), b = tree.b;
    if (surface < .01 && crown < .01) return;
    const acrossWind = Math.cos(this.weather.windAngle) * this.rightX + Math.sin(this.weather.windAngle) * this.rightZ;
    const wind = acrossWind * (this.weather.windSpeed || 0) * .0025;
    const frame = Math.floor(time * (11 + seed * 4) + seed * 16) % 16;
    c.save();
    c.globalCompositeOperation = 'lighter'; c.globalAlpha = clamp(release) * (1 - tree.fog) * .085;
    c.drawImage(this.glow, b.x - tree.width * .7, b.y - tree.height * .36, tree.width * 1.4, tree.height * .54);
    c.globalCompositeOperation = 'source-over';
    const draw = (width, height, lift, intensity, phase) => {
      c.save(); c.globalAlpha = (.3 + Math.sqrt(intensity) * .45) * (1 - tree.fog);
      const lean = wind * height + Math.sin(time * 1.8 + seed * 9) * width * .03;
      c.translate(b.x + (tree.t.x - b.x) * lift, b.y - tree.height * lift);
      c.transform(1, 0, -lean / height, 1, 0, 0);
      c.drawImage(this.flames[phase], -width / 2, -height, width, height); c.restore();
    };
    if (surface >= .01) draw(tree.width * (.8 + seed * .27), tree.height * (.1 + surface * .26) * (.84 + seed * .35), .01, surface, frame);
    if (crown >= .01) draw(tree.width * (.69 + crown * .26), tree.height * (.32 + crown * .56) * (.82 + seed * .35), .13, crown, (frame + 7) % 16);
    c.restore();
  }

  _buildSmokeField(smoke, key) {
    const started = performance.now(), m = this.camera.matrixWorldInverse.elements;
    const halfW = this.width * .5, halfH = this.height * .5;
    const focalX = this.camera.projectionMatrix.elements[0] * halfW, focalY = this.camera.projectionMatrix.elements[5] * halfH;
    const candidates = this._candidates; candidates.length = 0; let used = 0;
    for (let i = 0; i + 7 < smoke.length; i += 8) {
      const x = smoke[i], y = smoke[i + 1], z = smoke[i + 2], opacity = clamp(smoke[i + 4]);
      const depth = -(m[2] * x + m[6] * y + m[10] * z + m[14]);
      if (opacity < .003 || depth < 1 || depth > this.camera.far || smoke[i + 3] <= 0) continue;
      const radius = smoke[i + 3] * .5 * focalY / depth;
      if (radius < .6) continue;
      const px = halfW + (m[0] * x + m[4] * y + m[8] * z + m[12]) * focalX / depth;
      const py = halfH - (m[1] * x + m[5] * y + m[9] * z + m[13]) * focalY / depth;
      if (px + radius < 0 || px - radius > this.width || py + radius < 0 || py - radius > this.height) continue;
      const age = clamp(smoke[i + 6]), temperature = clamp(smoke[i + 5]);
      const p = this._candidatePool[used] || (this._candidatePool[used] = {}); used++;
      p.x = px; p.y = py; p.radius = radius; p.depth = depth; p.opacity = opacity; p.age = age; p.temperature = temperature;
      p.variant = Math.floor(fract(Math.abs(smoke[i + 7]) * 17.137) * 6);
      p.priority = opacity * (.7 + temperature * .3) / (1 + depth * .001);
      candidates.push(p);
    }
    candidates.sort((a, b) => b.priority - a.priority);
    const visible = this._visibleSmoke; visible.length = 0;
    let area = 0, budget = this.width * this.height * this.settings.smokeBudget;
    for (const p of candidates) {
      if (visible.length >= this.settings.smokeLimit) break;
      const cost = Math.min(this.width * this.height, p.radius * p.radius * 4);
      if (area + cost > budget && visible.length > 30) continue;
      visible.push(p); area += cost;
    }
    const fw = this.smokeLayer.width, fh = this.smokeLayer.height;
    const sx = fw / this.width, sy = fh / this.height;
    const field = this.smokeField, red = this.smokeRed, green = this.smokeGreen, blue = this.smokeBlue;
    field.fill(0); red.fill(0); green.fill(0); blue.fill(0);
    let boundsLeft = fw, boundsTop = fh, boundsRight = -1, boundsBottom = -1;
    const night = this.weather.night ? .82 : 1;
    // Accumulate optical depth before converting to opacity. Overlapping
    // physical parcels merge into one plume instead of separate opaque balls.
    for (const p of visible) {
      const rx = p.radius * sx, ry = p.radius * sy, left = (p.x - p.radius) * sx, top = (p.y - p.radius) * sy;
      const x0 = Math.max(0, Math.floor(left)), x1 = Math.min(fw - 1, Math.ceil(left + rx * 2));
      const y0 = Math.max(0, Math.floor(top)), y1 = Math.min(fh - 1, Math.ceil(top + ry * 2));
      boundsLeft = Math.min(boundsLeft, x0); boundsTop = Math.min(boundsTop, y0); boundsRight = Math.max(boundsRight, x1); boundsBottom = Math.max(boundsBottom, y1);
      const stepX = 64 / (rx * 2), stepY = 64 / (ry * 2), kernel = this.smokeKernels[p.variant];
      const fog = 1 - clamp((p.depth - 220) / 450) * .65;
      const tau = -Math.log1p(-Math.min(p.opacity, .9999)) * fog;
      const cool = smooth(.04, .64, p.age) * (1 - p.temperature * .3), warm = p.temperature * (1 - smooth(.04, .3, p.age));
      const r = (126 + cool * 61 + warm * 20) * night, g = (132 + cool * 64 + warm * 5) * night, b = (125 + cool * 65 - warm * 13) * night;
      for (let y = y0; y <= y1; y++) {
        const ky = Math.min(63, Math.max(0, ((y + .5 - top) * stepY) | 0));
        let kx = (x0 + .5 - left) * stepX, cell = y * fw + x0;
        for (let x = x0; x <= x1; x++, cell++, kx += stepX) {
          const density = kernel[ky * 64 + Math.min(63, Math.max(0, kx | 0))] * tau;
          if (density < .0002) continue;
          field[cell] += density; red[cell] += density * r; green[cell] += density * g; blue[cell] += density * b;
        }
      }
    }
    if (boundsRight >= boundsLeft && boundsBottom >= boundsTop) {
      reconstructField(field, this.smokeScratch, fw, fh, boundsLeft, boundsTop, boundsRight, boundsBottom);
      reconstructField(red, this.smokeScratch, fw, fh, boundsLeft, boundsTop, boundsRight, boundsBottom);
      reconstructField(green, this.smokeScratch, fw, fh, boundsLeft, boundsTop, boundsRight, boundsBottom);
      reconstructField(blue, this.smokeScratch, fw, fh, boundsLeft, boundsTop, boundsRight, boundsBottom);
    }
    const pixels = this.smokePixels.data;
    for (let i = 0; i < field.length; i++) {
      const density = field[i], out = i * 4;
      if (density < .001) { pixels[out + 3] = 0; continue; }
      const above = i >= fw ? field[i - fw] : density, below = i + fw < field.length ? field[i + fw] : density;
      const light = clamp(1 + (above - below) * .045 / (1 + density), .9, 1.08);
      pixels[out] = red[i] / density * light; pixels[out + 1] = green[i] / density * light; pixels[out + 2] = blue[i] / density * light;
      pixels[out + 3] = Math.min(.985, 1 - Math.exp(-density)) * 255;
    }
    this.smokeContext.putImageData(this.smokePixels, 0, 0); this._particleKey = key;
    this.smokeStats.rebuilds++; this.smokeStats.buildMs = performance.now() - started; this.smokeStats.drawn = visible.length; this.smokeStats.candidates = candidates.length;
  }

  _rustParticles() {
    const c = this.context, smoke = this.smokeParticles, embers = this.emberParticles;
    const sequence = Number.isFinite(this.snapshotSequence) ? this.snapshotSequence : Number.isFinite(this.sim.sequence) ? this.sim.sequence : Math.floor(performance.now() / 50);
    const key = `${sequence}:${this.cameraEpoch}:${Number(this.weather.night)}:${this.quality}`;
    if (key !== this._particleKey) this._buildSmokeField(smoke, key);
    c.save(); c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    c.drawImage(this.smokeLayer, 0, 0, this.width, this.height);
    const m = this.camera.matrixWorldInverse.elements, focal = this.camera.projectionMatrix.elements[5] * this.height * .5;
    const emberStride = Math.max(1, Math.ceil(embers.length / 8 / this.settings.emberLimit)); let emberCount = 0;
    for (let i = 0; i + 7 < embers.length && emberCount < this.settings.emberLimit; i += 8 * emberStride) {
      const x = embers[i], y = embers[i + 1], z = embers[i + 2], heat = clamp(embers[i + 3]);
      const depth = -(m[2] * x + m[6] * y + m[10] * z + m[14]);
      if (heat < .015 || depth < 1) continue;
      const p = this.project(x, y, z);
      if (p.z < -1 || p.z > 1 || p.x < -5 || p.x > this.width + 5 || p.y < -5 || p.y > this.height + 5) continue;
      const size = clamp(embers[i + 4] * focal / depth, .65, 4);
      c.globalCompositeOperation = 'lighter'; c.globalAlpha = heat * .3;
      c.drawImage(this.glow, p.x - size * 2, p.y - size * 2, size * 4, size * 4);
      c.globalCompositeOperation = 'source-over'; c.globalAlpha = heat * .88;
      c.fillStyle = `rgb(250,${Math.round(70 + heat * 135)},${Math.round(13 + heat * 49)})`;
      c.fillRect(p.x - size * .5, p.y - size * .5, size, size); emberCount++;
    }
    c.restore(); this.visibleParticles = { smoke: this.smokeStats.drawn, embers: emberCount, smokeCandidates: this.smokeStats.candidates, sourceSmoke: smoke.length / 8 };
  }

  _paintForest(data) {
    const c = this.forestLayer.getContext('2d'), weather = this.weather;
    c.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
    c.drawImage(this.ground, 0, 0, this.width, this.height);
    for (const tree of this.projected) {
      const burn = clamp(data[tree.i + 7]);
      if (burn < .025 || data[tree.i + 5] < 0) continue;
      const r = tree.width * (.48 + burn * .7);
      c.globalAlpha = Math.min(.82, burn * 1.7) * (1 - tree.fog);
      c.drawImage(this.shadow, tree.b.x - r, tree.b.y - r * .33, r * 2, r * .66);
    }
    c.globalAlpha = 1;
    for (const tree of this.projected) {
      const burn = clamp(data[tree.i + 7]);
      if (data[tree.i + 5] === -1) {
        const top = this.project(tree.x, tree.y + .65, tree.z), r = Math.max(1, tree.width * .042);
        c.globalAlpha = 1 - tree.fog; c.fillStyle = weather.night ? '#3c382a' : '#67573a';
        c.beginPath(); c.moveTo(tree.b.x - r, tree.b.y); c.lineTo(top.x - r, top.y); c.lineTo(top.x + r, top.y); c.lineTo(tree.b.x + r, tree.b.y); c.closePath(); c.fill();
        c.fillStyle = weather.night ? '#72654b' : '#b09a69'; c.beginPath(); c.ellipse(top.x, top.y, r, r * .45, 0, 0, TAU); c.fill(); c.globalAlpha = 1;
        continue;
      }
      const stage = burn > .85 ? 3 : burn > .48 ? 2 : burn > .12 ? 1 : 0;
      const sprite = this._pineSprite(tree, stage, data[tree.i + 6], burn);
      const height = tree.b.y - tree.t.y, slant = tree.t.x - tree.b.x;
      const scaleX = tree.width / 132, scaleY = Math.max(1.5, height) / 293;
      c.save(); c.globalAlpha = 1 - tree.fog;
      // The sprite's root is fixed to the projected ground; the apex follows
      // the projected world-up vector, so orbiting preserves its 3D placement.
      c.setTransform(this.pixelRatio * scaleX, 0, -this.pixelRatio * slant / 293, this.pixelRatio * scaleY, this.pixelRatio * tree.b.x, this.pixelRatio * tree.b.y);
      c.drawImage(sprite, -66, -301); c.restore();
    }
    const vignette = c.createRadialGradient(this.width * .5, this.height * .47, this.height * .25, this.width * .5, this.height * .5, Math.max(this.width, this.height) * .7);
    vignette.addColorStop(0, 'rgba(5,13,10,0)'); vignette.addColorStop(1, 'rgba(5,13,10,.3)');
    c.fillStyle = vignette; c.fillRect(0, 0, this.width, this.height); this.forestDirty = false;
  }

  render(scene, camera) {
    const started = performance.now();
    this.camera = camera; camera.updateMatrixWorld();
    const data = this.sim.trees(), weather = this.weather, time = this.visualTime || 0;
    const signature = `${Array.from(camera.matrixWorld.elements, v => v.toFixed(4)).join(',')}|${camera.fov}|${camera.aspect}|${this.sim.revision()}|${weather.night}|${this.width}|${this.height}`;
    if (signature !== this.signature) { this.signature = signature; this._prepare(data); }
    // Only visible fuel-stage changes invalidate the expensive cached forest.
    // Heat changes and flame animation do not redraw thousands of trees.
    if (started - this.lastStageCheck > 330) {
      this.lastStageCheck = started;
      let stages = 0;
      for (const tree of this.projected) {
        const burn = data[tree.i + 7], stage = data[tree.i + 5] === -1 ? 4 : burn > .85 ? 3 : burn > .48 ? 2 : burn > .12 ? 1 : 0;
        const overlayBin = this.overlay === 'heat' ? Math.round(clamp(data[tree.i + 6]) * 7) : this.overlay === 'fuel' ? Math.round((1 - clamp(burn)) * 7) : 0;
        stages = (Math.imul(stages, 31) + stage * 128 + Math.round(burn * 12) * 8 + overlayBin + 1) | 0;
      }
      if (stages !== this.stageSignature) { this.stageSignature = stages; this.forestDirty = true; }
    }
    if (this.forestDirty) this._paintForest(data);
    const c = this.context; c.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.drawImage(this.forestLayer, 0, 0, this.width, this.height);
    const sequence = Number.isFinite(this.snapshotSequence) ? this.snapshotSequence : Number.isFinite(this.sim.sequence) ? this.sim.sequence : Math.floor(performance.now() / 50);
    const fireKey = `${sequence}:${this.cameraEpoch}`;
    if (fireKey !== this._fireKey) {
      this._fireKey = fireKey; this._activeFires.length = 0;
      const phases = this.fireStates, hasPhases = phases.length >= data.length / 10 * 4;
      for (const tree of this.projected) {
        if (data[tree.i + 5] === -1) continue;
        const heat = data[tree.i + 6], burn = data[tree.i + 7], o = tree.i / 10 * 4;
        const surface = hasPhases ? clamp(phases[o]) : heat >= .65 && burn < .999 ? clamp((heat - .58) * 2.4) : 0;
        const crown = hasPhases ? clamp(phases[o + 1]) : 0, release = hasPhases ? clamp(phases[o + 3]) : surface;
        if (surface < .01 && crown < .01) continue;
        const index = this._activeFires.length, fire = this._firePool[index] || (this._firePool[index] = {});
        fire.tree = tree; fire.surface = surface; fire.crown = crown; fire.release = release; this._activeFires.push(fire);
      }
    }
    for (const fire of this._activeFires) this._fire(fire.tree, fire.surface, fire.crown, fire.release, time);
    this._rustParticles();
    if (weather.rain) {
      c.save(); c.strokeStyle = 'rgba(182,210,211,.26)'; c.lineWidth = .8;
      for (let i = 0; i < 180; i++) { const x = fract(hash(i, 1) + time * .025) * this.width, y = fract(hash(i, 2) + time * (1.05 + hash(i, 3) * .6)) * this.height; c.beginPath(); c.moveTo(x, y); c.lineTo(x - 5 - (weather.windSpeed || 0) * .1, y + 13); c.stroke(); }
      c.restore();
    }
    const ring = scene.children.find(o => o.visible && o.geometry?.type === 'RingGeometry');
    if (ring) {
      c.save(); c.strokeStyle = ring.material.color.getStyle(); c.lineWidth = 1.5; c.shadowColor = c.strokeStyle; c.shadowBlur = 7; c.beginPath();
      for (let i = 0; i <= 48; i++) { const a = i / 48 * TAU, p = this.project(ring.position.x + Math.cos(a) * ring.scale.x, ring.position.y, ring.position.z + Math.sin(a) * ring.scale.x); if (i) c.lineTo(p.x, p.y); else c.moveTo(p.x, p.y); }
      c.stroke(); c.restore();
    }
    this.info.render.calls = 1; this.info.render.triangles = 0;
    this.renderMs = performance.now() - started;
  }

  dispose() {
    this.projected = []; this.terrain = []; this.terrainSamples.clear(); this.pines = []; this.nightPines = []; this.flames = []; this.smokeKernels = [];
    this.tintCache.clear(); this._candidatePool = []; this._candidates = []; this._visibleSmoke = []; this._activeFires = []; this._firePool = [];
    this.smokeField = this.smokeRed = this.smokeGreen = this.smokeBlue = this.smokeScratch = this.smokePixels = null;
    this.smokeLayer.width = this.smokeLayer.height = 1; this.domElement.remove();
  }
}
