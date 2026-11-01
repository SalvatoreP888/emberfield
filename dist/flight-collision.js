import RAPIER from './vendor/rapier.mjs';
const rotation = { x: 0, y: 0, z: 0, w: 1 };
let ready;
export async function loadFlightPhysics() { await (ready ||= RAPIER.init()); }

// Avatar-local probes form a forgiving approximation of the visible body,
// head, tail and wing silhouette. The z-axis points toward the tail. Probes
// follow yaw, pitch and bank and retract their wings while tucked.
function creatureProbes(form, tucked, scaleOverride) {
  const wingScale = scaleOverride ?? (tucked ? .65 : 1);
  if (form === 'dragon') return [
    [0, 0, 0, 1.25], [0, .3, -1.7, .58], [0, -.05, 2.5, .45], [0, -.22, 3.7, .27],
    [-1.25 * wingScale, .15, -.35, .48], [1.25 * wingScale, .15, -.35, .48],
    [-2.45 * wingScale, .12, -.45, .48], [2.45 * wingScale, .12, -.45, .48],
    [-3.65 * wingScale, .08, -.55, .48], [3.65 * wingScale, .08, -.55, .48],
  ];
  return [
    [0, 0, 0, .55], [0, .16, -1.13, .32], [0, 0, 1.7, .28],
    [-1.1 * wingScale, .12, -.3, .34], [1.1 * wingScale, .12, -.3, .34],
    [-2.15 * wingScale, .08, -.38, .34], [2.15 * wingScale, .08, -.38, .34],
    [-2.85 * wingScale, .06, -.42, .34], [2.85 * wingScale, .06, -.42, .34],
    [-3.55 * wingScale, .05, -.45, .34], [3.55 * wingScale, .05, -.45, .34],
  ];
}
function worldOffset(probe, pose) {
  const [x, y, z] = probe;
  const cb = Math.cos(pose.bank || 0), sb = Math.sin(pose.bank || 0);
  const cp = Math.cos(pose.pitch || 0), sp = Math.sin(pose.pitch || 0);
  const cy = Math.cos(pose.yaw || 0), sy = Math.sin(pose.yaw || 0);
  const bx = x * cb - y * sb, by = x * sb + y * cb;
  const py = by * cp - z * sp, pz = by * sp + z * cp;
  return { x: bx * cy + pz * sy, y: py, z: -bx * sy + pz * cy };
}

