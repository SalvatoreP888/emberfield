import * as THREE from './vendor/three.module.js';

const TAU = Math.PI * 2;
const RING_RADIUS = 6;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const copyPoint = p => ({ x: p.x, y: p.y, z: p.z });
const heading = yaw => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });

// Score only a genuine crossing of the hoop's plane, not a nearby flyby.
// A segment is used so a low frame rate or fast dive cannot skip a ring.
export function crossesRing(from, to, target, direction, radius = RING_RADIUS) {
  const a = (from.x - target.x) * direction.x + (from.z - target.z) * direction.z;
  const b = (to.x - target.x) * direction.x + (to.z - target.z) * direction.z;
  if ((a < 0 && b < 0) || (a > 0 && b > 0) || Math.abs(a - b) < 1e-8) return false;
  const t = a / (a - b);
  if (t < 0 || t > 1) return false;
  const x = from.x + (to.x - from.x) * t - target.x;
  const y = from.y + (to.y - from.y) * t - target.y;
  const z = from.z + (to.z - from.z) * t - target.z;
  return x * x + y * y + z * z <= radius * radius;
}

/**
 * A lightweight, optional flight activity. Scoring never changes the flight
 * simulation. Place the returned HUD state wherever it suits the game.
 *
 * const trail = new FlightGame({ scene, sim });
 * trail.start(flight);              // starts a fresh session, shows first hoop
 * const state = trail.update(flight, dt); // call once after each movement step
 * trail.snapshot(flight);            // same state without advancing anything
 * trail.dispose();                  // removes graphics on exit
 *
 * state: {rings, score, streak, bestStreak, distance, direction, event,
 *         target: {x,y,z}, active}; event is a short-lived string or ''.
 * direction is 'ahead', 'left', 'right', or 'behind'.
 */
export class FlightGame {
  constructor({ scene, sim }) {
    this.scene = scene;
    this.sim = sim;
    this.active = false;
    this.elapsed = 0;
    this.eventTime = 0;
    this.event = '';
    this.group = new THREE.Group();
    this.group.visible = false;
    this.group.name = 'flight-trail-hoop';

    this.geometries = [
      new THREE.TorusGeometry(RING_RADIUS, .17, 8, 48),
      new THREE.TorusGeometry(RING_RADIUS + .28, .055, 6, 48),
      new THREE.SphereGeometry(.16, 8, 6),
    ];
    this.materials = [
      new THREE.MeshBasicMaterial({ color: 0xffd38a }),
      new THREE.MeshBasicMaterial({ color: 0xffa84a, transparent: true, opacity: .62, depthWrite: false }),
      new THREE.MeshBasicMaterial({ color: 0xffe3a8 }),
    ];
    this.group.add(new THREE.Mesh(this.geometries[0], this.materials[0]));
    this.group.add(new THREE.Mesh(this.geometries[1], this.materials[1]));
    this.sparkles = new THREE.Group();
    for (let i = 0; i < 8; i++) {
      const spark = new THREE.Mesh(this.geometries[2], this.materials[2]);
      const angle = i / 8 * TAU;
      spark.position.set(Math.cos(angle) * RING_RADIUS, Math.sin(angle) * RING_RADIUS, 0);
      spark.scale.setScalar(i % 2 ? .75 : 1.2);
      this.sparkles.add(spark);
    }
    this.group.add(this.sparkles);
    this.scene.add(this.group);
  }

  start(flight) {
    this.rings = 0;
    this.score = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.contacts = flight.contacts || 0;
    this.previous = copyPoint(flight.position);
    this.event = '';
    this.eventTime = 0;
    this.active = true;
    this.enabled = true;
    this.group.visible = true;
    this.placeAhead(flight);
    return this.snapshot(flight);
  }

  setEnabled(enabled, flight) {
    this.enabled = Boolean(enabled);
    this.group.visible = this.active && this.enabled;
    if (this.enabled && this.active) {
      this.previous = copyPoint(flight.position);
      this.contacts = flight.contacts || 0;
      this.streak = 0;
      this.event = '';
      this.eventTime = 0;
      this.placeAhead(flight);
    }
  }

