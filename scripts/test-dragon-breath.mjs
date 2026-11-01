import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from '../dist/vendor/three.module.js';
import { DragonBreath, traceBreath, BREATH_RANGE } from '../dist/dragon-breath.js';

const tree = (x, z, variant = 0, y = 0, h = 16, w = 3) => [x, y, z, h, w, variant, 0, 0, 0, 0];
const calls = [];
const mock = { data: new Float32Array(), trees() { return this.data; }, height: () => 0,
  ignite: (...args) => calls.push(args) };
const flat = { x: 0, y: 0, z: -1 };
const high = { x: 0, y: 30, z: 0 };
assert.equal(traceBreath(mock, high, flat), null, 'level fire well above the forest misses the ground');
const down = traceBreath(mock, { x: 0, y: 8, z: 0 }, { x: 0, y: -1, z: -1 });
assert.equal(down.kind, 'ground'); assert.ok(Math.abs(down.point.y) < .01, 'a downward ray meets terrain');
assert.equal(traceBreath(mock, { x: 0, y: 80, z: 0 }, { x: 0, y: -1, z: 0 }), null, 'range is finite');

mock.data = new Float32Array([...tree(0, -8), ...tree(0, -18)]);
let hit = traceBreath(mock, { x: 0, y: 8, z: 0 }, flat);
assert.equal(hit.kind, 'tree'); assert.equal(hit.target.z, -8, 'nearest tree blocks fire from a farther tree');
assert.ok(hit.distance < 8 && hit.distance > 0);
mock.data = new Float32Array([...tree(0, -8, -1), ...tree(0, -18)]);
hit = traceBreath(mock, { x: 0, y: .25, z: 0 }, flat);
assert.equal(hit.kind, 'stump', 'a cut stump blocks fire without acting as fuel');
assert.equal(hit.target.z, -8);
assert.equal(traceBreath(mock, { x: 0, y: 8, z: 0 }, flat)?.target.z, -18, 'cut canopy does not block fire');
mock.data = new Float32Array([...tree(0, -BREATH_RANGE - 20)]);
assert.equal(traceBreath(mock, { x: 0, y: 8, z: 0 }, flat), null, 'out-of-range trees cannot be ignited');

const scene = new THREE.Scene();
const breath = new DragonBreath({ scene, sim: mock });
const flight = { form: 'dragon', position: { x: 0, y: 8, z: 0 }, yaw: 0, pitch: 0, bank: 0 };
mock.data = new Float32Array([...tree(0, -12)]);
let status = breath.update(flight, .1, true);
assert.equal(status.ignited, true); assert.equal(calls.length, 1);
assert.equal(calls[0][1], -12, 'simulation ignition targets the struck tree');
assert.equal(status.hit.kind, 'tree'); assert.ok(status.fuel < 100);
assert.ok(breath.mesh.count > 0 && breath.core.visible, 'fire is drawn on firing');
breath.update(flight, .05, true); assert.equal(calls.length, 1, 'ignition commands are rate-limited');
flight.form = 'bird'; status = breath.update(flight, .1, true);
assert.equal(status.firing, false); assert.equal(breath.core.visible, false); assert.equal(calls.length, 1, 'bird cannot breathe fire');
flight.form = 'dragon'; mock.data = new Float32Array(); calls.length = 0;
for (let i = 0; i < 60; i++) status = breath.update(flight, .1, true);
assert.equal(calls.length, 0, 'empty air does not start unseen ground fires');
assert.ok(status.fuel < 30 || status.overheated, 'breath has a finite charge and recovery delay');
for (let i = 0; i < 70; i++) status = breath.update(flight, .1, false);
assert.ok(status.fuel > 99 && !status.overheated, 'released breath recharges');
breath.reset(); assert.equal(breath.mesh.count, 0); assert.equal(breath.core.visible, false);
breath.dispose(); assert.equal(scene.children.length, 0, 'visual resources are removed');

// Exercise the shipped WASM as the authoritative source: the dragon's ray
// strikes the unburned forest and issues a real ignition, rather than a visual.
const wasm = await WebAssembly.instantiate(await readFile(new URL('../dist/simulation.wasm', import.meta.url)), {});
const core = wasm.instance.exports;
core.init(2049);
const getTrees = () => new Float32Array(core.memory.buffer, core.trees_ptr(), core.tree_count() * 10);
const data = getTrees();
const tx = data[0], ty = data[1], tz = data[2], h = data[3];
const actual = { trees: getTrees, height: (x, z) => core.get_height(x, z), ignite: (x, z, r) => core.ignite(x, z, r) };
const scene2 = new THREE.Scene(), realBreath = new DragonBreath({ scene: scene2, sim: actual });
const actualFlight = { form: 'dragon', position: { x: tx, y: ty + h * .55 - .3, z: tz + 22 }, yaw: 0, pitch: 0, bank: 0 };
const before = new Float32Array(core.memory.buffer, core.stats_ptr(), 8)[1];
status = realBreath.update(actualFlight, .05, true);
const after = new Float32Array(core.memory.buffer, core.stats_ptr(), 8)[1];
assert.ok(status.ignited && after > before, 'dragon breath ignites real Rust-simulated fuel');
for (let i = 0; i < 1000; i++) core.step(.1);
const spread = new Float32Array(core.memory.buffer, core.stats_ptr(), 8)[1];
assert.ok(spread > after, 'dragon-started fire spreads through the authoritative simulation');
realBreath.dispose();
console.log('PASS dragon breath hits nearest foliage/terrain, respects stumps/range, rate-limits ignition, recharges, renders, and starts fire that spreads in the real Rust simulation.');
