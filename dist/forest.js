import * as THREE from 'three';

// The forest is a view of the Rust world. No ignition, fuel, weather, or spread
// decisions live here; these meshes only display the current simulation buffers.
const STRIDE = 10;
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fract = x => x - Math.floor(x);
const hash = (x, z, salt = 0) => fract(Math.sin(x * 127.1 + z * 311.7 + salt * 73.31) * 43758.5453);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const TREE_TILE = 72, GROUND_TILE = 128;
const QUALITY = {
  low: { highPixels: Infinity, mediumPixels: 42, shadows: false, fernCopies: 1 },
  medium: { highPixels: 115, mediumPixels: 30, shadows: true, fernCopies: 2 },
  high: { highPixels: 72, mediumPixels: 19, shadows: true, fernCopies: 3 },
};

function writeTransform(array, index, x, y, z, sx, sy, sz, cos, sin) {
  const o = index * 16;
  array[o] = cos * sx; array[o + 1] = 0; array[o + 2] = -sin * sx; array[o + 3] = 0;
  array[o + 4] = 0; array[o + 5] = sy; array[o + 6] = 0; array[o + 7] = 0;
  array[o + 8] = sin * sz; array[o + 9] = 0; array[o + 10] = cos * sz; array[o + 11] = 0;
  array[o + 12] = x; array[o + 13] = y; array[o + 14] = z; array[o + 15] = 1;
}

function uploadRange(attribute, first, last, stride) {
  if (last < first) return;
  attribute.addUpdateRange(first * stride, (last - first + 1) * stride);
  attribute.needsUpdate = true;
}

function rawGeometry(positions, colors) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function pineCrown(detail) {
  const positions = [], colors = [];
  const tiers = detail ? 9 : 6, branches = detail ? 7 : 5;
  function tri(a, b, c, light) {
    positions.push(...a, ...b, ...c);
    for (let j = 0; j < 3; j++) colors.push(light * 1.02, light, light * .88);
  }
  for (let tier = 0; tier < tiers; tier++) {
    const y = .18 + tier / (tiers - 1) * .72;
    const radius = (1 - y) * 1.12 + .025;
    for (let j = 0; j < branches; j++) {
      const a = j / branches * TAU + tier * 2.399;
      const spread = Math.PI / branches * 1.18;
      const r = radius * (.89 + hash(tier, j) * .2);
      const p = (ra, angle, yy) => [Math.cos(angle) * ra, yy, Math.sin(angle) * ra];
      const root = p(.015, a, y + .092);
      const rim = detail ? [
        p(r * .44, a - spread, y + .023),
        p(r * .88, a - spread * .65, y - .035),
        p(r * .68, a - spread * .36, y - .008),
        p(r * 1.11, a - spread * .11, y - .065),
        p(r * .82, a + spread * .21, y - .017),
        p(r * .96, a + spread * .62, y - .046),
        p(r * .44, a + spread, y + .023),
      ] : [
        p(r * .66, a - spread, y - .02),
        p(r * 1.1, a - spread * .14, y - .054),
        p(r * .72, a + spread * .54, y - .02),
        p(r * .5, a + spread, y + .025),
      ];
      for (let k = 0; k < rim.length - 1; k++) {
        tri(root, rim[k], rim[k + 1], .63 + hash(tier * 7 + k, j) * .35 + tier * .013);
      }
    }
  }
  for (let k = 0; k < 6; k++) {
    const a = k / 6 * TAU, b = (k + 1) / 6 * TAU;
    tri([0, 1.03, 0], [Math.cos(a) * .09, .83, Math.sin(a) * .09], [Math.cos(b) * .09, .83, Math.sin(b) * .09], .9);
  }
  return rawGeometry(positions, colors);
}

