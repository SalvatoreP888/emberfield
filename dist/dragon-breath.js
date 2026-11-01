import * as THREE from './vendor/three.module.js';

// Breath travels in the dragon's facing direction. All distances are metres;
// the actual fire is always created by the Rust simulation's ignite command.
export const BREATH_RANGE = 36;
const CONSUMPTION = 30, RECOVERY = 18, RESTART = 30, IGNITE_INTERVAL = .20;
const EPSILON = 1e-7;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Find the first intersection with a capped vertical cone (taper > 0) or
// cylinder (taper == 0). At yTop the effective radius is `tipRadius`.
function coneIntersection(origin, direction, x, z, yBottom, yTop, tipRadius, taper, limit) {
  let first = 0, last = limit;
  if (Math.abs(direction.y) < EPSILON) {
    if (origin.y < yBottom || origin.y > yTop) return null;
  } else {
    let a = (yBottom - origin.y) / direction.y, b = (yTop - origin.y) / direction.y;
    if (a > b) [a, b] = [b, a];
    first = Math.max(first, a); last = Math.min(last, b);
    if (first > last) return null;
  }
  const ox = origin.x - x, oz = origin.z - z;
  const radius = tipRadius + taper * (yTop - origin.y);
  const change = -taper * direction.y;
  const a = direction.x ** 2 + direction.z ** 2 - change ** 2;
  const b = 2 * (ox * direction.x + oz * direction.z - radius * change);
  const c = ox ** 2 + oz ** 2 - radius ** 2;
  const value = t => (a * t + b) * t + c;
  if (value(first) <= EPSILON) return first;
  if (Math.abs(a) < EPSILON) {
    if (Math.abs(b) < EPSILON) return null;
    const root = -c / b;
    return root >= first && root <= last && value(Math.min(last, root + .001)) <= EPSILON ? root : null;
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const candidates = [(-b - root) / (2 * a), (-b + root) / (2 * a)].sort((x, y) => x - y);
  for (const t of candidates) {
    if (t >= first && t <= last && (value(Math.min(last, t + .001)) <= EPSILON || Math.abs(value(t)) < EPSILON)) return t;
  }
  return null;
}

/**
 * Trace a finite breath ray to the nearest ground, tree, or stump. Trees use
 * the same crown/cone and trunk dimensions as the forest view. Cut trees stop
 * breath at their stumps but do not become fuel. Returns null on a clean miss.
 * Exported for deterministic collision verification.
 */
export function traceBreath(sim, origin, direction, maxDistance = BREATH_RANGE) {
  const magnitude = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(magnitude) || magnitude < EPSILON || !Number.isFinite(maxDistance) || maxDistance <= 0) return null;
  const d = { x: direction.x / magnitude, y: direction.y / magnitude, z: direction.z / magnitude };
  let nearest = maxDistance + EPSILON, kind = null, target = null;

  // Ground is sampled before trees; later comparisons find whichever came first.
  // Fine sampling avoids jumping over the small terrain features during a dive.
  const heightAt = t => origin.y + d.y * t - sim.height(origin.x + d.x * t, origin.z + d.z * t);
  let previous = 0;
  if (heightAt(0) <= 0) { nearest = 0; kind = 'ground'; }
  else for (let t = .75; t <= maxDistance + .75; t += .75) {
    const now = Math.min(t, maxDistance);
    if (heightAt(now) <= 0) {
      let low = previous, high = now;
      for (let step = 0; step < 8; step++) {
        const middle = (low + high) / 2;
        if (heightAt(middle) > 0) low = middle; else high = middle;
      }
      nearest = high; kind = 'ground'; break;
    }
    if (now === maxDistance) break;
    previous = now;
  }

  const data = sim.trees();
  for (let i = 0; i < data.length; i += 10) {
    const x = data[i], y = data[i + 1], z = data[i + 2], height = data[i + 3], width = data[i + 4];
    if (!Number.isFinite(x + y + z + height + width) || height <= 0 || width <= 0) continue;
    if (Math.hypot(x - origin.x, z - origin.z) > nearest + width * 1.5 + 1) continue;
    const cut = data[i + 5] < 0;
    let hit;
    if (cut) {
      hit = coneIntersection(origin, d, x, z, y, y + .5, width * .16 + .15, 0, nearest);
    } else {
      // The renderer reduces the crown as it burns; the trunk stays in place.
      const burn = clamp(data[i + 7], 0, 1);
      const u = clamp((burn - .35) / .65, 0, 1), smooth = u * u * (3 - 2 * u);
      const crownHeight = height * (1 - burn * .12), crownWidth = width * (1 - smooth * .94);
      const bottom = y + crownHeight * .09, top = y + crownHeight * 1.17;
      const crown = coneIntersection(origin, d, x, z, bottom, top, .12, crownWidth * 1.12 / (top - bottom), nearest);
      const trunk = coneIntersection(origin, d, x, z, y, y + height, width * .13 + .12, 0, nearest);
      hit = crown === null ? trunk : trunk === null ? crown : Math.min(crown, trunk);
    }
    if (hit !== null && hit < nearest) {
      nearest = hit; kind = cut ? 'stump' : 'tree'; target = { x, z };
    }
  }
  if (!kind || nearest > maxDistance) return null;
  const point = { x: origin.x + d.x * nearest, y: origin.y + d.y * nearest, z: origin.z + d.z * nearest };
  return { kind, point, distance: nearest, target: target || { x: point.x, z: point.z } };
}