// Local broad phase follows the streamed forest. Swept spheres prevent tunnelling
// at any flight speed. Creature probes approximate body, head, tail, and wings.
export class FlightCollision {
  constructor(sim) { this.sim = sim; this.world = new RAPIER.World({ x: 0, y: 0, z: 0 }); this.center = null; this.age = 2; this.signature = null; }
  refresh(position, dt = 0, force = false) {
    this.age += dt;
    const moved = !this.center || Math.hypot(position.x - this.center.x, position.z - this.center.z) > 32;
    if (!force && !moved && this.age < 1) return;
    const data = this.sim.trees();
    // Snapshots arrive frequently but the forest topology usually hasn't
    // changed. A cheap fingerprint avoids rebuilding the broad phase every
    // second while still noticing cuts and visibly burned-away crowns.
    let changed = 2166136261;
    for (let i = 0; i < data.length; i += 10) {
      const burnStep = Math.floor(Math.max(0, Math.min(1, data[i + 7])) * 20);
      const value = data[i + 5] < 0 ? 255 : burnStep;
      if (value) changed = Math.imul(changed ^ (i + 1) ^ (value << 20), 16777619);
    }
    const signature = `${this.sim.revision?.() ?? ''}:${data.length}:${changed}`;
    this.age = 0;
    if (!force && !moved && signature === this.signature) return;
    this.signature = signature; this.center = { x: position.x, z: position.z };
    this.world.free(); this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    for (let i = 0; i < data.length; i += 10) {
      const x = data[i], y = data[i + 1], z = data[i + 2], h = data[i + 3], w = data[i + 4];
      if ((x - position.x) ** 2 + (z - position.z) ** 2 > 115 ** 2) continue;
      if (data[i + 5] < 0) {
        this.world.createCollider(RAPIER.ColliderDesc.cylinder(.25, w * .16).setTranslation(x, y + .25, z));
      } else {
        this.world.createCollider(RAPIER.ColliderDesc.cylinder(h * .5, w * .13).setTranslation(x, y + h * .5, z));
        // Match the renderer's shrinkage, rounded down so the collision remains
        // slightly larger than the visible crown between fingerprint updates.
        const burn = Math.floor(Math.max(0, Math.min(1, data[i + 7])) * 20) / 20;
        const t = Math.max(0, Math.min(1, (burn - .35) / .65));
        const remaining = 1 - t * t * (3 - 2 * t) * .94;
        const height = h * (1 - burn * .12);
        this.world.createCollider(RAPIER.ColliderDesc.cone(height * .54, w * 1.12 * remaining).setTranslation(x, y + height * .63, z));
      }
    }
    // Terrain triangles, slightly padded below the body to cover mesh sampling.
    const n = 65, spacing = 4, vertices = [], indices = [];
    const ox = Math.floor(position.x / spacing) * spacing - 128, oz = Math.floor(position.z / spacing) * spacing - 128;
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
      const px = ox + x * spacing, pz = oz + z * spacing;
      vertices.push(px, this.sim.height(px, pz) + .15, pz);
      if (x < n - 1 && z < n - 1) {
        const a = z * n + x; indices.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
      }
    }
    this.world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(vertices), new Uint32Array(indices)));
    this.world.step();
  }
  overlaps(position, radius) {
    let overlap = false;
    this.world.intersectionsWithShape(position, rotation, new RAPIER.Ball(radius), () => { overlap = true; return false; });
    return overlap;
  }
  // Sweeps a sphere without changing the world or the caller's position. Rapier
  // handles the visible terrain mesh and trees; a height-field check also catches
  // small ground features between the mesh samples. The normal points away from
  // the obstruction, so movement can slide along it.
  sweep(origin, delta, radius) {
    const length = Math.hypot(delta.x, delta.y, delta.z);
    if (length < 1e-9) return { fraction: 1, normal: null };
    const hit = this.world.castShape(origin, rotation, delta, new RAPIER.Ball(radius), .08, 1, false);
    let fraction = hit ? Math.max(0, hit.time_of_impact - .02 / length) : 1;
    let normal = hit ? { x: hit.normal1.x, y: hit.normal1.y, z: hit.normal1.z } : null;

    // A small safety margin over the analytic terrain prevents gaps between the
    // 4 m physics triangles and the terrain used for rendering. Check the entire
    // path, including long, high-speed moves; don't snap through an obstruction.
    const heightAt = t => this.sim.height(origin.x + delta.x * t, origin.z + delta.z * t) + radius + .3;
    const gapAt = t => origin.y + delta.y * t - heightAt(t);
    const steps = Math.max(1, Math.ceil(Math.hypot(delta.x, delta.z) / 1.5));
    let previousT = 0, previousGap = gapAt(0);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, gap = gapAt(t);
      // If already under the clearance guard, permit motion that moves out.
      if (gap < 0 && (previousGap >= 0 || gap < previousGap - 1e-5)) {
        let low = previousT, high = t;
        if (previousGap >= 0) {
          for (let j = 0; j < 12; j++) {
            const mid = (low + high) * .5;
            if (gapAt(mid) >= 0) low = mid; else high = mid;
          }
        } else low = 0;
        const groundFraction = Math.max(0, low - .02 / length);
        if (groundFraction < fraction) {
          fraction = groundFraction;
          const x = origin.x + delta.x * low, z = origin.z + delta.z * low, epsilon = .2;
          const dx = (this.sim.height(x + epsilon, z) - this.sim.height(x - epsilon, z)) / (epsilon * 2);
          const dz = (this.sim.height(x, z + epsilon) - this.sim.height(x, z - epsilon)) / (epsilon * 2);
          const size = Math.hypot(dx, 1, dz);
          normal = { x: -dx / size, y: 1 / size, z: -dz / size };
        }
        break;
      }
      previousT = t; previousGap = gap;
    }
    return { fraction, normal };
  }
  // Resolve glancing contacts by sweeping the remaining movement along the
  // surface. Moving away is allowed even inside Rapier's contact margin.
  move(position, delta, radius) {
    let remaining = { x: delta.x, y: delta.y, z: delta.z }, collided = false;
    for (let iteration = 0; iteration < 3; iteration++) {
      if (Math.hypot(remaining.x, remaining.y, remaining.z) < 1e-7) break;
      const { fraction, normal } = this.sweep(position, remaining, radius);
      position.x += remaining.x * fraction;
      position.y += remaining.y * fraction;
      position.z += remaining.z * fraction;
      if (fraction >= 1 || !normal) break;
      collided = true;
      const rest = 1 - fraction;
      remaining.x *= rest; remaining.y *= rest; remaining.z *= rest;
      const into = remaining.x * normal.x + remaining.y * normal.y + remaining.z * normal.z;
      if (into >= -1e-8) break;
      remaining.x -= into * normal.x; remaining.y -= into * normal.y; remaining.z -= into * normal.z;
    }
    return collided;
  }
  // Check all body probes. This is also useful for choosing a safe spawn or
  // transforming into a larger creature among the trees.
  overlapsCreature(state, tucked = false) {
    return creatureProbes(state.form, tucked).some(probe => {
      const offset = worldOffset(probe, state);
      return this.overlaps({ x: state.position.x + offset.x, y: state.position.y + offset.y,
        z: state.position.z + offset.z }, probe[3]);
    });
  }
  // Sweeps all probes from the previous orientation to the new orientation.
  // `advanceFlight` should run first; pass its pre-step angles in `previous`.
  // A blocked rotation is interpolated back to contact, as is the position.
  moveCreature(state, delta, { tucked = false, previous = state } = {}) {
    const before = { yaw: previous.yaw || 0, pitch: previous.pitch || 0, bank: previous.bank || 0 };
    const after = { yaw: state.yaw || 0, pitch: state.pitch || 0, bank: state.bank || 0 };
    // A fast mouse turn makes a wing trace an arc, not a straight line between
    // its endpoints. Subdivide larger rotations so the sweep follows that arc.
    const angle = Math.max(Math.abs(after.yaw - before.yaw), Math.abs(after.pitch - before.pitch), Math.abs(after.bank - before.bank));
    if (angle > .16) {
      const steps = Math.min(32, Math.ceil(angle / .16));
      state.yaw = before.yaw; state.pitch = before.pitch; state.bank = before.bank;
      for (let i = 1; i <= steps; i++) {
        const last = { yaw: state.yaw, pitch: state.pitch, bank: state.bank, tucked: i === 1 ? previous.tucked : tucked };
        state.yaw = before.yaw + (after.yaw - before.yaw) * i / steps;
        state.pitch = before.pitch + (after.pitch - before.pitch) * i / steps;
        state.bank = before.bank + (after.bank - before.bank) * i / steps;
        if (this.moveCreature(state, {x:delta.x / steps, y:delta.y / steps, z:delta.z / steps}, {tucked, previous:last})) return true;
      }
      return false;
    }
    const priorProbes = creatureProbes(state.form, previous.tucked ?? tucked);
    const nextProbes = creatureProbes(state.form, tucked);
    const center = state.position;
    let fraction = 1, normal = null;
    for (let i = 0; i < priorProbes.length; i++) {
      const start = worldOffset(priorProbes[i], before), end = worldOffset(nextProbes[i], after);
      const origin = { x: center.x + start.x, y: center.y + start.y, z: center.z + start.z };
      const travel = { x: delta.x + end.x - start.x, y: delta.y + end.y - start.y, z: delta.z + end.z - start.z };
      const hit = this.sweep(origin, travel, priorProbes[i][3]);
      if (hit.fraction < fraction) { fraction = hit.fraction; normal = hit.normal; }
    }
    center.x += delta.x * fraction; center.y += delta.y * fraction; center.z += delta.z * fraction;
    // Let the caller keep the wings tucked if opening them would intersect a tree.
    state.wingsBlocked = !!(!tucked && previous.tucked && fraction < 1);
    if (fraction >= 1 || !normal) return false;
    state.yaw = before.yaw + (after.yaw - before.yaw) * fraction;
    state.pitch = before.pitch + (after.pitch - before.pitch) * fraction;
    state.bank = before.bank + (after.bank - before.bank) * fraction;

    // Finish any tangential portion using the full outline at the stopped pose.
    // Additional passes handle corners without ever skipping over another tree.
    let remaining = { x: delta.x * (1 - fraction), y: delta.y * (1 - fraction), z: delta.z * (1 - fraction) };
    let surface = normal;
    for (let iteration = 0; iteration < 2; iteration++) {
      const into = remaining.x * surface.x + remaining.y * surface.y + remaining.z * surface.z;
      if (into < 0) { remaining.x -= into * surface.x; remaining.y -= into * surface.y; remaining.z -= into * surface.z; }
      if (Math.hypot(remaining.x, remaining.y, remaining.z) < 1e-7) break;
      let part = 1, nextSurface = null;
      const startSpan = (previous.tucked ?? tucked) ? .65 : 1, endSpan = tucked ? .65 : 1;
      const probes = creatureProbes(state.form, tucked, startSpan + (endSpan - startSpan) * fraction);
      for (const probe of probes) {
        const o = worldOffset(probe, state);
        const result = this.sweep({x:center.x + o.x, y:center.y + o.y, z:center.z + o.z}, remaining, probe[3]);
        if (result.fraction < part) { part = result.fraction; nextSurface = result.normal; }
      }
      center.x += remaining.x * part; center.y += remaining.y * part; center.z += remaining.z * part;
      if (part >= 1 || !nextSurface) break;
      remaining = { x: remaining.x * (1 - part), y: remaining.y * (1 - part), z: remaining.z * (1 - part) };
      surface = nextSurface;
    }
    return true;
  }
  // Camera placement uses the same continuous collision query but never mutates
  // player position or the physics world. Origin should be near the player.
  cameraPosition(origin, desired, radius = .3) {
    const delta = { x: desired.x - origin.x, y: desired.y - origin.y, z: desired.z - origin.z };
    const { fraction } = this.sweep(origin, delta, radius);
    return { x: origin.x + delta.x * fraction, y: origin.y + delta.y * fraction, z: origin.z + delta.z * fraction };
  }
  dispose() { this.world.free(); }
}
