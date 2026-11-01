//! A deterministic, streamed forest and parcel-based fire/smoke sandbox.
//! Normalized combustion states are tuned for interaction, not wildfire prediction.
use std::cell::RefCell;
use std::collections::HashMap;

const CELL: f32 = 6.0;
const CELLS_PER_CHUNK: i32 = 6;
const CHUNK: f32 = CELL * CELLS_PER_CHUNK as f32;
const RADIUS: i32 = 5;
const STRIDE: usize = 10;
const FIXED_DT: f32 = 0.05;
const MAX_SMOKE: usize = 2800;
const MAX_EMBERS: usize = 1000;

#[derive(Clone, Copy)]
struct BurnState {
    heat: f32, burn: f32, wet: f32, burning: bool, firebreak: bool, dirty: bool,
    surface_fuel: f32, crown_fuel: f32,
    surface_heat: f32, crown_heat: f32,
    surface_water: f32, crown_water: f32, ambient_moisture: f32,
    surface_active: bool, crown_active: bool,
    surface_time: f32, crown_time: f32,
    surface_dwell: f32, crown_dwell: f32,
    surface_flux: f32, crown_flux: f32, smolder: f32,
    smoke_credit: f32, ember_credit: f32,
}
impl BurnState {
    fn fresh(moisture: f32, variation: f32) -> Self {
        Self {
            heat: 0.0, burn: 0.0, wet: 0.0, burning: false, firebreak: false, dirty: false,
            surface_fuel: 1.0, crown_fuel: 1.0, surface_heat: 0.0, crown_heat: 0.0,
            surface_water: moisture * (0.85 + variation * 0.3),
            crown_water: 0.22 + moisture * 0.55, ambient_moisture: moisture,
            surface_active: false, crown_active: false, surface_time: 0.0, crown_time: 0.0,
            surface_dwell: 0.0, crown_dwell: 0.0, surface_flux: 0.0, crown_flux: 0.0,
            smolder: 0.0, smoke_credit: 0.0, ember_credit: 0.0,
        }
    }
    fn weather_change(&mut self, moisture: f32, variation: f32) {
        if !self.dirty {
            self.surface_water = moisture * (0.85 + variation * 0.3);
            self.crown_water = 0.22 + moisture * 0.55;
            self.ambient_moisture = moisture;
            return;
        }
        let delta = moisture - self.ambient_moisture;
        self.surface_water = (self.surface_water + delta * (0.85 + variation * 0.3)).clamp(0.0, 1.5);
        self.crown_water = (self.crown_water + delta * 0.55).clamp(0.0, 1.4);
        self.ambient_moisture = moisture;
    }
    fn summarize(&mut self) {
        if self.firebreak {
            self.heat = 0.0; self.burn = 1.0; self.burning = false;
            self.surface_flux = 0.0; self.crown_flux = 0.0; self.smolder = 0.0;
            return;
        }
        self.burning = self.surface_active || self.crown_active;
        self.burn = (1.0 - self.surface_fuel) * 0.18 + (1.0 - self.crown_fuel) * 0.82;
        self.heat = if self.burning {
            0.65 + 0.35 * (self.surface_flux * 0.42 + self.crown_flux * 0.88).min(1.0)
        } else {
            self.surface_heat.max(self.crown_heat * 0.8).max(self.smolder * 0.65).min(0.60)
        };
    }
}
#[derive(Clone, Copy)]
struct Neighbor {
    index: usize, dx: f32, dz: f32, distance: f32, attenuation: f32, slope: f32,
    surface_weight: f32, crown_weight: f32, advection_delay: f32,
}
struct Tree {
    key: (i32, i32), x: f32, y: f32, z: f32,
    height: f32, width: f32, variant: f32, seed: f32, base_moisture: f32,
    surface_load: f32, crown_load: f32,
    state: BurnState, neighbors: Vec<Neighbor>,
}
#[derive(Clone, Copy)]
struct Smoke {
    x: f32, y: f32, z: f32, vx: f32, vy: f32, vz: f32,
    size: f32, optical_mass: f32, temperature: f32, opacity: f32,
    age: f32, lifetime: f32, seed: f32,
    ground: f32, flow: [f32; 3],
}
#[derive(Clone, Copy)]
struct Ember {
    x: f32, y: f32, z: f32, vx: f32, vy: f32, vz: f32,
    heat: f32, size: f32, age: f32, lifetime: f32, seed: f32, lift: f32, ground: f32, flow: [f32; 3],
}
struct Simulation {
    seed: u32, rng: u32,
    trees: Vec<Tree>, packed: Vec<f32>, fire_packed: Vec<f32>,
    index: HashMap<(i32, i32), usize>, history: HashMap<(i32, i32), BurnState>,
    focus: (i32, i32), revision: u32,
    wind_speed: f32, wind_angle: f32, moisture: f32, rain: f32,
    time: f32, accumulator: f32, tick: u32,
    delta: Vec<f32>, crown_delta: Vec<f32>, stats: [f32; 8],
    active: Vec<usize>, active_flags: Vec<bool>, packed_dirty: Vec<usize>, packed_dirty_flags: Vec<bool>,
    burning_count: u32, burnt_count: u32, consumed_sum: f64,
    wind_lut: [f32; 401], opacity_lut: [f32; 129], smoke_recycle_cursor: usize,
    smoke_recycled: u32, smoke_cadence_scale: f32,
    smoke: Vec<Smoke>, embers: Vec<Ember>, smoke_packed: Vec<f32>, ember_packed: Vec<f32>,
    smoke_emitted: u32, ember_emitted: u32, ember_landings: u32, spot_ignitions: u32,
}
fn mix(mut x: u32) -> u32 {
    x ^= x >> 16; x = x.wrapping_mul(0x7feb352d); x ^= x >> 15;
    x = x.wrapping_mul(0x846ca68b); x ^ (x >> 16)
}
fn hash(x: i32, z: i32, seed: u32) -> u32 {
    mix((x as u32).wrapping_mul(0x9e3779b9) ^ (z as u32).wrapping_mul(0x85ebca6b) ^ seed)
}
fn unit(x: u32) -> f32 { (x >> 8) as f32 / 16777215.0 }
fn lerp(a: f32, b: f32, t: f32) -> f32 { a + (b - a) * t }
fn smooth(t: f32) -> f32 { t * t * (3.0 - 2.0 * t) }
fn smooth_range(a: f32, b: f32, x: f32) -> f32 { smooth(((x - a) / (b - a)).clamp(0.0, 1.0)) }
fn noise(x: f32, z: f32, seed: u32) -> f32 {
    let ix = x.floor() as i32; let iz = z.floor() as i32;
    let fx = smooth(x - ix as f32); let fz = smooth(z - iz as f32);
    lerp(lerp(unit(hash(ix, iz, seed)), unit(hash(ix.wrapping_add(1), iz, seed)), fx),
        lerp(unit(hash(ix, iz.wrapping_add(1), seed)), unit(hash(ix.wrapping_add(1), iz.wrapping_add(1), seed)), fx), fz)
}
fn terrain(x: f32, z: f32, seed: u32) -> f32 {
    noise(x / 155.0 + 7.2, z / 155.0 - 4.8, seed ^ 71) * 23.0
        + noise(x / 65.0, z / 65.0, seed ^ 137) * 8.5
        + noise(x / 23.0, z / 23.0, seed ^ 911) * 2.3
        + noise(x / 9.0, z / 9.0, seed ^ 31) * 0.45 - 13.0
}
fn hash3(x: i32, y: i32, z: i32, seed: u32) -> f32 {
    unit(mix((x as u32).wrapping_mul(0x9e3779b9)
        ^ (y as u32).wrapping_mul(0x68e31da4)
        ^ (z as u32).wrapping_mul(0xb5297a4d) ^ seed)) * 2.0 - 1.0
}
// Analytic spatial gradient of smooth 3-D value noise; no finite-difference sampling.
fn noise_gradient(x: f32, y: f32, z: f32, seed: u32) -> [f32; 3] {
    let ix = x.floor() as i32; let iy = y.floor() as i32; let iz = z.floor() as i32;
    let tx = x - ix as f32; let ty = y - iy as f32; let tz = z - iz as f32;
    let sx = smooth(tx); let sy = smooth(ty); let sz = smooth(tz);
    let dx = 6.0 * tx * (1.0 - tx); let dy = 6.0 * ty * (1.0 - ty); let dz = 6.0 * tz * (1.0 - tz);
    let a = hash3(ix, iy, iz, seed); let b = hash3(ix + 1, iy, iz, seed);
    let c = hash3(ix, iy + 1, iz, seed); let d = hash3(ix + 1, iy + 1, iz, seed);
    let e = hash3(ix, iy, iz + 1, seed); let f = hash3(ix + 1, iy, iz + 1, seed);
    let g = hash3(ix, iy + 1, iz + 1, seed); let h = hash3(ix + 1, iy + 1, iz + 1, seed);
    [lerp(lerp(b - a, d - c, sy), lerp(f - e, h - g, sy), sz) * dx,
     lerp(lerp(c - a, d - b, sx), lerp(g - e, h - f, sx), sz) * dy,
     (lerp(lerp(e, f, sx), lerp(g, h, sx), sy) - lerp(lerp(a, b, sx), lerp(c, d, sx), sy)) * dz]
}
// Curl of a vector potential creates coherent rotating eddies, rather than per-puff sine paths.
fn curl_flow(x: f32, y: f32, z: f32, time: f32, seed: u32) -> [f32; 3] {
    let qx = x * 0.075 + time * 0.027;
    let qy = y * 0.075 - time * 0.018;
    let qz = z * 0.075 + time * 0.019;
    let a = noise_gradient(qx, qy, qz, seed ^ 1181);
    let b = noise_gradient(qx + 19.3, qy - 4.7, qz + 2.5, seed ^ 3793);
    let c = noise_gradient(qx - 3.1, qy + 11.7, qz - 8.3, seed ^ 7919);
    [c[1] - b[2], a[2] - c[0], b[0] - a[1]]
}
// Incoming normalized energy pays a latent-moisture cost before raising temperature.
fn absorb_heat(heat: &mut f32, water: &mut f32, energy: f32) {
    let energy = energy.max(0.0);
    let latent = (energy * 0.82).min(*water * 1.8);
    *water = (*water - latent / 1.8).max(0.0);
    *heat = (*heat + energy - latent).clamp(0.0, 1.0);
}
fn wind_profile(height: f32) -> f32 {
    (0.32 + 0.68 * ((1.0 + height.max(0.0) / 1.5).ln() / (1.0_f32 + 12.0 / 1.5).ln())).clamp(0.28, 1.85)
}
fn wind_cached(height: f32, lut: &[f32; 401]) -> f32 {
    let q = (height.max(0.0) * 2.0).min(399.999);
    let i = q as usize;
    lerp(lut[i], lut[i + 1], q - i as f32)
}
// All rates passed here are small fixed-timestep values (<0.08). The reciprocal
// cubic differs from exp(-x) by less than 2e-6 over that range.
fn step_decay(x: f32) -> f32 { 1.0 / (1.0 + x * (1.0 + x * (0.5 + x / 6.0))) }
fn optical_alpha(depth: f32, lut: &[f32; 129]) -> f32 {
    let q = (depth.max(0.0) * 32.0).min(127.999);
    let i = q as usize;
    lerp(lut[i], lut[i + 1], q - i as f32)
}
fn smoke_rates(surface: f32, crown: f32, smolder: f32) -> (f32, f32) {
    (surface*2.35+crown*4.1+smolder*0.95, surface*5.0+crown*7.0+smolder*2.2)
}
fn smoke_parcel_weight(surface: f32, crown: f32, smolder: f32, cadence_scale: f32) -> f32 {
    let (reference, cadence) = smoke_rates(surface, crown, smolder);
    reference / (cadence * cadence_scale).max(0.001)
}
impl Simulation {
    fn new(seed: u32, revision: u32) -> Self {
        let mut s = Self {
            seed, rng: mix(seed ^ 0xa1b2c3d4).max(1),
            trees: Vec::with_capacity(4356), packed: Vec::with_capacity(43560), fire_packed: Vec::with_capacity(17424),
            index: HashMap::new(), history: HashMap::new(), focus: (i32::MIN, i32::MIN), revision,
            wind_speed: 18.0, wind_angle: -0.45, moisture: 0.2, rain: 0.0,
            time: 0.0, accumulator: 0.0, tick: 0, delta: Vec::new(), crown_delta: Vec::new(), stats: [0.0; 8],
            active: Vec::with_capacity(4356), active_flags: Vec::new(),
            packed_dirty: Vec::with_capacity(4356), packed_dirty_flags: Vec::new(),
            burning_count: 0, burnt_count: 0, consumed_sum: 0.0,
            wind_lut: std::array::from_fn(|i| wind_profile(i as f32 * 0.5)),
            opacity_lut: std::array::from_fn(|i| 1.0 - (-(i as f32) / 32.0).exp()),
            smoke_recycle_cursor: 0, smoke_recycled: 0, smoke_cadence_scale: 1.0,
            smoke: Vec::with_capacity(MAX_SMOKE), embers: Vec::with_capacity(MAX_EMBERS),
            smoke_packed: vec![0.0; MAX_SMOKE * 8], ember_packed: vec![0.0; MAX_EMBERS * 8],
            smoke_emitted: 0, ember_emitted: 0, ember_landings: 0, spot_ignitions: 0,
        };
        s.stream(0.0, 0.0); s
    }
    fn random(&mut self) -> f32 {
        let mut r = self.rng; r ^= r << 13; r ^= r >> 17; r ^= r << 5; self.rng = r; unit(r)
    }
    fn wake(&mut self, i: usize) {
        if !self.active_flags[i] { self.active_flags[i] = true; self.active.push(i); }
    }
    fn mark_packed(&mut self, i: usize) {
        if !self.packed_dirty_flags[i] { self.packed_dirty_flags[i] = true; self.packed_dirty.push(i); }
    }
    fn cache_transfer_weights(&mut self) {
        let wx = self.wind_angle.cos(); let wz = self.wind_angle.sin(); let wind = self.wind_speed / 3.6;
        for t in &mut self.trees { for n in &mut t.neighbors {
            let alignment = n.dx * wx + n.dz * wz;
            let directional = (wind * alignment * 0.20).exp().clamp(0.13, 4.2);
            let slope = (n.slope * 3.1).exp().clamp(0.40, 2.5);
            n.surface_weight = FIXED_DT * 0.13 * n.attenuation * directional * slope;
            n.crown_weight = FIXED_DT * 0.055 * n.attenuation * directional * slope;
            n.advection_delay = n.distance / (0.75 + wind * alignment.max(0.0) * 0.55);
        }}
    }
    fn stream(&mut self, x: f32, z: f32) {
        if !x.is_finite() || !z.is_finite() { return; }
        let focus = ((x / CHUNK).floor() as i32, (z / CHUNK).floor() as i32);
        if focus == self.focus { return; }
        for t in &self.trees {
            if t.state.dirty { self.history.insert(t.key, t.state); } else { self.history.remove(&t.key); }
        }
        self.trees.clear(); self.index.clear(); self.focus = focus;
        let side = (RADIUS * 2 + 1) * CELLS_PER_CHUNK;
        let min_x = (focus.0 - RADIUS) * CELLS_PER_CHUNK;
        let min_z = (focus.1 - RADIUS) * CELLS_PER_CHUNK;
        let mut dense = vec![usize::MAX; (side * side) as usize];
        for cz in (focus.1 - RADIUS)..=(focus.1 + RADIUS) {
            for cx in (focus.0 - RADIUS)..=(focus.0 + RADIUS) {
                for lz in 0..CELLS_PER_CHUNK { for lx in 0..CELLS_PER_CHUNK {
                    let gx = cx * CELLS_PER_CHUNK + lx; let gz = cz * CELLS_PER_CHUNK + lz;
                    let h = hash(gx, gz, self.seed); if unit(h) < 0.13 { continue; }
                    let tx = (gx as f32 + 0.5) * CELL + (unit(mix(h ^ 13)) - 0.5) * 3.6;
                    let tz = (gz as f32 + 0.5) * CELL + (unit(mix(h ^ 29)) - 0.5) * 3.6;
                    if tx * tx + tz * tz < 135.0 || noise(tx / 80.0, tz / 80.0, self.seed ^ 111) < 0.12 { continue; }
                    let base = unit(mix(h ^ 161));
                    let mut state = self.history.get(&(gx, gz)).copied().unwrap_or_else(|| BurnState::fresh(self.moisture, base));
                    state.weather_change(self.moisture, base);
                    let t = Tree { key: (gx, gz), x: tx, y: terrain(tx, tz, self.seed), z: tz,
                        height: 8.0 + unit(mix(h ^ 47)) * 8.0, width: 2.2 + unit(mix(h ^ 59)) * 1.65,
                        variant: (mix(h ^ 67) % 3) as f32, seed: unit(mix(h ^ 101)), base_moisture: base,
                        surface_load: 0.76 + unit(mix(h ^ 307)) * 0.53,
                        crown_load: 0.80 + unit(mix(h ^ 419)) * 0.42,
                        state, neighbors: Vec::with_capacity(16) };
                    dense[((gz - min_z) * side + gx - min_x) as usize] = self.trees.len();
                    self.index.insert((gx, gz), self.trees.len()); self.trees.push(t);
                }}
            }
        }
        for i in 0..self.trees.len() {
            let (gx, gz) = self.trees[i].key;
            let (x, y, z) = (self.trees[i].x, self.trees[i].y, self.trees[i].z);
            let mut near = Vec::with_capacity(16);
            for dz in -2..=2 { for dx in -2..=2 {
                if dx == 0 && dz == 0 { continue; }
                let local_x = gx + dx - min_x; let local_z = gz + dz - min_z;
                if local_x < 0 || local_x >= side || local_z < 0 || local_z >= side { continue; }
                let j = dense[(local_z * side + local_x) as usize];
                if j != usize::MAX {
                    let target = &self.trees[j]; let vx = target.x - x; let vz = target.z - z;
                    let d = (vx * vx + vz * vz).sqrt();
                    if d <= 12.4 { near.push(Neighbor { index: j, dx: vx / d, dz: vz / d, distance: d,
                        attenuation: (1.0 - d / 13.5).max(0.0).powi(2), slope: (target.y - y) / d,
                        surface_weight: 0.0, crown_weight: 0.0, advection_delay: 0.0 }); }
                }
            }}
            self.trees[i].neighbors = near;
        }
        self.delta.resize(self.trees.len(), 0.0); self.crown_delta.resize(self.trees.len(), 0.0);
        self.packed.resize(self.trees.len() * STRIDE, 0.0); self.fire_packed.resize(self.trees.len() * 4, 0.0);
        self.packed.fill(0.0); self.fire_packed.fill(0.0);
        self.active.clear(); self.active_flags = vec![false; self.trees.len()];
        self.packed_dirty.clear(); self.packed_dirty_flags = vec![false; self.trees.len()];
        self.burning_count = 0; self.burnt_count = 0; self.consumed_sum = 0.0;
        for i in 0..self.trees.len() {
            let t = &self.trees[i]; let p = i * STRIDE;
            self.packed[p] = t.x; self.packed[p+1] = t.y; self.packed[p+2] = t.z;
            self.packed[p+3] = t.height; self.packed[p+4] = t.width;
            self.packed[p+5] = t.variant; self.packed[p+9] = t.seed;
            let s = t.state;
            if !s.firebreak && (self.rain > 0.0 || s.burning || s.surface_heat > 0.0 || s.crown_heat > 0.0 || s.wet > 0.0 || s.smolder > 0.0) { self.wake(i); }
            self.mark_packed(i);
        }
        self.cache_transfer_weights();
        // Existing parcels retain world positions; retire only parcels far outside the loaded neighborhood.
        self.smoke.retain(|p| (p.x-x).abs() < 440.0 && (p.z-z).abs() < 440.0);
        self.embers.retain(|p| (p.x-x).abs() < 440.0 && (p.z-z).abs() < 440.0);
        self.revision = self.revision.wrapping_add(1); self.publish();
    }
    fn weather(&mut self, speed: f32, angle: f32, moisture: f32, rain: f32) {
        let previous_wind = (self.wind_speed, self.wind_angle);
        if speed.is_finite() { self.wind_speed = speed.clamp(0.0, 100.0); }
        if angle.is_finite() { self.wind_angle = angle; }
        if moisture.is_finite() {
            self.moisture = moisture.clamp(0.0, 1.0);
            for t in &mut self.trees { t.state.weather_change(self.moisture, t.base_moisture); }
        }
        if rain.is_finite() { self.rain = rain.clamp(0.0, 1.0); }
        if previous_wind != (self.wind_speed, self.wind_angle) { self.cache_transfer_weights(); }
        for i in 0..self.trees.len() {
            self.mark_packed(i);
            if self.rain > 0.0 && !self.trees[i].state.firebreak { self.wake(i); }
        }
        self.publish();
    }
    fn brush(&mut self, x: f32, z: f32, radius: f32, mode: u8) {
        if !x.is_finite() || !z.is_finite() || !radius.is_finite() { return; }
        let r2 = radius.clamp(0.1, 500.0).powi(2);
        for i in 0..self.trees.len() {
            let t = &mut self.trees[i];
            if (t.x-x).powi(2)+(t.z-z).powi(2)>r2 { continue; }
            let s = &mut t.state;
            match mode {
                0 if !s.firebreak && s.surface_fuel > 0.06 => {
                    // A deliberate ignition adds enough energy to light the surface, not instantly the crown.
                    if !s.surface_active { s.surface_time = 0.0; }
                    s.surface_active = true; s.surface_heat = 0.94; s.surface_water = s.surface_water.min(0.10);
                    s.surface_flux = 0.65; s.wet *= 0.12; s.dirty = true;
                },
                1 => {
                    s.surface_active = false; s.crown_active = false;
                    s.surface_heat = 0.0; s.crown_heat = 0.0; s.surface_flux = 0.0; s.crown_flux = 0.0; s.smolder = 0.0;
                    s.surface_dwell = 0.0; s.crown_dwell = 0.0; s.wet = 1.0;
                    s.surface_water = (s.surface_water + 0.95).min(1.5); s.crown_water = (s.crown_water + 0.50).min(1.4);
                    s.smoke_credit = 0.0; s.ember_credit = 0.0; s.dirty = true;
                },
                2 => {
                    s.firebreak = true; s.surface_fuel = 0.0; s.crown_fuel = 0.0;
                    s.surface_active = false; s.crown_active = false; s.surface_heat = 0.0; s.crown_heat = 0.0;
                    s.smoke_credit = 0.0; s.ember_credit = 0.0; s.dirty = true;
                }, _ => (),
            }
            s.summarize();
            self.wake(i); self.mark_packed(i);
        }
        self.publish();
    }
    fn advance(&mut self, dt: f32) {
        if !dt.is_finite() || dt <= 0.0 { return; }
        self.accumulator += dt.min(2.0);
        while self.accumulator + 0.000001 >= FIXED_DT { self.fixed_tick(); self.accumulator -= FIXED_DT; }
        self.publish();
    }
    fn fixed_tick(&mut self) {
        self.time += FIXED_DT; self.tick = self.tick.wrapping_add(1);
        if self.active.is_empty() && self.smoke.is_empty() && self.embers.is_empty() { return; }
        self.delta.fill(0.0); self.crown_delta.fill(0.0);
        let wx = self.wind_angle.cos(); let wz = self.wind_angle.sin(); let wind = self.wind_speed / 3.6;
        // Energy transfer has source-development and distance/advection delays.
        let source_count = self.active.len();
        for source_slot in 0..source_count {
            let t = &self.trees[self.active[source_slot]];
            if !t.state.burning { continue; }
            for n in &t.neighbors {
                let target = &self.trees[n.index]; if target.state.firebreak { continue; }
                let delay = n.advection_delay;
                let surface_developed = ((t.state.surface_time - delay) / 4.5).clamp(0.0, 1.0);
                let crown_developed = ((t.state.crown_time - delay * 0.5) / 3.5).clamp(0.0, 1.0);
                let release = t.state.surface_flux * surface_developed + t.state.crown_flux * crown_developed * 2.0;
                self.delta[n.index] += n.surface_weight * release;
                self.crown_delta[n.index] += n.crown_weight * t.state.crown_flux * crown_developed;
                if release > 0.0 && !self.active_flags[n.index] {
                    self.active_flags[n.index] = true; self.active.push(n.index);
                }
            }
        }
        let requested_smoke: f32 = self.active.iter().map(|i| {
            let s=&self.trees[*i].state; smoke_rates(s.surface_flux,s.crown_flux,s.smolder).1
        }).sum::<f32>() * (1.0-self.rain*0.65);
        // Dense fires share the finite parcel budget; sparse sources retain a high
        // cadence so buoyant acceleration cannot pull their supports into dots.
        self.smoke_cadence_scale=(400.0/requested_smoke.max(400.0)).min(1.0);
        for active_slot in 0..self.active.len() {
            let i = self.active[active_slot]; let t = &mut self.trees[i];
            let s = &mut t.state;
            if s.firebreak { continue; }
            if self.rain > 0.0 {
                s.surface_water = (s.surface_water + FIXED_DT*self.rain*0.020).min(1.5);
                s.crown_water = (s.crown_water + FIXED_DT*self.rain*0.010).min(1.4);
                s.wet = (s.wet + FIXED_DT*self.rain*0.055).min(1.0); s.dirty = true;
            } else { s.wet = (s.wet - FIXED_DT*0.0025).max(0.0); }
            if self.delta[i] > 0.0 || self.crown_delta[i] > 0.0 { s.dirty = true; }
            let surface_cooling = FIXED_DT*(0.0045 + s.surface_water*0.004 + self.rain*0.25 + s.wet*0.12);
            let crown_cooling = FIXED_DT*(0.003 + self.rain*0.18 + s.wet*0.07);
            let old_surface_flux = s.surface_flux;
            if s.surface_active {
                s.surface_time += FIXED_DT;
                let fuel_taper = (s.surface_fuel/0.18).clamp(0.0,1.0);
                let available = (1.0-s.surface_water/0.95).clamp(0.0,1.0);
                let reaction = 0.0065*(1.0+wind*0.045)*s.surface_heat*fuel_taper*available/t.surface_load;
                let consumed = (FIXED_DT*reaction).min(s.surface_fuel); s.surface_fuel -= consumed;
                s.surface_flux = (reaction*t.surface_load/0.0085).clamp(0.0,1.0);
                absorb_heat(&mut s.surface_heat,&mut s.surface_water,self.delta[i]+consumed*31.0*t.surface_load);
                s.surface_heat=(s.surface_heat-surface_cooling-FIXED_DT*0.016).max(0.0);
                if s.surface_heat<0.32 || s.surface_fuel<0.055 {
                    s.surface_active=false; s.surface_flux=0.0;
                    s.smolder=s.smolder.max(s.surface_heat*0.72);
                }
            } else {
                s.surface_flux=0.0;
                absorb_heat(&mut s.surface_heat,&mut s.surface_water,self.delta[i]);
                s.surface_heat=(s.surface_heat-surface_cooling).max(0.0);
                if s.surface_heat>0.50 && s.surface_water<0.32 && s.surface_fuel>0.07 && s.wet<0.65 {
                    s.surface_dwell += FIXED_DT;
                    if s.surface_dwell>=1.8 {
                        s.surface_active=true; s.surface_time=0.0; s.surface_heat=s.surface_heat.max(0.72); s.surface_flux=0.35;
                    }
                } else { s.surface_dwell=(s.surface_dwell-FIXED_DT*1.5).max(0.0); }
            }
            // Surface flame heats canopy gradually; shorter ladder distance makes smaller trees easier to torch.
            let ladder = (1.20-t.height/35.0).clamp(0.55,1.0);
            let crown_input = self.crown_delta[i]+FIXED_DT*old_surface_flux*0.044*ladder;
            if s.crown_active {
                s.crown_time += FIXED_DT;
                let available=(1.0-s.crown_water/1.05).clamp(0.0,1.0);
                let reaction=0.0060*(1.0+wind*0.035)*s.crown_heat*(s.crown_fuel/0.14).clamp(0.0,1.0)*available/t.crown_load;
                let consumed=(FIXED_DT*reaction).min(s.crown_fuel); s.crown_fuel-=consumed;
                s.crown_flux=(reaction*t.crown_load/0.0070).clamp(0.0,1.0);
                absorb_heat(&mut s.crown_heat,&mut s.crown_water,crown_input+consumed*38.0*t.crown_load);
                s.crown_heat=(s.crown_heat-crown_cooling-FIXED_DT*0.018).max(0.0);
                if s.crown_heat<0.34 || s.crown_fuel<0.035 {
                    s.crown_active=false; s.crown_flux=0.0; s.smolder=s.smolder.max(s.crown_heat*0.75);
                }
            } else {
                s.crown_flux=0.0;
                absorb_heat(&mut s.crown_heat,&mut s.crown_water,crown_input);
                s.crown_heat=(s.crown_heat-crown_cooling).max(0.0);
                if s.crown_heat>0.60 && s.crown_water<0.30 && s.crown_fuel>0.05 && s.wet<0.60 {
                    s.crown_dwell+=FIXED_DT;
                    if s.crown_dwell>=3.5 { s.crown_active=true; s.crown_time=0.0; s.crown_heat=0.82; s.crown_flux=0.5; }
                } else { s.crown_dwell=(s.crown_dwell-FIXED_DT).max(0.0); }
            }
            if s.smolder>0.0 {
                let decay=0.006+self.rain*0.45+s.wet*0.20;
                s.smolder *= step_decay(FIXED_DT*decay);
                let consumed=FIXED_DT*0.0009*s.smolder;
                if !s.surface_active { s.surface_fuel=(s.surface_fuel-consumed/t.surface_load).max(0.0); }
                if !s.crown_active && s.crown_fuel<0.05 { s.crown_fuel=(s.crown_fuel-consumed*0.7/t.crown_load).max(0.0); }
                if s.smolder<0.012 { s.smolder=0.0; }
            }
            s.summarize();
            let smoke_rate=smoke_rates(s.surface_flux,s.crown_flux,s.smolder).1*self.smoke_cadence_scale*(1.0-self.rain*0.65);
            let ember_rate=(s.surface_flux*0.12+s.crown_flux*0.90)*(0.5+wind*0.11)*(1.0-self.rain*0.90);
            s.smoke_credit=(s.smoke_credit+FIXED_DT*smoke_rate).min(2.0);
            s.ember_credit=(s.ember_credit+FIXED_DT*ember_rate).min(2.0);
            self.mark_packed(i);
        }
        self.emit_particles(wx,wz,wind);
        self.advance_particles(wx,wz,wind);
        let mut slot = 0;
        while slot < self.active.len() {
            let i = self.active[slot]; let s = self.trees[i].state;
            let awake = !s.firebreak && (self.rain > 0.0 || s.burning || s.surface_heat > 0.0 || s.crown_heat > 0.0 || s.wet > 0.0 || s.smolder > 0.0);
            if awake { slot += 1; } else { self.active_flags[i] = false; self.active.swap_remove(slot); }
        }
    }
    fn emit_particles(&mut self, wx:f32,wz:f32,wind:f32) {
        let count=self.active.len(); if count==0 { return; }
        // Rotate source order to avoid permanent low-index bias when a bounded particle pool is full.
        let offset=(self.tick as usize*37)%count;
        for k in 0..count {
            let i=self.active[(k+offset)%count];
            let s=self.trees[i].state;
            if s.smoke_credit>=1.0 {
                self.trees[i].state.smoke_credit-=1.0;
                if let Some(slot) = self.smoke_slot() {
                    let crown=s.crown_flux; let surface=s.surface_flux;
                    let a=self.random()*std::f32::consts::TAU; let jitter=self.random();
                    let rnd=self.random(); let rnd2=self.random();
                    let t=&self.trees[i];
                    let source_y=if crown>0.1 { t.y+t.height*(0.40+0.35*jitter) } else { t.y+0.7+surface*1.5 };
                    let diameter=1.4+crown*1.15+rnd*0.8;
                    let release=(surface*0.38+crown*0.85).clamp(0.0,1.0);
                    let temperature=if release>0.02 { 105.0+release*185.0 } else { 40.0+s.smolder*40.0 };
                    let parcel = Smoke {
                        x:t.x+a.cos()*t.width*0.23, y:source_y,z:t.z+a.sin()*t.width*0.23,
                        vx:wx*wind*0.35,vy:1.0+release*2.7,vz:wz*wind*0.35,
                        size:diameter,optical_mass:diameter*diameter*(0.78+crown*0.50+s.smolder*0.35)
                            *smoke_parcel_weight(surface,crown,s.smolder,self.smoke_cadence_scale),
                        temperature,opacity:0.0,age:0.0,lifetime:48.0+rnd2*32.0,seed:rnd,
                        ground:t.y,flow:[0.0;3],
                    };
                    if slot == self.smoke.len() { self.smoke.push(parcel); }
                    else { self.smoke[slot] = parcel; self.smoke_recycled = self.smoke_recycled.wrapping_add(1); }
                    self.smoke_emitted=self.smoke_emitted.wrapping_add(1);
                }
            }
            if s.ember_credit>=1.0 {
                self.trees[i].state.ember_credit-=1.0;
                if self.embers.len()<MAX_EMBERS {
                    let rnd=self.random();let a=self.random()*std::f32::consts::TAU;let rnd2=self.random();
                    let t=&self.trees[i];let crown=s.crown_flux;
                    let y=t.y+if crown>0.1 {t.height*(0.55+rnd*0.35)}else{0.8+s.surface_flux*1.1};
                    self.embers.push(Ember{x:t.x+a.cos()*0.5,y,z:t.z+a.sin()*0.5,
                        vx:wx*wind*0.45+a.cos(),vy:3.0+4.0*rnd+crown*2.0,vz:wz*wind*0.45+a.sin(),
                        heat:0.90+0.10*rnd2,size:0.035+rnd*0.075,age:0.0,lifetime:65.0+rnd2*35.0,seed:rnd2,
                        lift:5.5+s.surface_flux*2.5+crown*4.5,ground:t.y,flow:[0.0;3]});
                    self.ember_emitted=self.ember_emitted.wrapping_add(1);
                }
            }
        }
    }
    fn smoke_slot(&mut self) -> Option<usize> {
        if self.smoke.len() < MAX_SMOKE { return Some(self.smoke.len()); }
        let fx = (self.focus.0 as f32 + 0.5) * CHUNK;
        let fz = (self.focus.1 as f32 + 0.5) * CHUNK;
        let mut best = None; let mut lowest = f32::INFINITY;
        // Bounded fair sampling admits fresh plume parcels without an O(pool) scan.
        for _ in 0..24 {
            let index = self.smoke_recycle_cursor % self.smoke.len();
            self.smoke_recycle_cursor = self.smoke_recycle_cursor.wrapping_add(1);
            let p = &self.smoke[index];
            if p.age < 6.0 || p.opacity > 0.20 { continue; }
            let distance2 = (p.x-fx).powi(2) + (p.z-fz).powi(2);
            let contribution = p.opacity / (1.0 + distance2*0.00010 + p.age*0.025);
            if contribution < lowest { lowest = contribution; best = Some(index); }
        }
        best
    }
    fn advance_particles(&mut self,wx:f32,wz:f32,wind:f32) {
        let mut i=0;
        while i<self.smoke.len() {
            let p=&mut self.smoke[i];p.age+=FIXED_DT;
            let phase = (p.seed*251.0) as u32;
            if p.y-p.ground < 4.0 || (self.tick+phase)%16 == 0 { p.ground=terrain(p.x,p.z,self.seed); }
            let ground=p.ground;let altitude=(p.y-ground).max(0.0);
            if p.age <= FIXED_DT || (self.tick+phase)%4 == 0 { p.flow=curl_flow(p.x,p.y,p.z,self.time,self.seed); }
            let flow=p.flow;
            let air=wind*wind_cached(altitude,&self.wind_lut);
            let warm=(p.temperature/300.0).clamp(0.0,1.0);
            let buoyancy=9.81*p.temperature/(293.0+p.temperature)-0.16*(1.0-warm);
            let eddy=0.80+warm*0.90+wind*0.07;
            p.vx+=FIXED_DT*((wx*air-p.vx)*0.72+flow[0]*eddy);
            p.vz+=FIXED_DT*((wz*air-p.vz)*0.72+flow[2]*eddy);
            p.vy+=FIXED_DT*(buoyancy-p.vy*0.27+flow[1]*eddy*0.80);
            p.x+=p.vx*FIXED_DT;p.y+=p.vy*FIXED_DT;p.z+=p.vz*FIXED_DT;
            let relative=((wx*air-p.vx).powi(2)+(wz*air-p.vz).powi(2)+p.vy*p.vy).sqrt();
            let expansion=0.10+relative*0.028+(flow[0].abs()+flow[2].abs())*0.025;
            p.size+=FIXED_DT*expansion;
            // Expansion entrains ambient air, cooling the parcel and reducing projected optical depth.
            let cooling=0.026+relative*0.0035+expansion/(p.size.max(0.5))*0.8+self.rain*0.22;
            p.temperature*=step_decay(FIXED_DT*cooling);
            p.optical_mass*=step_decay(FIXED_DT*(0.006+self.rain*0.16));
            let fade_in=smooth_range(0.0,0.6,p.age);
            let fade_out=1.0-smooth_range(p.lifetime*0.65,p.lifetime,p.age);
            p.opacity=optical_alpha(p.optical_mass/(p.size*p.size),&self.opacity_lut)*fade_in*fade_out;
            if p.y<ground+0.15 {p.y=ground+0.15;p.vy=p.vy.max(0.0);}
            if p.age>=p.lifetime || p.opacity<0.003 && p.age>4.0 || altitude>190.0 {
                self.smoke.swap_remove(i);
            }else{i+=1;}
        }
        let mut i=0;
        while i<self.embers.len() {
            let mut p=self.embers[i];p.age+=FIXED_DT;
            let altitude=(p.y-p.ground).max(0.0);
            let phase=(p.seed*251.0) as u32;
            if p.age <= FIXED_DT || (self.tick+phase)%3==0 { p.flow=curl_flow(p.x,p.y,p.z,self.time,self.seed^193); }
            let flow=p.flow;
            let air=wind*wind_cached(altitude,&self.wind_lut);
            p.lift*=step_decay(FIXED_DT/6.2);let updraft=p.lift;
            p.vx+=FIXED_DT*((wx*air-p.vx)*1.05+flow[0]*0.4);
            p.vz+=FIXED_DT*((wz*air-p.vz)*1.05+flow[2]*0.4);
            let drag=4.2+(0.11-p.size)*12.0;
            p.vy+=FIXED_DT*((updraft-p.vy)*drag-9.81+flow[1]*0.35);
            p.x+=p.vx*FIXED_DT;p.y+=p.vy*FIXED_DT;p.z+=p.vz*FIXED_DT;
            p.heat*=step_decay(FIXED_DT*(0.019+(0.11-p.size)*0.08+wind*0.0015+self.rain*0.65));
            let landing_ground=terrain(p.x,p.z,self.seed);
            p.ground=landing_ground;
            if p.y<=landing_ground+0.12 {
                self.ember_landings=self.ember_landings.wrapping_add(1);
                if p.heat>0.28 && self.rain<0.55 {
                    let key=((p.x/CELL).floor() as i32,(p.z/CELL).floor() as i32);
                    if let Some(&j)=self.index.get(&key) {
                        let target=self.trees[j].state;
                        let probability=((p.heat-0.2)*1.1*(1.0-target.surface_water/0.6).clamp(0.0,1.0)
                            *target.surface_fuel*(1.0-self.rain)).clamp(0.0,0.85);
                        if !target.firebreak && !target.surface_active && target.surface_fuel>0.08 && self.random()<probability {
                            let s=&mut self.trees[j].state;
                            s.surface_heat=s.surface_heat.max(0.56+p.heat*0.16);s.surface_dwell=0.7;s.dirty=true;
                            // Landing deposits finite heat; normal dwell/moisture rules still decide ignition.
                            s.surface_water=(s.surface_water-p.heat*0.018).max(0.0);
                            s.summarize();
                            self.wake(j);self.mark_packed(j);
                            self.spot_ignitions=self.spot_ignitions.wrapping_add(1);
                        }
                    }
                }
                self.embers.swap_remove(i);
            }else if p.age>=p.lifetime||p.heat<0.10 {self.embers.swap_remove(i);}
            else{self.embers[i]=p;i+=1;}
        }
    }
    fn publish(&mut self) {
        for slot in 0..self.packed_dirty.len() {
            let i=self.packed_dirty[slot];let t=&self.trees[i];let p=i*STRIDE;let s=&t.state;
            let was_burning=self.packed[p+6]>=0.65;
            let was_cut=self.packed[p+5]<0.0;
            let was_burnt=self.packed[p+7]>=0.98&&!was_cut;
            let old_consumed=if was_cut{0.0}else{self.packed[p+7] as f64};
            self.burning_count=self.burning_count+s.burning as u32-was_burning as u32;
            self.burnt_count=self.burnt_count+(s.burn>=0.98&&!s.firebreak) as u32-was_burnt as u32;
            self.consumed_sum+=if s.firebreak{0.0}else{s.burn as f64}-old_consumed;
            self.packed[p+5]=if s.firebreak{-1.0}else{t.variant};
            self.packed[p+6]=s.heat;self.packed[p+7]=s.burn;self.packed[p+8]=s.surface_water.clamp(0.0,1.0);self.packed[p+9]=t.seed;
            self.fire_packed[i*4]=s.surface_flux;self.fire_packed[i*4+1]=s.crown_flux;
            self.fire_packed[i*4+2]=s.smolder;self.fire_packed[i*4+3]=(s.surface_flux*0.18+s.crown_flux*0.82+s.smolder*0.04).min(1.0);
            self.packed_dirty_flags[i]=false;
        }
        self.packed_dirty.clear();
        self.stats=[self.time,self.burning_count as f32,self.burnt_count as f32,self.trees.len() as f32,
            (self.consumed_sum.max(0.0)*CELL as f64*CELL as f64/10000.0) as f32,self.wind_speed,self.moisture*100.0,121.0];
        for(i,p)in self.smoke.iter().enumerate(){let k=i*8;
            self.smoke_packed[k..k+8].copy_from_slice(&[p.x,p.y,p.z,p.size,p.opacity,(p.temperature/300.0).clamp(0.0,1.0),(p.age/p.lifetime).clamp(0.0,1.0),p.seed]);
        }
        for(i,p)in self.embers.iter().enumerate(){let k=i*8;
            self.ember_packed[k..k+8].copy_from_slice(&[p.x,p.y,p.z,p.heat,p.size,(p.age/p.lifetime).clamp(0.0,1.0),p.seed,0.0]);
        }
    }
}