function pineWood(detail) {
  const p = [], c = [];
  function tri(a, b, d, shade) {
    p.push(...a, ...b, ...d);
    for (let i = 0; i < 3; i++) c.push(shade * .92, shade * .76, shade * .57);
  }
  const sides = detail ? 6 : 5;
  for (let j = 0; j < sides; j++) {
    const a = j / sides * TAU, b = (j + 1) / sides * TAU;
    const aa = [Math.cos(a) * .074, 0, Math.sin(a) * .074];
    const bb = [Math.cos(b) * .074, 0, Math.sin(b) * .074];
    const cc = [Math.cos(a) * .015, .95, Math.sin(a) * .015];
    const dd = [Math.cos(b) * .015, .95, Math.sin(b) * .015];
    tri(aa, bb, cc, .55 + hash(j, 31) * .24);
    tri(bb, dd, cc, .55 + hash(j, 31) * .24);
  }
  const levels = detail ? 5 : 3;
  for (let tier = 0; tier < levels; tier++) {
    const y = .24 + tier * .125;
    for (let j = 0; j < 5; j++) {
      const a = j / 5 * TAU + tier * 2.4, r = (1 - y) * .87;
      const end = [Math.cos(a) * r, y - .065, Math.sin(a) * r];
      const b = [Math.sin(a) * .025, y, -Math.cos(a) * .025];
      const d = [-Math.sin(a) * .025, y, Math.cos(a) * .025];
      const top = [0, y + .019, 0];
      tri(b, end, top, .51); tri(top, end, d, .64); tri(d, end, b, .32);
    }
  }
  return rawGeometry(p, c);
}

function distantCrown() {
  const p = [], c = [];
  for (let tier = 0; tier < 4; tier++) {
    const y = .18 + tier * .19, radius = (1 - y) * 1.03;
    for (let j = 0; j < 7; j++) {
      const a = j / 7 * TAU + tier * 2.4, b = (j + 1) / 7 * TAU + tier * 2.4;
      const r = radius * (.9 + hash(tier, j) * .16);
      p.push(0, y + .25, 0, Math.cos(a) * r, y - .035, Math.sin(a) * r, Math.cos(b) * radius, y + .005, Math.sin(b) * radius);
      const shade = .66 + hash(tier, j) * .3;
      for (let k = 0; k < 3; k++) c.push(shade, shade, shade * .89);
    }
  }
  return rawGeometry(p, c);
}

function fernGeometry() {
  const p = [], c = [];
  for (let frond = 0; frond < 7; frond++) {
    const a = frond * TAU / 7;
    for (let j = 1; j < 5; j++) {
      const t = j / 5, r = t * .85, h = Math.sin(t * Math.PI * .88) * .52;
      const base = [Math.cos(a) * r, h, Math.sin(a) * r];
      const end = [Math.cos(a) * (r + .22), h + .03, Math.sin(a) * (r + .22)];
      for (const side of [-1, 1]) {
        const w = .2 * (1 - t * .65) * side;
        const tip = [Math.cos(a) * (r + .09) + Math.sin(a) * w, h - .045, Math.sin(a) * (r + .09) - Math.cos(a) * w];
        p.push(...base, ...end, ...tip);
        for (let k = 0; k < 3; k++) c.push(.45 + t * .25, .62 + t * .25, .28 + t * .12);
      }
    }
  }
  return rawGeometry(p, c);
}