/**
 * DragonBreath owns a short-lived visual fire stream and a regenerating charge.
 * update(flight, dt, firing) returns {fuel, fraction, firing, overheated, hit,
 * ignited, totalIgnitions}; hit is null or {kind, point, distance, target}.
 * `ignited` means an actual command was sent to the simulation on this update.
 * Call reset() when leaving flight, dispose() when discarding the instance.
 */
export class DragonBreath {
  constructor({ scene, sim }) {
    this.scene = scene; this.sim = sim;
    this.position = new THREE.Vector3(); this.direction = new THREE.Vector3();
    this.mouth = new THREE.Vector3(); this.side = new THREE.Vector3(); this.temporary = new THREE.Vector3();
    this.rotation = new THREE.Euler(0, 0, 0, 'YXZ'); this.matrix = new THREE.Matrix4();
    this.quaternion = new THREE.Quaternion(); this.scale = new THREE.Vector3(); this.up = new THREE.Vector3(0, 1, 0);
    this.color = new THREE.Color(); this.particles = []; this.randomSeed = 92781;

    // One instanced draw call for bounded, short-lived, incandescent fireballs.
    this.geometry = new THREE.IcosahedronGeometry(1, 0);
    this.material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .76,
      blending: THREE.NormalBlending, depthWrite: false, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, 72);
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.renderOrder = 8;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(this.mesh);