thread_local! { static SIM: RefCell<Option<Simulation>> = const { RefCell::new(None) }; }
fn read_sim<T>(fallback:T,f:impl FnOnce(&Simulation)->T)->T{SIM.with(|cell|cell.borrow().as_ref().map(f).unwrap_or(fallback))}
fn change_sim(f:impl FnOnce(&mut Simulation)){SIM.with(|cell|{if let Some(s)=cell.borrow_mut().as_mut(){f(s);}});}
#[no_mangle]pub extern "C" fn init(seed:u32){reset(seed);}
#[no_mangle]pub extern "C" fn reset(seed:u32){SIM.with(|cell|{let mut slot=cell.borrow_mut();let rev=slot.as_ref().map(|s|s.revision.wrapping_add(1)).unwrap_or(0);*slot=Some(Simulation::new(seed,rev));});}
#[no_mangle]pub extern "C" fn set_focus(x:f32,z:f32){change_sim(|s|s.stream(x,z));}
#[no_mangle]pub extern "C" fn tree_count()->u32{read_sim(0,|s|s.trees.len() as u32)}
#[no_mangle]pub extern "C" fn trees_ptr()->u32{read_sim(0,|s|s.packed.as_ptr() as usize as u32)}
#[no_mangle]pub extern "C" fn fire_states_ptr()->u32{read_sim(0,|s|s.fire_packed.as_ptr() as usize as u32)}
#[no_mangle]pub extern "C" fn smoke_ptr()->u32{read_sim(0,|s|s.smoke_packed.as_ptr() as usize as u32)}
#[no_mangle]pub extern "C" fn smoke_count()->u32{read_sim(0,|s|s.smoke.len() as u32)}
#[no_mangle]pub extern "C" fn embers_ptr()->u32{read_sim(0,|s|s.ember_packed.as_ptr() as usize as u32)}
#[no_mangle]pub extern "C" fn embers_count()->u32{read_sim(0,|s|s.embers.len() as u32)}
#[no_mangle]pub extern "C" fn stats_ptr()->u32{read_sim(0,|s|s.stats.as_ptr() as usize as u32)}
#[no_mangle]pub extern "C" fn world_revision()->u32{read_sim(0,|s|s.revision)}
#[no_mangle]pub extern "C" fn get_height(x:f32,z:f32)->f32{terrain(x,z,read_sim(1,|s|s.seed))}
#[no_mangle]pub extern "C" fn get_height_seeded(x:f32,z:f32,seed:u32)->f32{terrain(x,z,seed)}
#[no_mangle]pub extern "C" fn active_cell_count()->u32{read_sim(0,|s|s.active.len() as u32)}
#[no_mangle]pub extern "C" fn smoke_recycled_count()->u32{read_sim(0,|s|s.smoke_recycled)}
#[no_mangle]pub extern "C" fn step(dt:f32){change_sim(|s|s.advance(dt));}
#[no_mangle]pub extern "C" fn set_weather(speed:f32,angle:f32,moisture:f32,rain:f32){change_sim(|s|s.weather(speed,angle,moisture,rain));}
#[no_mangle]pub extern "C" fn ignite(x:f32,z:f32,radius:f32){change_sim(|s|s.brush(x,z,radius,0));}
#[no_mangle]pub extern "C" fn extinguish(x:f32,z:f32,radius:f32){change_sim(|s|s.brush(x,z,radius,1));}
#[no_mangle]pub extern "C" fn firebreak(x:f32,z:f32,radius:f32){change_sim(|s|s.brush(x,z,radius,2));}

