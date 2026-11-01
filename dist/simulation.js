/** Rust/WASM worker bridge. Renderers read transferred snapshots, never a second fire model. */
const EMPTY = new Float32Array(0);
const DEFAULT_WEATHER = { windSpeed: 14, windAngle: -Math.PI / 4, moisture: 0.18, rain: 0 };
export class Simulation {
  static async load(seed, options = {}) {
    const response = await fetch('./simulation.wasm');
    if (!response.ok) throw new Error('The Rust simulation could not be loaded.');
    const module = await WebAssembly.compile(await response.arrayBuffer());
    const heightInstance = await WebAssembly.instantiate(module, {});
    const sim = new Simulation(heightInstance.exports, seed);
    const weather = options.weather || DEFAULT_WEATHER, scenario = options.scenario || 'clearing';
    if (!sim.heightApi.get_height_seeded) sim.heightApi.init(seed);
    if (typeof Worker !== 'undefined' && !options.forceLocal) {
      try {
        sim.worker = new Worker(new URL('./simulation.worker.js', import.meta.url), { type: 'module', name: 'Emberfield Rust simulation' });
        sim.worker.onmessage = event => sim.receive(event.data);
        sim.worker.onerror = event => sim.fail(new Error(event.message || 'Simulation worker could not start.'));
        sim.thread = 'worker';
        await sim.request('init', { module, seed, weather, scenario });
        return sim;
      } catch (error) {
        sim.worker?.terminate(); sim.worker = null; sim.fallbackReason = error.message; sim.failure = null;
      }
    }
    sim.thread = 'main'; sim.local = sim.heightApi; sim.local.init(seed);
    sim.local.set_weather(weather.windSpeed, weather.windAngle, weather.moisture, weather.rain);
    sim.startLocal(scenario); sim.refreshLocal(); return sim;
  }
  constructor(heightApi, seed) {
    this.heightApi = heightApi; this.seed = seed; this.thread = 'starting';
    this.focus = { x: 0, z: 0 }; this.requestedFocus = { x: 0, z: 0 };
    this.sequence = 0; this.epoch = 0; this.topology = 0; this.pending = new Map(); this.nextId = 1;
    this.buffer = null; this.data = { trees: EMPTY, fire: EMPTY, smoke: EMPTY, embers: EMPTY, stats: new Float32Array(8) };
    this.metrics = { stepMs: 0, workMs: 0, actualSpeed: 0, snapshotHz: 0, backlogMs: 0, droppedSeconds: 0 };
    this.control = { paused: true, speed: 1, visible: true }; this.accumulator = 0; this.lastControl = ''; this.failure = null;
  }
  request(type, fields = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error('The simulation did not respond in time.')); }, 20000);
      this.pending.set(id, { resolve, reject, timeout });
      this.worker.postMessage({ type, ...fields, id, epoch: this.epoch });
    });
  }
  receive(message) {
    if (message.type === 'error') { this.fail(new Error(message.message)); return; }
    if (message.type !== 'snapshot') return;
    if (message.epoch !== this.epoch) { this.worker.postMessage({ type: 'recycle', buffer: message.buffer }, [message.buffer]); return; }
    const previous = this.buffer; this.buffer = message.buffer; let offset = 0;
    const view = count => { const a = new Float32Array(this.buffer, offset * 4, count); offset += count; return a; };
    this.data = { trees: view(message.trees * 10), fire: view(message.trees * 4), smoke: view(message.smoke * 8), embers: view(message.embers * 8), stats: view(8) };
    this.sequence++; this.topology = message.revision; this.focus = message.focus;
    this.metrics = message.metrics; this.snapshotAt = performance.now();
    for (const id of message.responses || []) {
      const pending = this.pending.get(id);
      if (pending) { clearTimeout(pending.timeout); this.pending.delete(id); pending.resolve(this); }
    }
    // Old array views become detached here. Renderers copy any interpolation history.
    if (previous) this.worker.postMessage({ type: 'recycle', buffer: previous }, [previous]);
  }
  fail(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear(); this.failure = error.message; this.onError?.(error);
  }
  trees() { return this.data.trees; }
  fireStates() { return this.data.fire; }
  smoke() { return this.data.smoke; }
  embers() { return this.data.embers; }
  stats() { return this.data.stats; }
  revision() { return this.topology; }
  height(x, z) { return this.heightApi.get_height_seeded ? this.heightApi.get_height_seeded(x, z, this.seed) : this.heightApi.get_height(x, z); }
  setControl(paused, speed, visible = true) {
    this.control = { paused, speed, visible };
    const signature = [paused, speed, visible].join('|');
    if (signature === this.lastControl) return;
    this.lastControl = signature; this.accumulator = 0;
    this.worker?.postMessage({ type: 'control', ...this.control, epoch: this.epoch });
  }
  weather(windSpeed, windAngle, moisture, rain) {
    if (this.worker) this.worker.postMessage({ type: 'weather', weather: { windSpeed, windAngle, moisture, rain }, epoch: this.epoch });
    else { this.local.set_weather(windSpeed, windAngle, moisture, rain); this.refreshLocal(); }
  }
  setFocus(x, z) {
    if (Math.hypot(x - this.requestedFocus.x, z - this.requestedFocus.z) < 0.1) return;
    this.requestedFocus = { x, z };
    if (this.worker) this.worker.postMessage({ type: 'focus', x, z, epoch: this.epoch });
    else { this.local.set_focus(x, z); this.focus = { x, z }; this.refreshLocal(); }
  }
  brush(mode, x, z, radius) {
    if (this.worker) this.worker.postMessage({ type: 'brush', mode, x, z, radius, epoch: this.epoch });
    else { this.local[{ ignite: 'ignite', water: 'extinguish', clear: 'firebreak' }[mode]](x, z, radius); this.refreshLocal(); }
  }
  ignite(x, z, r) { this.brush('ignite', x, z, r); }
  water(x, z, r) { this.brush('water', x, z, r); }
  clear(x, z, r) { this.brush('clear', x, z, r); }
  async reset(seed, options = {}) {
    this.epoch++; this.seed = seed; this.failure = null; this.requestedFocus = { x: 0, z: 0 };
    const weather = options.weather || DEFAULT_WEATHER, scenario = options.scenario || 'clearing';
    if (!this.heightApi.get_height_seeded && this.worker) this.heightApi.reset(seed);
    if (this.worker) await this.request('reset', { seed, weather, scenario });
    else {
      this.local.reset(seed); this.local.set_weather(weather.windSpeed, weather.windAngle, weather.moisture, weather.rain);
      this.focus = { x: 0, z: 0 }; this.startLocal(scenario); this.refreshLocal();
    }
    return this;
  }
  startLocal(scenario) {
    if (scenario === 'empty') return;
    this.local.ignite(-18, -16, scenario === 'spark' ? 4 : 12);
    if (scenario !== 'spark') this.local.ignite(-7, -22, 6);
    for (let i = 0; i < 4; i++) this.local.step(2);
  }
  refreshLocal() {
    const a = this.local, memory = a.memory.buffer;
    this.data = { trees: new Float32Array(memory, a.trees_ptr(), a.tree_count() * 10), fire: new Float32Array(memory, a.fire_states_ptr(), a.tree_count() * 4), smoke: new Float32Array(memory, a.smoke_ptr(), a.smoke_count() * 8), embers: new Float32Array(memory, a.embers_ptr(), a.embers_count() * 8), stats: new Float32Array(memory, a.stats_ptr(), 8) };
    this.topology = a.world_revision(); this.sequence++;
  }
  // Reduced, bounded scheduling only for browsers which cannot create workers.
  advanceLocal(realDt) {
    if (!this.local || this.control.paused || !this.control.visible) return;
    this.accumulator = Math.min(0.5, this.accumulator + Math.min(realDt, 0.1) * this.control.speed);
    const started = performance.now(); let steps = 0;
    while (this.accumulator + 1e-7 >= 0.05 && steps < 4 && (steps === 0 || performance.now() - started < 4)) {
      this.local.step(0.05); this.accumulator -= 0.05; steps++;
    }
    if (steps) { this.metrics.stepMs = (performance.now() - started) / steps; this.metrics.actualSpeed = steps * 0.05 / Math.max(realDt, 0.001); this.refreshLocal(); }
  }
  dispose() {
    this.worker?.terminate();
    for (const pending of this.pending.values()) clearTimeout(pending.timeout);
    this.pending.clear(); this.buffer = null;
    this.data = { trees: EMPTY, fire: EMPTY, smoke: EMPTY, embers: EMPTY, stats: new Float32Array(8) };
  }
}
