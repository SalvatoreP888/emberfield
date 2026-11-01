// Fixed-step scheduling and transferable snapshots. Rust owns every physical rule.
const STEP = 0.05, SNAPSHOT_MS = 50, MAX_OUTSTANDING = 2;

export class SimulationRunner {
  constructor(post, options = {}) {
    this.post = post;
    this.now = options.now || (() => performance.now());
    this.schedule = options.schedule || ((fn, delay) => setTimeout(fn, delay));
    this.cancel = options.cancel || (id => clearTimeout(id));
    this.automatic = options.automatic !== false;
    this.api = null; this.pool = []; this.outstanding = 0; this.responses = [];
    this.epoch = 0; this.sequence = 0; this.focus = { x: 0, z: 0 };
    this.paused = true; this.visible = true; this.speed = 1;
    this.accumulator = 0; this.dirty = false; this.timer = null;
    this.metrics = { stepMs: 0, workMs: 0, actualSpeed: 0, snapshotHz: 0, droppedSeconds: 0, streamMs: 0, snapshots: 0 };
    this.resetClock();
  }
  resetClock() {
    const now = this.now();
    this.lastPump = now; this.lastSnapshot = -Infinity; this.rateStart = now;
    this.rateSteps = this.rateWork = this.rateSnapshots = 0;
  }
  async handle(message) {
    try {
      if (message.type === 'init') {
        const instance = await WebAssembly.instantiate(message.module, {});
        this.api = instance.exports; this.epoch = message.epoch;
        this.api.init(message.seed); this.seed = message.seed;
        this.applyWeather(message.weather); this.startFire(message.scenario);
        this.dirty = true;
        if (message.id) this.responses.push(message.id);
        this.resetClock(); this.publish(); this.wake(); return;
      }
      if (message.type === 'recycle') {
        this.outstanding = Math.max(0, this.outstanding - 1);
        if (message.buffer instanceof ArrayBuffer && message.buffer.byteLength && this.pool.length < 3) this.pool.push(message.buffer);
        if (this.responses.length || this.dirty) this.publish();
        return;
      }
      if (!this.api) return;
      if (message.type === 'control') {
        this.paused = !!message.paused; this.visible = message.visible !== false;
        this.speed = Math.max(0.25, Math.min(6, Number(message.speed) || 1));
        // Resuming never pays back time spent hidden or paused.
        this.accumulator = 0; this.lastPump = this.now(); this.wake(); return;
      }
      if (message.type === 'reset') {
        this.epoch = message.epoch; this.seed = message.seed;
        this.api.reset(message.seed); this.focus = { x: 0, z: 0 };
        this.applyWeather(message.weather); this.startFire(message.scenario);
        this.accumulator = 0; this.metrics.droppedSeconds = 0;
        this.metrics.actualSpeed = 0; this.resetClock();
      } else if (message.epoch !== this.epoch) {
        return;
      } else if (message.type === 'weather') {
        this.applyWeather(message.weather);
      } else if (message.type === 'focus') {
        const started = this.now(); this.api.set_focus(message.x, message.z);
        this.focus = { x: message.x, z: message.z }; this.metrics.streamMs = this.now() - started;
      } else if (message.type === 'brush') {
        const fn = { ignite: 'ignite', water: 'extinguish', clear: 'firebreak' }[message.mode];
        if (fn) this.api[fn](message.x, message.z, message.radius);
      } else if (message.type !== 'snapshot') {
        return;
      }
      if (message.id) this.responses.push(message.id);
      this.dirty = true; this.publish(); this.wake();
    } catch (error) {
      this.post({ type: 'error', id: message.id, message: error.message || String(error) });
    }
  }
  applyWeather(weather = {}) {
    this.api.set_weather(weather.windSpeed ?? 14, weather.windAngle ?? -Math.PI / 4, weather.moisture ?? 0.18, weather.rain ?? 0);
  }
  startFire(scenario = 'clearing') {
    if (scenario === 'empty') return;
    this.api.ignite(-18, -16, scenario === 'spark' ? 4 : 12);
    if (scenario !== 'spark') this.api.ignite(-7, -22, 6);
    for (let i = 0; i < 4; i++) this.api.step(2);
  }
  wake() {
    if (!this.automatic) return;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = this.schedule(() => { this.timer = null; this.pump(); this.wake(); }, this.paused || !this.visible ? 100 : 10);
  }
  pump() {
    if (!this.api) return;
    const now = this.now();
    const elapsed = Math.max(0, Math.min(0.25, (now - this.lastPump) / 1000)); this.lastPump = now;
    if (!this.paused && this.visible) {
      const wanted = this.accumulator + elapsed * this.speed;
      this.metrics.droppedSeconds += Math.max(0, wanted - 1); this.accumulator = Math.min(1, wanted);
      const available = Math.floor((this.accumulator + 1e-7) / STEP);
      const budget = Math.max(1, Math.min(8, Math.floor(8 / Math.max(0.1, this.metrics.stepMs || 1))));
      const steps = Math.min(available, budget);
      if (steps) {
        const started = this.now(); this.api.step(steps * STEP);
        const duration = this.now() - started, perStep = duration / steps;
        this.metrics.stepMs = this.metrics.stepMs ? this.metrics.stepMs * 0.85 + perStep * 0.15 : perStep;
        this.accumulator = Math.max(0, this.accumulator - steps * STEP);
        this.rateWork += duration; this.rateSteps += steps; this.dirty = true;
      }
    }
    const rateElapsed = now - this.rateStart;
    if (rateElapsed >= 1000) {
      this.metrics.actualSpeed = this.rateSteps * STEP * 1000 / rateElapsed;
      this.metrics.workMs = this.rateWork * 1000 / rateElapsed;
      this.metrics.snapshotHz = this.rateSnapshots * 1000 / rateElapsed;
      this.rateStart = now; this.rateSteps = this.rateWork = this.rateSnapshots = 0;
    }
    if (this.dirty && now - this.lastSnapshot >= SNAPSHOT_MS) this.publish();
  }
  publish() {
    if (!this.api || this.outstanding >= MAX_OUTSTANDING || (!this.dirty && !this.responses.length)) return false;
    const started = this.now();
    const trees = this.api.tree_count(), smoke = this.api.smoke_count(), embers = this.api.embers_count();
    const floats = trees * 14 + (smoke + embers) * 8 + 8, required = floats * 4;
    const existing = this.pool.findIndex(b => b.byteLength >= required);
    const capacity = Math.max(65536, 2 ** Math.ceil(Math.log2(Math.max(1, required))));
    const buffer = existing >= 0 ? this.pool.splice(existing, 1)[0] : new ArrayBuffer(capacity);
    const target = new Float32Array(buffer, 0, floats); let offset = 0;
    for (const [pointer, length] of [[this.api.trees_ptr(), trees * 10], [this.api.fire_states_ptr(), trees * 4], [this.api.smoke_ptr(), smoke * 8], [this.api.embers_ptr(), embers * 8], [this.api.stats_ptr(), 8]]) {
      target.set(new Float32Array(this.api.memory.buffer, pointer, length), offset); offset += length;
    }
    this.outstanding++; this.sequence++; this.metrics.snapshots++; this.rateSnapshots++;
    this.rateWork += this.now() - started; this.lastSnapshot = this.now(); this.dirty = false;
    this.post({ type: 'snapshot', buffer, trees, smoke, embers, epoch: this.epoch, sequence: this.sequence,
      revision: this.api.world_revision(), focus: this.focus, seed: this.seed, responses: this.responses.splice(0),
      metrics: { ...this.metrics, backlogMs: this.accumulator * 1000, buffersInFlight: this.outstanding,
        activeCells: this.api.active_cell_count?.() ?? trees, smokeRecycled: this.api.smoke_recycled_count?.() ?? 0 } }, [buffer]);
    return true;
  }
  dispose() { if (this.timer !== null) this.cancel(this.timer); this.timer = null; this.api = null; this.pool.length = 0; }
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined') {
  const runner = new SimulationRunner((message, transfer) => self.postMessage(message, transfer || []));
  self.onmessage = event => runner.handle(event.data);
}