#[cfg(test)]
mod tests {
    use super::*;
    fn advance(s:&mut Simulation,seconds:f32){for _ in 0..(seconds*10.0) as usize{s.advance(0.1);}}
    #[test]
    fn idle_forest_sleeps_without_changing_state() {
        let mut s=Simulation::new(2049,0);let before=s.packed.clone();
        advance(&mut s,120.0);
        assert!(s.active.is_empty());assert_eq!(s.packed,before);assert_eq!(s.stats[1],0.0);
        assert!(s.time>119.0);
        s.brush(25.0,25.0,9.0,0);assert!(!s.active.is_empty());
        advance(&mut s,1.0);assert!(s.stats[1]>0.0);
    }
    #[test]
    fn cached_math_stays_close_to_reference() {
        let s=Simulation::new(2049,0);
        for i in 0..2000 {
            let h=i as f32/10.0;
            assert!((wind_cached(h,&s.wind_lut)-wind_profile(h)).abs()<0.004);
            let depth=i as f32/500.0;
            assert!((optical_alpha(depth,&s.opacity_lut)-(1.0-(-depth).exp())).abs()<0.00014);
            let x=i as f32/25000.0;
            assert!((step_decay(x)-(-x).exp()).abs()<0.000002);
        }
    }
    #[test]
    fn compact_snapshots_and_counters_match_the_world() {
        let mut s=Simulation::new(2049,0);s.weather(24.0,-0.5,0.18,0.0);
        s.brush(-18.0,-16.0,12.0,0);advance(&mut s,45.0);
        s.brush(-12.0,-18.0,7.0,1);s.brush(-28.0,-10.0,6.0,2);
        advance(&mut s,10.0);
        let burning=s.trees.iter().filter(|t|t.state.burning).count();
        let burnt=s.trees.iter().filter(|t|!t.state.firebreak&&t.state.burn>=0.98).count();
        let consumed:f64=s.trees.iter().filter(|t|!t.state.firebreak).map(|t|t.state.burn as f64).sum();
        assert_eq!(s.stats[1],burning as f32);assert_eq!(s.stats[2],burnt as f32);
        assert!((s.stats[4] as f64-consumed*36.0/10000.0).abs()<0.000001);
        for(i,t)in s.trees.iter().enumerate(){assert_eq!(s.packed[i*10+6],t.state.heat);assert_eq!(s.packed[i*10+7],t.state.burn);}
        assert_eq!(s.active_flags.iter().filter(|v|**v).count(),s.active.len());
    }
    #[test]
    fn smoke_budget_keeps_admitting_fresh_plume() {
        let mut s=Simulation::new(428,0);
        for i in 0..MAX_SMOKE {s.smoke.push(Smoke{x:300.0,y:55.0,z:0.0,vx:0.0,vy:0.0,vz:0.0,
            size:8.0,optical_mass:10.0,temperature:45.0,opacity:0.14,age:20.0,lifetime:80.0,
            seed:i as f32/MAX_SMOKE as f32,ground:0.0,flow:[0.0;3]});}
        s.brush(25.0,25.0,12.0,0);advance(&mut s,4.0);
        assert!(s.smoke_recycled>0,"old parcels starved fresh emissions");
        assert!(s.smoke.iter().any(|p|p.age<4.0&&p.x<100.0));assert!(s.smoke.len()<=MAX_SMOKE);
    }
    #[test]
    fn smoke_cadence_preserves_optical_mass_flux() {
        for (surface,crown,smolder) in [(0.8,0.0,0.0),(0.4,0.7,0.1),(0.0,0.0,0.4)] {
            for scale in [1.0,0.4,0.1] {
                let (reference,cadence)=smoke_rates(surface,crown,smolder);
                let represented=cadence*scale*smoke_parcel_weight(surface,crown,smolder,scale);
                assert!((represented-reference).abs()<0.00001);
            }
        }
    }
    #[test]
    fn early_plume_parcels_overlap_as_they_accelerate() {
        let mut s=Simulation::new(2049,0);s.weather(14.0,-std::f32::consts::FRAC_PI_4,0.18,0.0);
        s.brush(-18.0,-16.0,12.0,0);s.brush(-7.0,-22.0,6.0,0);advance(&mut s,12.0);
        let mut spacing=Vec::with_capacity(s.smoke.len());
        for (i,a) in s.smoke.iter().enumerate() {
            let mut closest=f32::INFINITY;
            for (j,b) in s.smoke.iter().enumerate() { if i==j {continue;}
                let distance=((a.x-b.x).powi(2)+(a.y-b.y).powi(2)+(a.z-b.z).powi(2)).sqrt();
                closest=closest.min(distance/((a.size+b.size)*0.5));
            }
            spacing.push(closest);
        }
        spacing.sort_by(|a,b|a.partial_cmp(b).unwrap());
        assert!(spacing[spacing.len()/2]<0.65,"plume parcel supports remain separated");
        let isolated=spacing.iter().filter(|d|**d>1.0).count() as f32/spacing.len() as f32;
        assert!(isolated<0.20,"too many isolated puffs: {isolated}");
    }
    #[test]
    fn wet_fuel_survives_streaming_and_resists_neighbor_fire() {
        let mut s=Simulation::new(428,0);s.weather(36.0,std::f32::consts::PI,0.05,0.0);
        s.brush(25.0,25.0,12.0,1);
        let wet:Vec<_>=s.trees.iter().filter(|t|t.state.wet>0.9).map(|t|t.key).collect();
        s.stream(1000.0,1000.0);s.stream(0.0,0.0);
        assert!(wet.iter().all(|key|s.trees[*s.index.get(key).unwrap()].state.wet==1.0));
        s.brush(50.0,25.0,9.0,0);advance(&mut s,45.0);
        assert!(wet.iter().all(|key|!s.trees[*s.index.get(key).unwrap()].state.burning));
    }
    #[test]
    fn reversing_wind_rebuilds_directional_transfer() {
        let mut s=Simulation::new(428,0);s.weather(42.0,0.0,0.08,0.0);
        s.weather(42.0,std::f32::consts::PI,0.08,0.0);s.brush(-50.0,-50.0,8.0,0);
        advance(&mut s,35.0);let(mut east,mut west)=(0.0,0.0);
        for t in &s.trees {if(t.z+50.0).abs()<25.0 {if t.x> -40.0&&t.x< -10.0{east+=t.state.heat;}if t.x< -60.0&&t.x> -90.0{west+=t.state.heat;}}}
        assert!(west>east,"wind cache stale: east {east}, west {west}");
    }
    #[test]fn seeded_world_is_deterministic(){let a=Simulation::new(428,0);let b=Simulation::new(428,0);assert_eq!(a.packed,b.packed);assert!(a.trees.len()>2500&&a.trees.len()<5000);assert_ne!(terrain(71.0,93.0,428),terrain(71.0,93.0,429));}
    #[test]fn surface_fire_precedes_crown_and_spread(){let mut s=Simulation::new(2049,0);s.weather(14.0,-0.785398,0.18,0.0);s.brush(-18.0,-16.0,12.0,0);s.brush(-7.0,-22.0,6.0,0);let initial=s.stats[1];advance(&mut s,8.0);assert!(s.stats[1]<=initial+2.0,"unrealistic immediate chain {:?}",s.stats);assert!(s.trees.iter().all(|t|!t.state.crown_active));assert!(!s.smoke.is_empty());advance(&mut s,92.0);assert!(s.stats[1]>initial,"surface spread missing {:?}",s.stats);assert!(s.trees.iter().any(|t|t.state.crown_active),"canopy never ignited");}
    #[test]fn fuel_is_consumed_and_flames_end(){let mut s=Simulation::new(428,0);s.weather(20.0,0.0,0.05,0.0);s.brush(-20.0,-10.0,10.0,0);let keys:Vec<_>=s.trees.iter().filter(|t|t.state.surface_active).map(|t|t.key).collect();advance(&mut s,400.0);assert!(keys.iter().any(|k|s.trees[*s.index.get(k).unwrap()].state.burn>0.95));assert!(keys.iter().all(|k|s.trees[*s.index.get(k).unwrap()].state.surface_fuel<0.1));}
    #[test]fn dry_wind_spreads_faster_than_damp_calm(){let mut dry=Simulation::new(2049,0);let mut wet=Simulation::new(2049,0);dry.weather(36.0,0.0,0.08,0.0);wet.weather(0.0,0.0,0.65,0.0);for s in [&mut dry,&mut wet]{s.brush(-18.0,-16.0,12.0,0);s.brush(-7.0,-22.0,6.0,0);advance(s,70.0);}assert!(dry.stats[1]>wet.stats[1]*1.4,"dry {:?}, wet {:?}",dry.stats,wet.stats);}
    #[test]fn wind_biases_heat_downwind(){let mut s=Simulation::new(428,0);s.weather(42.0,0.0,0.08,0.0);s.brush(-50.0,-50.0,8.0,0);advance(&mut s,35.0);let(mut east,mut west)=(0.0,0.0);for t in &s.trees{if(t.z+50.0).abs()<25.0{if t.x> -40.0&&t.x< -10.0{east+=t.state.heat;}if t.x< -60.0&&t.x> -90.0{west+=t.state.heat;}}}assert!(east>west,"east {east}, west {west}");}
    #[test]fn suppression_and_firebreak_work(){let mut s=Simulation::new(428,0);s.brush(25.0,25.0,18.0,0);advance(&mut s,8.0);let emitted=s.smoke_emitted;assert!(emitted>0);s.brush(25.0,25.0,19.0,1);assert_eq!(s.stats[1],0.0);advance(&mut s,5.0);assert_eq!(s.smoke_emitted,emitted,"suppression should stop source emissions");s.brush(25.0,25.0,20.0,2);let cut:Vec<_>=s.packed.chunks_exact(STRIDE).filter(|t|t[5]== -1.0).collect();assert!(!cut.is_empty());assert!(cut.iter().all(|t|t[6]==0.0&&t[7]==1.0));s.brush(25.0,25.0,19.0,0);assert_eq!(s.stats[1],0.0);assert_eq!(s.stats[2],0.0);}
    #[test]fn streaming_retains_thermal_and_fuel_state(){let mut s=Simulation::new(428,0);s.brush(25.0,25.0,18.0,0);advance(&mut s,20.0);let packed=s.packed.clone();let fire=s.fire_packed.clone();let rev=s.revision;s.stream(2000.0,-3000.0);assert!(s.revision>rev);assert_eq!(s.stats[1],0.0);s.stream(0.0,0.0);assert_eq!(s.packed,packed);assert_eq!(s.fire_packed,fire);}
    #[test]fn fixed_step_and_smoke_are_deterministic(){let mut a=Simulation::new(428,0);let mut b=Simulation::new(428,0);a.brush(25.0,25.0,12.0,0);b.brush(25.0,25.0,12.0,0);for _ in 0..200{a.advance(0.1);}for _ in 0..400{b.advance(0.05);}assert_eq!(a.packed,b.packed);assert!(!a.smoke.is_empty());assert_eq!(a.smoke.len(),b.smoke.len());assert_eq!(a.smoke_packed,b.smoke_packed);assert_eq!(a.ember_packed,b.ember_packed);}
    #[test]fn smoke_rises_drifts_cools_and_dissipates(){let mut s=Simulation::new(428,0);s.weather(22.0,0.0,0.2,0.0);let ground=terrain(0.0,0.0,428);s.smoke.push(Smoke{x:0.0,y:ground+2.0,z:0.0,vx:0.0,vy:2.0,vz:0.0,size:1.5,optical_mass:4.0,temperature:240.0,opacity:0.0,age:0.0,lifetime:45.0,seed:0.3,ground,flow:[0.0;3]});advance(&mut s,12.0);assert_eq!(s.smoke.len(),1);let p=s.smoke[0];assert!(p.y>ground+15.0,"buoyant rise {}",p.y-ground);assert!(p.x>15.0,"downwind drift {}",p.x);assert!(p.temperature<180.0);assert!(p.size>3.0);assert!(p.opacity>0.0&&p.opacity<0.6);advance(&mut s,60.0);assert!(s.smoke.is_empty());}
    #[test]fn rain_reduces_emissions_and_extinguishes(){let mut dry=Simulation::new(428,0);let mut rain=Simulation::new(428,0);for s in [&mut dry,&mut rain]{s.brush(25.0,25.0,18.0,0);}rain.weather(18.0,0.0,0.2,1.0);advance(&mut dry,25.0);advance(&mut rain,25.0);assert!(rain.smoke_emitted<dry.smoke_emitted/2,"rain {}, dry {}",rain.smoke_emitted,dry.smoke_emitted);assert!(rain.stats[1]<dry.stats[1]);}
    #[test]fn hot_embers_must_land_before_spot_heating(){let mut s=Simulation::new(428,0);s.weather(0.0,0.0,0.05,0.0);let j=200;let(x,y,z)=(s.trees[j].x,s.trees[j].y,s.trees[j].z);for n in 0..40{s.embers.push(Ember{x,y:y+0.2,z,vx:0.0,vy:-1.0,vz:0.0,heat:0.95,size:0.08,age:5.0,lifetime:50.0,seed:n as f32/40.0,lift:0.0,ground:y,flow:[0.0;3]});}assert_eq!(s.stats[1],0.0);advance(&mut s,0.2);assert!(s.ember_landings>0);assert!(s.spot_ignitions>0);assert_eq!(s.stats[1],0.0,"landing heat must respect ignition dwell");advance(&mut s,3.0);assert!(s.stats[1]>0.0);}
}