    // The faint tapered core connects the fireballs to the dragon's mouth.
    this.coreGeometry = new THREE.CylinderGeometry(.06, 1.1, 1, 8, 1, true);
    this.coreMaterial = new THREE.MeshBasicMaterial({ color: 0xff7a16, transparent: true, opacity: .22,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false, toneMapped: false });
    this.core = new THREE.Mesh(this.coreGeometry, this.coreMaterial); this.core.visible = false;
    this.core.frustumCulled = false; this.core.renderOrder = 7; scene.add(this.core);
    this.reset();
  }
  random() { this.randomSeed = (Math.imul(this.randomSeed, 1664525) + 1013904223) >>> 0; return this.randomSeed / 4294967296; }
  reset() {
    this.fuel = 100; this.overheated = false; this.totalIgnitions = 0; this.igniteTimer = 0;
    this.emitCredit = 0; this.hit = null; this.particles.length = 0; this.mesh.count = 0; this.core.visible = false;
  }
  update(flight, dt, requested) {
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, .25);
    const dragon = flight?.form === 'dragon' && flight.position;
    if (this.overheated && this.fuel >= RESTART) this.overheated = false;
    const active = !!(dragon && requested && !this.overheated && this.fuel > 0 && dt > 0);
    const activeDt = active ? Math.min(dt, this.fuel / CONSUMPTION) : 0;
    if (active) {
      this.fuel = Math.max(0, this.fuel - CONSUMPTION * activeDt);
      if (this.fuel <= EPSILON) { this.fuel = 0; this.overheated = true; }
    } else this.fuel = Math.min(100, this.fuel + RECOVERY * dt);

    let ignited = false;
    if (active) {
      const { x, y, z } = flight.position;
      this.rotation.set(flight.pitch || 0, flight.yaw || 0, flight.bank || 0, 'YXZ');
      this.position.set(x, y, z);
      this.mouth.set(0, .3, -2.1).applyEuler(this.rotation).add(this.position);
      this.direction.set(0, 0, -1).applyEuler(this.rotation).normalize();
      this.igniteTimer -= activeDt;
      if (this.igniteTimer <= 0) {
        this.hit = traceBreath(this.sim, this.mouth, this.direction);
        this.igniteTimer = IGNITE_INTERVAL;
        if (this.hit && this.hit.kind !== 'stump') {
          const { x: hitX, z: hitZ } = this.hit.target;
          this.sim.ignite(hitX, hitZ, this.hit.kind === 'tree' ? 3 : 4);
          this.totalIgnitions++; ignited = true;
        }
      }
      const distance = this.hit ? this.hit.distance : BREATH_RANGE;
      this.core.visible = distance > .1;
      this.core.position.copy(this.mouth).addScaledVector(this.direction, distance / 2);
      this.temporary.copy(this.direction).negate();
      this.core.quaternion.setFromUnitVectors(this.up, this.temporary);
      this.core.scale.set(1, distance, 1);
      this.side.crossVectors(this.direction, this.up).normalize();
      if (this.side.lengthSq() < .01) this.side.set(1, 0, 0);
      this.temporary.crossVectors(this.side, this.direction).normalize();
      this.emitCredit += activeDt * 100;
      while (this.emitCredit >= 1 && this.particles.length < 72) {
        this.emitCredit--;
        const speed = 48 + this.random() * 20;
        const spread = .7 + this.random() * 2;
        const angle = this.random() * Math.PI * 2;
        const velocity = this.direction.clone().multiplyScalar(speed)
          .addScaledVector(this.side, Math.cos(angle) * spread).addScaledVector(this.temporary, Math.sin(angle) * spread);
        this.particles.push({ position: this.mouth.clone(), velocity, age: 0,
          life: Math.min(.62, Math.max(.025, distance / speed)), size: .65 + this.random() * .5 });
      }
      // No backlog of delayed particles after a temporary cap.
      this.emitCredit = Math.min(this.emitCredit, 1);
    } else {
      this.core.visible = false; this.hit = null; this.igniteTimer = 0; this.emitCredit = 0;
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i]; particle.age += dt;
      if (particle.age >= particle.life) { this.particles.splice(i, 1); continue; }
      particle.position.addScaledVector(particle.velocity, dt);
    }
    for (let i = 0; i < this.particles.length; i++) {
      const particle = this.particles[i], t = particle.age / particle.life;
      const radius = particle.size * (.4 + Math.sin(t * Math.PI) * .8);
      this.scale.setScalar(radius); this.matrix.compose(particle.position, this.quaternion.identity(), this.scale);
      this.mesh.setMatrixAt(i, this.matrix);
      this.color.setRGB(1, .72 - t * .58, .12 - t * .1); this.mesh.setColorAt(i, this.color);
    }
    this.mesh.count = this.particles.length; this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    return { fuel: this.fuel, fraction: this.fuel / 100, firing: active, overheated: this.overheated,
      hit: this.hit, ignited, totalIgnitions: this.totalIgnitions };
  }
  dispose() {
    this.scene.remove(this.mesh, this.core);
    this.geometry.dispose(); this.material.dispose(); this.coreGeometry.dispose(); this.coreMaterial.dispose();
    this.particles.length = 0;
  }
}
