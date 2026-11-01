import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const binary = resolve(option('--wasm', fileURLToPath(new URL('../dist/simulation.wasm', import.meta.url))));
const kind = option('--label', 'current');
const output = option('--out', '');
const repeats = Math.max(1, Number(option('--repeats', '3')));
const seconds = Math.max(1, Number(option('--seconds', '20')));
const bytes = await readFile(binary);
const module = await WebAssembly.compile(bytes);
const advance = (sim, duration) => {
  for (let i = 0; i < Math.round(duration * 20); i++) sim.step(0.05);
};
const snapshot = sim => {
  const values = Array.from(new Float32Array(sim.memory.buffer, sim.stats_ptr(), 8));
  return {
    seconds: values[0], burning: values[1], burned: values[2], trees: values[3], chunks: values[7],
    smoke: sim.smoke_count(), embers: sim.embers_count(), memoryBytes: sim.memory.buffer.byteLength,
  };
};
const rows = [];
for (const scenario of ['idle', 'established_fire', 'large_fire', 'rain', 'streaming']) {
  const samples = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const sim = (await WebAssembly.instantiate(module)).exports;
    sim.init(2049);
    sim.set_weather(14, -Math.PI / 4, 0.18, 0);
    if (scenario !== 'idle' && scenario !== 'streaming') {
      sim.ignite(-18, -16, 12);
      sim.ignite(-7, -22, 6);
      advance(sim, scenario === 'large_fire' ? 240 : 100);
    }
    if (scenario === 'rain') sim.set_weather(14, -Math.PI / 4, 0.18, 1);
    const before = snapshot(sim);
    const started = performance.now();
    if (scenario === 'streaming') {
      for (let i = 1; i <= Math.round(seconds); i++) {
        sim.set_focus(i * 36, Math.floor(i / 3) * 36);
        advance(sim, 1);
      }
    } else advance(sim, seconds);
    const wallMs = performance.now() - started;
    samples.push({ repeat, wallMs, msPerSimulatedSecond: wallMs / seconds, before, after: snapshot(sim) });
  }
  const sorted = samples.map(x => x.msPerSimulatedSecond).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  rows.push({
    scenario, simulatedSeconds: seconds, repeats, medianMsPerSimulatedSecond: median,
    minMsPerSimulatedSecond: sorted[0], maxMsPerSimulatedSecond: sorted.at(-1), samples,
  });
}
const result = {
  kind, binary, sha256: createHash('sha256').update(bytes).digest('hex'), wasmBytes: bytes.length,
  node: process.version, platform: process.platform, arch: process.arch,
  cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length,
  method: `Fresh module instance per repeat; seed2049,wind14km/hNE,moisture18%;20Hz export calls; setup/advance to scenario time excluded;${repeats} repeats,${seconds} simulated seconds measured. Streaming includes${Math.round(seconds)} one-chunk movements with1s integration each. JS-to-WASM packing included; rendering excluded.`,
  rows,
};
if (output) {
  const path = resolve(output);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(result, null, 2));