  // Choose a route 55m ahead with a little variation on later rings. Keep the
  // whole hoop above nearby treetops and local terrain; no invisible hazards.
  placeAhead(flight) {
    const arc = this.rings ? Math.sin(this.rings * 1.7) * .23 : 0;
    const direction = heading(flight.yaw + arc);
    const x = flight.position.x + direction.x * 55;
    const z = flight.position.z + direction.z * 55;
    let tallest = -Infinity;
    for (const [dx, dz] of [[0, 0], [RING_RADIUS, 0], [-RING_RADIUS, 0], [0, RING_RADIUS], [0, -RING_RADIUS]]) {
      tallest = Math.max(tallest, this.sim.height(x + dx, z + dz));
    }
    const trees = this.sim.trees();
    for (let i = 0; i < trees.length; i += 10) {
      if (trees[i + 5] < 0) continue;
      if (Math.hypot(trees[i] - x, trees[i + 2] - z) < RING_RADIUS + trees[i + 4] + 2) {
        tallest = Math.max(tallest, trees[i + 1] + trees[i + 3] * 1.2);
      }
    }
    const minimum = tallest + RING_RADIUS + 3;
    const y = Math.max(minimum, flight.position.y - 9);
    this.target = { x, y, z };
    this.direction = direction;
    this.group.position.set(x, y, z);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(direction.x, 0, direction.z));
  }

  update(flight, dt) {
    if (!this.active || !this.enabled) return this.snapshot(flight);
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, .25);
    this.elapsed += dt;
    this.eventTime = Math.max(0, this.eventTime - dt);
    if (!this.eventTime) this.event = '';
    // A collision interrupts the clean-flying chain, even if it happens during
    // the same frame as a collection. The ring itself remains achievable.
    if ((flight.contacts || 0) > this.contacts) {
      if (this.streak) {
        this.streak = 0;
        this.event = 'Bump — streak reset';
        this.eventTime = 2;
      }
      this.contacts = flight.contacts || 0;
    }
    const position = flight.position;
    if (crossesRing(this.previous, position, this.target, this.direction)) {
      this.rings++;
      this.streak++;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
      this.score += 100 + Math.min(9, this.streak - 1) * 25;
      this.event = this.streak > 1 ? `Ring cleared · ${this.streak} in a row!` : 'Ring cleared!';
      this.eventTime = 2;
      this.placeAhead(flight);
    } else {
      const dx = position.x - this.target.x, dz = position.z - this.target.z;
      const passedBy = dx * this.direction.x + dz * this.direction.z;
      // Don't strand the trail behind an exploratory player after an honest miss.
      if (Math.hypot(dx, dz) > 160 || (passedBy > 50 && Math.hypot(dx, dz) > 70)) {
        if (this.streak) {
          this.streak = 0;
          this.event = 'Missed ring — a new one is ahead';
          this.eventTime = 2.5;
        }
        this.placeAhead(flight);
      }
    }
    this.previous = copyPoint(position);
    this.sparkles.rotation.z = this.elapsed * .32;
    return this.snapshot(flight);
  }

  snapshot(flight) {
    if (!this.active) return { active: false, rings: 0, score: 0, streak: 0, bestStreak: 0, distance: 0, direction: 'ahead', event: '', target: null };
    const dx = this.target.x - flight.position.x, dy = this.target.y - flight.position.y, dz = this.target.z - flight.position.z;
    const forward = heading(flight.yaw);
    const ahead = dx * forward.x + dz * forward.z;
    const right = dx * Math.cos(flight.yaw) - dz * Math.sin(flight.yaw);
    const bearing = Math.atan2(right, ahead);
    const direction = Math.abs(bearing) > Math.PI * .7 ? 'behind' : bearing > .18 ? 'right' : bearing < -.18 ? 'left' : 'ahead';
    return { active: true, enabled: this.enabled, rings: this.rings, score: this.score, streak: this.streak, bestStreak: this.bestStreak,
      distance: Math.round(Math.hypot(dx, dy, dz)), direction, event: this.event,
      target: { ...this.target } };
  }

  dispose() {
    this.active = false;
    this.scene.remove(this.group);
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
  }
}
