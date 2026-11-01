import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { SimulationRunner } from '../dist/simulation.worker.js';
import { Simulation } from '../dist/simulation.js';

const module = await WebAssembly.compile(await readFile(new URL('../dist/simulation.wasm', import.meta.url)));
const weather = { windSpeed: 14, windAngle: -Math.PI / 4, moisture: .18, rain: 0 };
const passed = [];
async function test(name, fn) { await fn(); passed.push(name); console.log('PASS ' + name); }
async function fixture(scenario = 'clearing') {
  let clock = 0;
  const height = (await WebAssembly.instantiate(module, {})).exports;
  if (!height.get_height_seeded) height.init(2049);
  const bridge = new Simulation(height, 2049); bridge.thread = 'worker';
  const runner = new SimulationRunner((message, transfer) => bridge.receive(structuredClone(message, { transfer })), { now: () => clock, automatic: false });
  bridge.worker = { postMessage(message, transfer = []) { runner.handle(structuredClone(message, { transfer })); }, terminate() { runner.dispose(); } };
  await bridge.request('init', { module, seed: 2049, weather, scenario });
  return { bridge, runner, advance(ms) { clock += ms; runner.pump(); }, close() { bridge.dispose(); } };
}

await test('worker snapshot matches the authoritative WASM buffers', async () => {
  const f = await fixture(), a = f.runner.api;
  assert.deepEqual(f.bridge.trees(), new Float32Array(a.memory.buffer, a.trees_ptr(), a.tree_count()*10));
  assert.deepEqual(f.bridge.fireStates(), new Float32Array(a.memory.buffer, a.fire_states_ptr(), a.tree_count()*4));
  assert.deepEqual(f.bridge.stats(), new Float32Array(a.memory.buffer, a.stats_ptr(), 8));
  assert.equal(f.bridge.stats()[3], 3601); f.close();
});
await test('transferred old snapshots detach while new data stays valid', async () => {
  const f = await fixture(), old = f.bridge.trees();
  f.bridge.setControl(false, 1); f.advance(50);
  assert.equal(old.byteLength, 0); assert.equal(f.bridge.trees().length, 36010);
  assert.ok(f.bridge.sequence >= 2); assert.ok(f.runner.outstanding <= 2); f.close();
});
await test('simulation time does not depend on render-frame frequency', async () => {
  const a = await fixture(), b = await fixture();
  a.bridge.setControl(false, 1); b.bridge.setControl(false, 1);
  for(let i=0;i<200;i++)a.advance(50);
  for(let i=0;i<1000;i++)b.advance(10);
  assert.deepEqual(a.bridge.trees(), b.bridge.trees());
  assert.deepEqual(a.bridge.smoke(), b.bridge.smoke()); a.close(); b.close();
});
await test('pause and hidden tabs do not create a catch-up backlog', async () => {
  const f = await fixture(), start = f.bridge.stats()[0];
  f.advance(20000); assert.equal(f.bridge.stats()[0], start);
  f.bridge.setControl(false, 1, false); f.advance(20000); assert.equal(f.bridge.stats()[0], start);
  f.bridge.setControl(false, 1, true); f.advance(50);
  assert.ok(Math.abs(f.bridge.stats()[0] - start - .05) < .001); f.close();
});
await test('6x playback uses fixed steps and has bounded catch-up work', async () => {
  const f = await fixture(); f.bridge.setControl(false, 6);
  const start = f.bridge.stats()[0];
  for(let i=0;i<40;i++)f.advance(50);
  assert.ok(Math.abs(f.bridge.stats()[0] - start - 12) < .01);
  const before = f.bridge.stats()[0]; f.advance(5000);
  assert.ok(f.bridge.stats()[0] - before <= .401);
  assert.ok(f.runner.accumulator <= 1); assert.ok(f.runner.metrics.droppedSeconds > 0); f.close();
});
await test('paused brush edits publish, suppress, and cut actual Rust fuel', async () => {
  const f = await fixture('empty'); assert.equal(f.bridge.stats()[1], 0);
  f.bridge.ignite(-18,-16,12); assert.ok(f.bridge.stats()[1] > 0);
  f.bridge.water(-18,-16,13); assert.equal(f.bridge.stats()[1], 0);
  f.bridge.clear(-18,-16,13);
  assert.ok(Array.from(f.bridge.trees()).some((value,i) => i%10===5 && value===-1)); f.close();
});
await test('reset advances epoch, replaces topology and rejects stale snapshots', async () => {
  const f = await fixture();
  const oldBuffer = f.bridge.buffer.slice(0), oldRevision = f.bridge.revision();
  await f.bridge.reset(428,{weather,scenario:'empty'});
  assert.equal(f.bridge.epoch,1); assert.equal(f.bridge.stats()[0],0); assert.equal(f.bridge.stats()[1],0);
  assert.notEqual(f.bridge.revision(),oldRevision);
  const sequence = f.bridge.sequence;
  f.bridge.receive({type:'snapshot',epoch:0,buffer:oldBuffer});
  assert.equal(f.bridge.sequence,sequence); assert.equal(oldBuffer.byteLength,0); f.close();
});
await test('snapshot backpressure bounds the queue without stopping physics', async () => {
  let clock=0; const messages=[];
  const runner = new SimulationRunner((m,t)=>messages.push(structuredClone(m,{transfer:t})),{now:()=>clock,automatic:false});
  await runner.handle({type:'init',module,seed:2049,weather,epoch:0,id:1,scenario:'empty'});
  await runner.handle({type:'control',paused:false,speed:1,visible:true});
  for(let i=0;i<100;i++){clock+=50;runner.pump();}
  assert.equal(messages.length,2);assert.equal(runner.outstanding,2);
  assert.ok(new Float32Array(runner.api.memory.buffer,runner.api.stats_ptr(),8)[0]>4.9);
  await runner.handle({type:'recycle',buffer:messages[0].buffer});clock+=50;runner.pump();
  assert.equal(messages.length,3);assert.ok(runner.outstanding<=2);runner.dispose();
});
await test('real worker thread transfers data and leaves the host responsive', async () => {
  const height=(await WebAssembly.instantiate(module,{})).exports;
  const bridge=new Simulation(height,2049);bridge.thread='worker';
  const worker=new Worker(new URL('./worker-node-host.mjs',import.meta.url),{type:'module'});
  bridge.worker=worker;worker.on('message',m=>bridge.receive(m));worker.on('error',e=>bridge.fail(e));
  await bridge.request('init',{module,seed:2049,weather,scenario:'clearing'});
  bridge.ignite(0,0,130);bridge.setControl(false,6);
  let pulses=0;const pulse=setInterval(()=>pulses++,5);
  await new Promise(resolve=>setTimeout(resolve,600));clearInterval(pulse);
  bridge.setControl(true,1);await bridge.request('snapshot');
  assert.ok(bridge.sequence>3);assert.ok(bridge.stats()[0]>8.1);assert.ok(pulses>20);
  const stopped=bridge.stats()[0];await new Promise(resolve=>setTimeout(resolve,120));
  assert.equal(bridge.stats()[0],stopped);assert.ok(!bridge.failure);bridge.dispose();
});
console.log('\n' + passed.length + ' worker integration checks passed.');