function radialTexture() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 5, 32, 32, 32);
  g.addColorStop(0, '#fff'); g.addColorStop(.57, '#fff'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class ForestView {
  constructor(scene, sim) {
    this.scene = scene; this.sim = sim; this.group = new THREE.Group();
    this.group.name = 'Rust world · forest view'; scene.add(this.group);
    this._revision = -1; this._terrainMeshes = []; this.parts = []; this.props = [];
    this.quality = 'medium'; this.settings = QUALITY.medium; this.overlay = 'natural'; this._colorsDirty = false; this._sequence = -1;
    this.terrainCache = new Map(); this.landscapeKey = ''; this.groundFingerprint = '';
    this._lastLodTime = -Infinity; this.frustum = new THREE.Frustum(); this.projection = new THREE.Matrix4();
    this.scratchVector = new THREE.Vector3(); this._scratchColor = new THREE.Color();
    this.brown = new THREE.Color(0x624526); this.charcoal = new THREE.Color(0x141510); this.hotWood = new THREE.Color(0x90602f);
    this.woodBase = new THREE.Color(0xc9b898); this.woodChar = new THREE.Color(0x24201b);
    this.heatPalette = [0x315676, 0x51b6aa, 0xffcc69, 0xf34e36].map(c => new THREE.Color(c));
    this.fuelPalette = [0x423b36, 0xd8a25d, 0x81b36e].map(c => new THREE.Color(c));
    this.stats = { syncMs: 0, changedTrees: 0, uploadedAttributes: 0, treeTriangles: 0, visibleChunks: 0, chunks: 0, terrainCacheHits: 0, terrainCacheMisses: 0 };
    this.matrix = new THREE.Matrix4(); this.object = new THREE.Object3D(); this.color = new THREE.Color();
    this.timeUniform = { value: 0 }; this.windUniform = { value: .02 }; this.windDirUniform = { value: new THREE.Vector2(1, 0) };
    this.crowns = [pineCrown(true), pineCrown(false), distantCrown()];
    this.woods = [pineWood(true), pineWood(false), new THREE.CylinderGeometry(.013, .074, .95, 5).translate(0, .475, 0)];
    const farWoodColors = new Float32Array(this.woods[2].attributes.position.count * 3);
    farWoodColors.fill(.65); this.woods[2].setAttribute('color', new THREE.BufferAttribute(farWoodColors, 3));
    this.leafMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 1, metalness: 0, side: THREE.DoubleSide });
    this.woodMaterial = new THREE.MeshStandardMaterial({ color: 0xa7957c, vertexColors: true, roughness: 1 });
    for (const mat of [this.leafMaterial, this.woodMaterial]) {
      mat.onBeforeCompile = shader => {
        shader.uniforms.forestTime = this.timeUniform; shader.uniforms.forestWind = this.windUniform; shader.uniforms.forestWindDir = this.windDirUniform;
        shader.vertexShader = `uniform float forestTime; uniform float forestWind; uniform vec2 forestWindDir;\n` + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
          #include <begin_vertex>
          float phase = 0.0;
          #ifdef USE_INSTANCING
          phase = instanceMatrix[3][0] * .089 + instanceMatrix[3][2] * .071;
          #endif
          float bend = sin(forestTime * 1.15 + phase) + .31 * sin(forestTime * 2.9 + phase * 1.7);
          transformed.xz += forestWindDir * bend * forestWind * transformed.y * transformed.y;
        `);
      };
      mat.customProgramCacheKey = () => 'emberfield-tree-wind-v1';
    }
    this.groundMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .98, color: 0xffffff });
    this.ashTexture = radialTexture();
    this.ashGeometry = new THREE.PlaneGeometry(1, 1);
    this.ashMaterial = new THREE.MeshBasicMaterial({ color: 0x10100b, map: this.ashTexture, transparent: true, opacity: .7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
    this.stumpGeometry = new THREE.CylinderGeometry(.21, .3, .65, 7);
    this.stumpMaterial = new THREE.MeshStandardMaterial({ color: 0x8b7854, roughness: 1 });
    this.sync(true);
  }

  get terrainMeshes() { return this._terrainMeshes; }

  setQuality(level) {
    if (!QUALITY[level] || level === this.quality) return;
    this.quality = level; this.settings = QUALITY[level]; this._lastLodTime = -Infinity;
    this.landscapeKey = ''; this._refreshLandscape(this.sim.focus || { x: 0, z: 0 });
  }

  setOverlay(mode) {
    if (!['natural', 'heat', 'fuel'].includes(mode) || mode === this.overlay) return;
    this.overlay = mode; this._colorsDirty = true; this._sequence = -1;
  }

  _overlayColor(heat, burn, cut) {
    const palette = this.overlay === 'heat' ? this.heatPalette : this.fuelPalette;
    const t = (this.overlay === 'heat' ? heat : cut ? 0 : 1 - burn) * (palette.length - 1);
    const i = Math.min(palette.length - 2, Math.floor(t));
    return this.color.copy(palette[i]).lerp(palette[i + 1], t - i);
  }

  _clearTreeMeshes() {
    for (const p of this.parts) { this.group.remove(p.crown, p.wood); p.crown.dispose(); p.wood.dispose(); }
    this.parts = [];
    if (this.ash) { this.group.remove(this.ash); this.ash.dispose(); this.ash = null; }
    if (this.stumps) { this.group.remove(this.stumps); this.stumps.dispose(); this.stumps = null; }
  }

  _clearProps() {
    for (const mesh of this.props) { this.group.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); if (mesh.dispose) mesh.dispose(); }
    this.props = [];
  }

  _clearTerrain() {
    for (const mesh of this.terrainCache.values()) { this.group.remove(mesh); mesh.geometry.dispose(); }
    this.terrainCache.clear(); this._terrainMeshes = [];
  }

  _rebuild(data) {
    this._clearTreeMeshes();
    const focus = this.sim.focus || { x: 0, z: 0 };
    const chunks = new Map();
    for (let i = 0; i < data.length; i += STRIDE) {
      const cx = Math.floor(data[i] / TREE_TILE), cz = Math.floor(data[i + 2] / TREE_TILE), key = `${cx},${cz}`;
      if (!chunks.has(key)) chunks.set(key, { cx, cz, indices: [] });
      chunks.get(key).indices.push(i);
    }
    for (const chunk of chunks.values()) {
      const n = chunk.indices.length, x = (chunk.cx + .5) * TREE_TILE, z = (chunk.cz + .5) * TREE_TILE;
      const distance = Math.hypot(x - focus.x, z - focus.z), lod = distance < 74 ? 0 : distance < 154 ? 1 : 2;
      const crown = new THREE.InstancedMesh(this.crowns[lod], this.leafMaterial, Math.max(1, n));
      const wood = new THREE.InstancedMesh(this.woods[lod], this.woodMaterial, Math.max(1, n));
      crown.count = wood.count = n;
      crown.instanceMatrix.setUsage(THREE.DynamicDrawUsage); wood.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      crown.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
      wood.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
      crown.castShadow = wood.castShadow = lod === 0 && this.settings.shadows;
      crown.receiveShadow = wood.receiveShadow = true;
      crown.name = `Conifer crowns · ${chunk.cx},${chunk.cz}`; wood.name = `Trunks · ${chunk.cx},${chunk.cz}`;
      const angles = new Float32Array(n * 3), base = new Float32Array(n * 3), state = new Int32Array(n); state.fill(-1);
      for (let j = 0; j < n; j++) {
        const i = chunk.indices[j], random = fract(Math.abs(data[i + 9]) * .754877666 + hash(data[i], data[i + 2]));
        const grove = hash(Math.floor(data[i] / 48), Math.floor(data[i + 2] / 48), 8), mix = random * .42 + grove * .58;
        angles[j * 3] = Math.cos(random * TAU); angles[j * 3 + 1] = Math.sin(random * TAU); angles[j * 3 + 2] = random;
        this._scratchColor.setHex(mix < .24 ? 0x657141 : mix > .72 ? 0x365b4b : 0x506c3e).multiplyScalar(.81 + random * .37);
        this._scratchColor.toArray(base, j * 3);
      }
      this.group.add(crown, wood); this.parts.push({ crown, wood, indices: Uint32Array.from(chunk.indices), angles, base, state, lod, x, z, bounds: null });
    }
    const count = data.length / STRIDE;
    this.ashSlots = new Int32Array(count); this.stumpSlots = new Int32Array(count); this.ashSlots.fill(-1); this.stumpSlots.fill(-1);
    this.ash = new THREE.InstancedMesh(this.ashGeometry, this.ashMaterial, Math.max(1, count)); this.ash.count = 0;
    this.ash.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.ash.renderOrder = 1; this.ash.frustumCulled = false;
    this.group.add(this.ash);
    this.stumps = new THREE.InstancedMesh(this.stumpGeometry, this.stumpMaterial, Math.max(1, count)); this.stumps.count = 0;
    this.stumps.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.stumps.frustumCulled = false; this.stumps.receiveShadow = true;
    this.group.add(this.stumps);
    this._refreshLandscape(focus); this.stats.chunks = this.parts.length; this._lastLodTime = -Infinity;
  }

  _refreshLandscape(focus) {
    const fingerprint = `${this.sim.height(0, 0)}:${this.sim.height(31, 17)}`;
    if (fingerprint !== this.groundFingerprint) { this.groundFingerprint = fingerprint; this._clearTerrain(); this.landscapeKey = ''; }
    const cx = Math.floor(focus.x / GROUND_TILE), cz = Math.floor(focus.z / GROUND_TILE), key = `${cx},${cz}`;
    if (key === this.landscapeKey) return;
    this.landscapeKey = key;
    for (const mesh of this._terrainMeshes) this.group.remove(mesh);
    this._terrainMeshes = [];
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const tileKey = `${cx + dx},${cz + dz}`; let mesh = this.terrainCache.get(tileKey);
      if (!mesh) { mesh = this._createTerrainTile(cx + dx, cz + dz); this.terrainCache.set(tileKey, mesh); this.stats.terrainCacheMisses++; }
      else this.stats.terrainCacheHits++;
      this.group.add(mesh); this._terrainMeshes.push(mesh);
    }
    // Keep a modest fringe for quick backtracking without unbounded memory.
    for (const [tileKey, mesh] of this.terrainCache) {
      const [tx, tz] = tileKey.split(',').map(Number);
      if (Math.abs(tx - cx) > 3 || Math.abs(tz - cz) > 3) { mesh.geometry.dispose(); this.terrainCache.delete(tileKey); }
    }
    this._clearProps(); this._createUnderstory(cx * GROUND_TILE, cz * GROUND_TILE);
  }

  _createTerrainTile(tx, tz) {
    const centerX = (tx + .5) * GROUND_TILE, centerZ = (tz + .5) * GROUND_TILE;
    const g = new THREE.PlaneGeometry(GROUND_TILE, GROUND_TILE, 32, 32);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position, colors = new Float32Array(pos.count * 3);
    const moss = new THREE.Color(0x46513a), dirt = new THREE.Color(0x76664d), dark = new THREE.Color(0x2d3c2d);
    const col = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + centerX, z = pos.getZ(i) + centerZ;
      pos.setXYZ(i, x, this.sim.height(x, z) - .055, z);
      const grain = hash(x, z), broad = (Math.sin(x * .067 + Math.sin(z * .042)) + Math.cos(z * .081)) * .25 + .5;
      col.copy(dark).lerp(moss, .35 + broad * .65);
      col.multiplyScalar(.77 + grain * .44);
      const trailX = Math.sin(z * .026) * 12 + Math.sin(z * .011 + 1) * 5 - 4;
      const trail = (1 - smooth(1.8, 4.6, Math.abs(x - trailX))) * (1 - smooth(90, 160, Math.abs(z)));
      const clearing = 1 - smooth(6, 16, Math.hypot(x, z));
      col.lerp(dirt, Math.max(trail * .72, clearing * .6));
      col.toArray(colors, i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3)); g.computeVertexNormals(); g.computeBoundingSphere(); g.computeBoundingBox();
    const ground = new THREE.Mesh(g, this.groundMaterial); ground.receiveShadow = true; ground.name = 'Procedural Rust terrain';
    return ground;
  }

  _createUnderstory(fx, fz) {
    const makeInstances = (geometry, material, count, name) => {
      const mesh = new THREE.InstancedMesh(geometry, material, count); mesh.name = name;
      mesh.receiveShadow = true; this.group.add(mesh); this.props.push(mesh); return mesh;
    };
    const originX = Math.floor(fx / 16) * 16, originZ = Math.floor(fz / 16) * 16;
    const rocks = [], ferns = [], logs = [];
    for (let iz = -10; iz <= 10; iz++) for (let ix = -10; ix <= 10; ix++) {
      const wx = originX + ix * 16, wz = originZ + iz * 16;
      const x = wx + hash(wx, wz, 1) * 14, z = wz + hash(wx, wz, 2) * 14;
      if (hash(wx, wz, 3) > .65) rocks.push([x, z, .5 + hash(wx, wz, 4) * 2.1]);
      if (Math.hypot(x, z) > 12) {
        for (let j = 0; j < this.settings.fernCopies; j++) ferns.push([x + hash(x, z, j + 5) * 8, z + hash(x, z, j + 9) * 8, .55 + hash(x, z, j + 12) * 1.3]);
        if (hash(wx, wz, 14) > .88) logs.push([x - 2, z, hash(x, z, 17)]);
      }
    }
    // Small weathered stones around the central clearing ground the first view.
    for (let i = 0; i < 11; i++) {
      const a = i * TAU / 11;
      rocks.push([Math.cos(a) * 8.3 - 1, Math.sin(a) * 6.1 + 2, .35 + hash(i, 0) * .7]);
    }
    const rockGeometry = new THREE.IcosahedronGeometry(1, 1);
    const rp = rockGeometry.attributes.position, rc = new Float32Array(rp.count * 3);
    for (let i = 0; i < rp.count; i++) {
      const x = rp.getX(i), y = rp.getY(i), z = rp.getZ(i), n = .82 + hash(x * 100, z * 100, y * 10) * .27;
      rp.setXYZ(i, x * n, y * n * .68, z * n);
      const shade = .6 + hash(x * 4, z * 7, y) * .35;
      rc.set([shade * (y > .2 ? .82 : .9), shade * .93, shade * .86], i * 3);
    }
    rockGeometry.setAttribute('color', new THREE.BufferAttribute(rc, 3)); rockGeometry.computeVertexNormals();
    const rockMesh = makeInstances(rockGeometry, new THREE.MeshStandardMaterial({ color: 0x939482, vertexColors: true, roughness: 1, flatShading: true }), rocks.length, 'Mossy granite');
    rockMesh.castShadow = this.settings.shadows;
    rocks.forEach(([x, z, scale], i) => {
      this.object.position.set(x, this.sim.height(x, z) + scale * .14, z);
      this.object.rotation.set(hash(x, z) * .5, hash(x, z, 4) * TAU, hash(x, z, 3) * .3);
      this.object.scale.set(scale, scale, scale * (.8 + hash(x, z, 5) * .6)); this.object.updateMatrix(); rockMesh.setMatrixAt(i, this.object.matrix);
    });
    rockMesh.computeBoundingSphere();
    const fernMesh = makeInstances(fernGeometry(), new THREE.MeshStandardMaterial({ color: 0x697d45, roughness: 1, vertexColors: true, side: THREE.DoubleSide }), ferns.length, 'Ferns and undergrowth');
    ferns.forEach(([x, z, scale], i) => {
      this.object.position.set(x, this.sim.height(x, z), z); this.object.rotation.set(0, hash(x, z) * TAU, 0);
      this.object.scale.setScalar(scale); this.object.updateMatrix(); fernMesh.setMatrixAt(i, this.object.matrix);
    }); fernMesh.computeBoundingSphere();
    const logMesh = makeInstances(new THREE.CylinderGeometry(.2, .29, 1, 6), new THREE.MeshStandardMaterial({ color: 0x5b4631, roughness: 1, flatShading: true }), Math.max(1, logs.length), 'Fallen deadwood');
    logMesh.count = logs.length; logMesh.castShadow = this.settings.shadows;
    logs.forEach(([x, z, n], i) => {
      this.object.position.set(x, this.sim.height(x, z) + .27, z); this.object.rotation.set(Math.PI / 2, 0, n * TAU);
      this.object.scale.set(1 + n, 2.5 + n * 4, 1 + n); this.object.updateMatrix(); logMesh.setMatrixAt(i, this.object.matrix);
    }); logMesh.computeBoundingSphere();
  }

  sync(force = false) {
    const started = performance.now(), revision = this.sim.revision();
    if (!force && revision === this._revision && this.sim.sequence !== undefined && this.sim.sequence === this._sequence) { this.stats.syncMs = performance.now() - started; this.stats.changedTrees = 0; this.stats.uploadedAttributes = 0; return; }
    const data = this.sim.trees(); this._sequence = this.sim.sequence;
    const rebuilt = force || revision !== this._revision;
    if (rebuilt) { this._revision = revision; this._rebuild(data); }
    let ashFirst = Infinity, ashLast = -1, stumpFirst = Infinity, stumpLast = -1, changedTrees = 0, uploads = 0;
    for (const part of this.parts) {
      let cmFirst = Infinity, cmLast = -1, wmFirst = Infinity, wmLast = -1, ccFirst = Infinity, ccLast = -1, wcFirst = Infinity, wcLast = -1;
      const crownMatrix = part.crown.instanceMatrix.array, woodMatrix = part.wood.instanceMatrix.array;
      const crownColor = part.crown.instanceColor.array, woodColor = part.wood.instanceColor.array;
      for (let n = 0; n < part.indices.length; n++) {
        const i = part.indices[n];
        const x = data[i], y = data[i + 1], z = data[i + 2], h = data[i + 3], w = data[i + 4];
        const burnStep = Math.round(clamp(data[i + 7], 0, 1) * 96), heatStep = Math.round(clamp(data[i + 6], 0, 1) * 16), cut = data[i + 5] < 0;
        const state = (cut ? 4096 : 0) | (burnStep << 5) | heatStep, previous = part.state[n];
        if (state === previous && !this._colorsDirty) continue;
        part.state[n] = state; changedTrees++;
        const burn = burnStep / 96, heat = heatStep / 16, random = part.angles[n * 3 + 2], cos = part.angles[n * 3], sin = part.angles[n * 3 + 1];
        const burnChanged = previous < 0 || ((previous >>> 5) & 127) !== burnStep, cutChanged = previous < 0 || (previous & 4096) !== (state & 4096);
        if (cutChanged) {
          writeTransform(woodMatrix, n, x, y, z, cut ? .00001 : w, cut ? .00001 : h, cut ? .00001 : w, cos, sin);
          wmFirst = Math.min(wmFirst, n); wmLast = n;
        }
        const crownRemain = 1 - smooth(.35, 1, burn) * .94;
        if (burnChanged || cutChanged) {
          writeTransform(crownMatrix, n, x, y, z, cut ? .00001 : w * crownRemain, cut ? .00001 : h * (1 - burn * .12), cut ? .00001 : w * crownRemain, cos, sin);
          cmFirst = Math.min(cmFirst, n); cmLast = n;
        }
        if (this.overlay === 'natural') {
          this.color.fromArray(part.base, n * 3).lerp(this.brown, Math.min(burn * 3, 1) * .65).lerp(this.charcoal, smooth(.15, .92, burn));
          if (heat > .35) this.color.lerp(this.hotWood, (heat - .35) * .21);
        } else this._overlayColor(heat, burn, cut);
        this.color.toArray(crownColor, n * 3); ccFirst = Math.min(ccFirst, n); ccLast = n;
        if (this._colorsDirty || burnChanged || cutChanged || this.overlay !== 'natural') {
          if (this.overlay === 'natural') this.color.copy(this.woodBase).lerp(this.woodChar, Math.min(1, burn * 1.35));
          else this._overlayColor(heat, burn, cut);
          this.color.toArray(woodColor, n * 3); wcFirst = Math.min(wcFirst, n); wcLast = n;
        }
        if (burnChanged || cutChanged) {
          const tree = i / STRIDE;
          if (cut) {
            if (this.stumpSlots[tree] < 0) this.stumpSlots[tree] = this.stumps.count++;
            const slot = this.stumpSlots[tree];
            writeTransform(this.stumps.instanceMatrix.array, slot, x, y + .325, z, w / 3, 1, w / 3, cos, sin);
            stumpFirst = Math.min(stumpFirst, slot); stumpLast = Math.max(stumpLast, slot);
          }
          if (burn > .015 && !cut && this.ashSlots[tree] < 0) this.ashSlots[tree] = this.ash.count++;
          if (this.ashSlots[tree] >= 0) {
            const slot = this.ashSlots[tree], r = cut ? 0 : w * (1.2 + burn * 2.9);
            this.object.position.set(x, y + .045, z); this.object.rotation.set(-Math.PI / 2, 0, random * TAU);
            this.object.scale.set(r, r, 1); this.object.updateMatrix(); this.ash.setMatrixAt(slot, this.object.matrix);
            ashFirst = Math.min(ashFirst, slot); ashLast = Math.max(ashLast, slot);
          }
        }
      }
      uploadRange(part.crown.instanceMatrix, cmFirst, cmLast, 16); uploadRange(part.wood.instanceMatrix, wmFirst, wmLast, 16);
      uploadRange(part.crown.instanceColor, ccFirst, ccLast, 3); uploadRange(part.wood.instanceColor, wcFirst, wcLast, 3);
      uploads += Number(cmLast >= cmFirst) + Number(wmLast >= wmFirst) + Number(ccLast >= ccFirst) + Number(wcLast >= wcFirst);
      if (rebuilt) {
        part.crown.computeBoundingSphere(); part.bounds = part.crown.boundingSphere.clone(); part.bounds.radius += 4;
        part.crown.boundingSphere.copy(part.bounds); part.wood.boundingSphere = part.bounds.clone();
      }
    }
    uploadRange(this.ash.instanceMatrix, ashFirst, ashLast, 16); uploadRange(this.stumps.instanceMatrix, stumpFirst, stumpLast, 16);
    this.stats.changedTrees = changedTrees; this.stats.uploadedAttributes = uploads + Number(ashLast >= ashFirst) + Number(stumpLast >= stumpFirst);
    this.stats.syncMs = performance.now() - started; this._colorsDirty = false;
  }

  update(time, windSpeed, windAngle, camera) {
    this.timeUniform.value = time; this.windUniform.value = .012 + Math.min(windSpeed, 80) * .0011;
    this.windDirUniform.value.set(Math.cos(windAngle), Math.sin(windAngle));
    if (!camera || performance.now() - this._lastLodTime < 180) return;
    this._lastLodTime = performance.now(); camera.updateMatrixWorld();
    this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); this.frustum.setFromProjectionMatrix(this.projection);
    const focal = camera.projectionMatrix.elements[5] * (globalThis.innerHeight || 900) * .5;
    const focus = this.sim.focus || { x: 0, z: 0 }; let triangles = 0, visible = 0;
    for (const part of this.parts) {
      const distance = Math.max(1, camera.position.distanceTo(part.bounds.center)), pixels = 12 * focal / distance;
      // Hysteresis prevents geometry popping when hovering near an LOD boundary.
      const high = this.settings.highPixels * (part.lod === 0 ? .9 : 1.05), mid = this.settings.mediumPixels * (part.lod === 1 ? .9 : 1.05);
      const lod = pixels > high ? 0 : pixels > mid ? 1 : 2;
      if (lod !== part.lod) { part.lod = lod; part.crown.geometry = this.crowns[lod]; part.wood.geometry = this.woods[lod]; }
      const shadow = this.settings.shadows && Math.hypot(part.x - focus.x, part.z - focus.z) < 120;
      part.crown.castShadow = part.wood.castShadow = shadow;
      if (this.frustum.intersectsSphere(part.bounds)) {
        visible++; const crown = this.crowns[lod], wood = this.woods[lod];
        triangles += ((crown.index?.count || crown.attributes.position.count) + (wood.index?.count || wood.attributes.position.count)) / 3 * part.indices.length;
      }
    }
    this.stats.visibleChunks = visible; this.stats.treeTriangles = triangles;
  }

  dispose() {
    this._clearTreeMeshes(); this._clearProps(); this._clearTerrain(); this.scene.remove(this.group);
    for (const g of [...this.crowns, ...this.woods, this.ashGeometry, this.stumpGeometry]) g.dispose();
    for (const m of [this.leafMaterial, this.woodMaterial, this.groundMaterial, this.ashMaterial, this.stumpMaterial]) m.dispose();
    this.ashTexture.dispose();
  }
}
