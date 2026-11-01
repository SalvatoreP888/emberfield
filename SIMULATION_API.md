# Emberfield Rust / WebAssembly simulation

The Rust module owns seeded terrain heights and tree placement, forest streaming, surface and canopy combustion, moisture and thermal state, suppression, smoke parcels, and airborne firebrands. Three.js renders numeric snapshots from WebAssembly. There is no JavaScript fire-spread or particle-trajectory fallback.

## Build and verify

Install Rust with the `wasm32-unknown-unknown` target, then run from the project root:

```sh
cargo test --manifest-path simulation/Cargo.toml --release
sh simulation/build.sh
node simulation/test-wasm.mjs
```

`build.sh` copies the release binary into `dist/simulation.wasm`. The crate has no external Rust dependencies and the shipped WASM has no imported host functions.

## Browser integration

```js
const { instance } = await WebAssembly.instantiateStreaming(fetch('./simulation.wasm'));
const sim = instance.exports;
sim.init(2049);
sim.set_weather(14, -Math.PI / 4, 0.18, 0);
sim.ignite(-18, -16, 12);
sim.step(1 / 20);

const trees = new Float32Array(sim.memory.buffer, sim.trees_ptr(), sim.tree_count() * 10);
const fire = new Float32Array(sim.memory.buffer, sim.fire_states_ptr(), sim.tree_count() * 4);
const smoke = new Float32Array(sim.memory.buffer, sim.smoke_ptr(), sim.smoke_count() * 8);
const embers = new Float32Array(sim.memory.buffer, sim.embers_ptr(), sim.embers_count() * 8);
const stats = new Float32Array(sim.memory.buffer, sim.stats_ptr(), 8);
```

Reacquire typed-array views after mutations, especially `set_focus()` and `reset()`: WebAssembly memory growth can invalidate a previous buffer. `world_revision()` changes when tree ordering or topology changes. Fire/particle state changes without incrementing that revision.

Tree order stays fixed between revisions. Particle order can change on any simulation step because retired parcels are removed with a swap. Particle `seed` stays constant over each parcel's life and supplies visual variation. A particle count of zero is valid. The renderer should consume each current snapshot rather than derive looping positions from particle age.

## Exports

| Export | Arguments / result |
| --- | --- |
| `init(seed)` | Starts a new unsigned 32-bit seed at the origin. No automatic fire. |
| `reset(seed)` | Resets the forest, retained changes, particles, and clock. Increments revision. |
| `set_focus(x, z)` | Streams the active region around this position. Coordinates are meters. |
| `get_height(x, z)` | Returns deterministic terrain height in meters. |
| `get_height_seeded(x, z, seed)` | Pure terrain query for an explicit seed. Works before `init()` and avoids allocating a duplicate simulation for a renderer. |
| `tree_count()` | Active tree count. |
| `trees_ptr()` | Byte offset of the stride-10 tree buffer. |
| `fire_states_ptr()` | Byte offset of a stride-4 combustion buffer, with one record per tree in the same order. |
| `smoke_ptr()` / `smoke_count()` | Byte offset and live count of stride-8 smoke records. |
| `embers_ptr()` / `embers_count()` | Byte offset and live count of stride-8 firebrand records. |
| `world_revision()` | Changes when active tree topology changes. |
| `active_cell_count()` | Number of thermal/wet cells currently participating in the fixed-step frontier. Pristine idle cells sleep. |
| `smoke_recycled_count()` | Cumulative weak aged parcels replaced to admit fresh near-source smoke at the pool limit. Reset clears the counter. |
| `step(dt)` | Advances simulation seconds at fixed 20 Hz. A call is clamped to 2 seconds of catch-up. |
| `set_weather(speed, angle, moisture, rain)` | Wind in km/h, radians, moisture 0–1, rain 0–1. Angle 0 points toward +X; π/2 toward +Z. |
| `ignite(x, z, radius)` | Applies deliberate ignition energy to surface fuel in the brush. Does not ignite the canopy immediately or restore consumed/cut fuel. |
| `extinguish(x, z, radius)` | Cools both fuel layers, stops their combustion, and adds water. Already emitted particles continue moving and dissipating. |
| `firebreak(x, z, radius)` | Removes surface and canopy fuel. Tree variant becomes -1 for stump rendering; cut trees are excluded from fire-burned totals. |
| `stats_ptr()` | Byte offset of eight `f32` metrics. |
| `memory` | The module's exported WebAssembly memory. |

## Tree buffer: ten `f32` values

| Offset | Value |
| --- | --- |
| 0 | World X |
| 1 | Terrain Y at tree base |
| 2 | World Z |
| 3 | Tree height, 8–16 m |
| 4 | Canopy radius, 2.2–3.85 m |
| 5 | Visual variant 0/1/2; **-1 is a cut firebreak tree** |
| 6 | Heat/combustion indicator: sustained flaming ≥0.65; nonflaming preheat/smolder ≤0.60 |
| 7 | Consumed fuel fraction, 0–1; weighted 18% surface and 82% canopy fuel |
| 8 | Current surface-fuel water state, clamped to 0–1 for display |
| 9 | Stable tree visual seed, 0–1 |

The existing stride and field offsets are unchanged. A fully burned tree retains its normal variant and may be rendered as a tall charred trunk. Cut trees have variant -1, heat 0, and burn 1. The cut marker and all thermal/fuel state survive streaming and revisits.

Heat alone does not tell the renderer whether a flame belongs on the ground or in the canopy; use the combustion buffer below.

## Combustion buffer: four `f32` values per tree

`[surface_flame_intensity, crown_flame_intensity, smolder_intensity, heat_release_normalized]`

All values are 0–1. Ground flames should scale from the surface value and remain near the tree base. Full-tree canopy flames should appear only when crown intensity is positive. Smoldering fuel can emit smoke without sustained flames. Heat release is a normalized display/emission quantity, not kilowatts.

## Smoke buffer: eight `f32` values per parcel

`[x, y, z, size, opacity, temperature_normalized, age_normalized, seed]`

- Positions are current world-space meters integrated by Rust.
- `size` is the **full billboard diameter in meters**. Parcels start around 1.4–3.35 m and expand with entrainment. More closely spaced, lower-opacity source parcels produce overlapping plumes.
- `opacity` is projected optical opacity, 0–1, including formation and dissipation fades.
- `temperature_normalized` is excess temperature above ambient divided by 300 K and clamped to 0–1. The internal parcel model uses 293 K ambient and a simplified excess-temperature state.
- `age_normalized` is elapsed age divided by that parcel's lifetime. Positions never loop when it reaches 1; the parcel is retired. Weak aged parcels can also be retired earlier to maintain the bounded smoke budget.
- `seed` is a stable 0–1 visual variation value for that parcel.

Smoke has a fixed capacity of **2,800 live parcels**. Its backing storage is allocated upfront. Emission is proportional to current surface/crown reaction and smoldering activity. At capacity, a bounded sample of the pool prefers replacing faint parcels older than six seconds, with lower priority for distant parcels. This keeps fresh smoke arriving at active sources instead of letting old distant puffs occupy the entire budget. If no suitable candidate is found, that emission is skipped. Rotating emitter traversal and recycling samples prevent a permanent bias toward the first trees. Recycling is a visual-budget approximation, not exact soot-mass conservation.

Sparse sources use a cadence of 5 parcels/s per surface intensity, 7 per canopy intensity, and 2.2 per smolder intensity. Dense fires share a nominal 400-parcel/s emission budget. Parcel optical mass adjusts inversely with cadence, preserving the source's normalized optical-mass generation before capacity-based recycling. The higher cadence fills physical gaps between accelerating parcels without adding cosmetic trajectories or inflating source opacity.

The 12-second starter check produced 742 real parcels. Median nearest-center spacing was 0.457 times the neighboring parcels' mean diameter, and fewer than 1% lacked a neighbor within one diameter; before this bounded continuity correction the corresponding figures were 0.782 and 35%. The measured data and final binary hash are recorded in `docs/plume-continuity.json`.

## Ember buffer: eight `f32` values per firebrand

`[x, y, z, heat, size, age_normalized, seed, reserved]`

- Positions are current world-space meters.
- `heat` is remaining normalized firebrand heat, 0–1.
- `size` is a visual diameter in meters, approximately 0.035–0.11 m.
- `age_normalized` is age/lifetime, 0–1.
- `seed` is stable for that firebrand; `reserved` is currently 0.

The pool is capped at **1,000 live firebrands**. These are the actual particles used by the spot-heating model, not cosmetic duplicates. Extra emission is skipped if the pool is full, so the cap can affect spotting in extremely dense fires. A hot landing samples the local surface-fuel cell and may deposit finite heat, depending on its fuel, moisture, rain, and remaining firebrand heat. It still must meet the normal ignition dwell conditions. There is no independent teleport-based spotting path.

## Metrics

`[simulation_seconds, burning_count, burnt_count, active_tree_count, consumed_area_hectares, wind_kph, moisture_percent, active_chunk_count]`

Counts and consumed area describe the currently loaded region. Burning count includes cells with sustained surface or canopy flame. Burnt count uses consumed fraction ≥0.98. Area is a fuel-consumption equivalent (36 m² per fully consumed tree cell), not a measured fire perimeter. Removed firebreak fuel is excluded. The moisture metric is the selected baseline; individual cells can be drier from heating or wetter from water/rain.

## Combustion model

Each tree cell owns separate surface and canopy fuel, water, heat, flame activity, and time above ignition conditions. Neighbor transfer depends on source development, source-to-target distance, wind alignment, and slope. Exponential head/back and slope factors are clamped; downwind spread can lead while flanks and backing fire develop more slowly. The transfer coefficients and fuels are normalized, not calibrated field measurements.

Seeded surface fuel loads vary from 0.76–1.29 times the reference load, and canopy loads from 0.80–1.22. More fuel takes longer to consume; reaction energy scales with consumed mass. This produces variation in burn duration without changing the tree-buffer layout.

Incoming energy pays a moisture-evaporation cost before raising fuel temperature. A neighboring cell must accumulate sufficient heat, have sufficiently dry fuel, and remain above its ignition threshold for a dwell time. A deliberate brush ignition lights surface fuel promptly. Canopy fuel warms from the surface and adjacent crown sources and has its own drying and ignition delay. Fuel-limited reactions taper as available fuel falls; residual fuel can smolder after flames end.

Water immediately suppresses the selected fuel layers and wets them against reignition. Rain adds water, increases cooling, and reduces firebrand emission; it also cools smoke and washes out optical density. Thermal, moisture, fuel, dwell, reaction, and emission-credit state is retained for modified cells when they leave the active region.

## Smoke and firebrand transport

Smoke parcels carry velocity, excess temperature, optical mass, size, age, and lifetime. They receive temperature-dependent buoyancy, drag toward an altitude-dependent wind field, and a spatially coherent rotating flow obtained from the curl of a three-dimensional noise vector potential. Expansion entrains ambient air, reducing temperature and projected optical density. Parcels cool, spread, drift, and finally dissipate; motion is not a repeating sine trajectory.

Coherent forcing is sampled at staggered intervals: every four fixed ticks for smoke and every three for firebrands, with velocities and positions still integrated at 20 Hz. Smoke ground height is refreshed every 0.8 seconds while aloft and every step near the ground. Firebrand landing height is checked every step. A 0.5 m altitude lookup approximates wind shear; a bounded optical lookup and small-step decay approximation reduce transcendental work. Tests bound these approximations against their reference functions.

Firebrands carry velocity and heat. They receive initial flame loft, a decaying local updraft, wind drag, gravity/settling, coherent turbulent perturbations, and cooling. Rust checks their trajectory against the same procedural terrain used by the forest. Spot heating occurs only at a real hot landing in an eligible active fuel cell.

This is a **parcel-based approximation**. There is no Eulerian fluid grid, pressure projection, solved plume-to-plume interaction, oxygen transport, or calibrated subgrid turbulence model. Curl noise supplies coherent eddies rather than resolving the Navier–Stokes equations. Ground-level wind and fuel conditions are simplified, and smoke/firebrand particles are representative parcels rather than every physical soot particle or ember.

## Runtime and reproducible profiling

The Rust core maintains an active frontier of heated, burning, smoldering, and wet cells. Newly heated neighbors and hot firebrand landings wake cells; pristine idle forest does not execute combustion updates. Neighbor wind/slope weights are cached when weather or topology changes. Tree positions and dimensions are packed once per topology revision; subsequent snapshots refresh changed thermal fields and aggregate counters. Particle arrays still represent the current integrated state.

Run identical input scenarios against a chosen binary:

```sh
node simulation/benchmark.mjs --wasm simulation/baselines/v1.wasm --label baseline --out docs/benchmark-baseline-reproduced.json
node simulation/benchmark.mjs --wasm dist/simulation.wasm --label current --out docs/benchmark-current.json
```

The original 58,560-byte baseline binary is included at `simulation/baselines/v1.wasm`, so both sides can be reproduced without fetching prior Git history. Run the commands sequentially to avoid competing benchmark processes.

The default benchmark uses three fresh-instance repeats per scenario, 20 simulated seconds of measured work, a 20 Hz calling pattern, and identical seed/weather/actions. Establishing each scenario is excluded from timing. Scenarios are idle forest, established fire at 100 seconds, large fire at 240 seconds, rainfall, and one-chunk-per-second streaming. Raw before/after particle and combustion counts are recorded because model changes can alter the resulting workload. Timings measure the WASM core plus its numeric snapshot packing, not browser rendering, worker transfer, or application FPS. Recorded runs and hashes are in `docs/benchmark-baseline.json`, `docs/benchmark-baseline-recheck.json`, `docs/benchmark-optimized.json`, and `docs/benchmark-comparison.json`.

The final serialized three-repeat comparison measured median core cost of 22.14→8.21 ms per simulated second for established fire, 25.34→9.38 for large fire, 17.43→8.56 for rain, and 5.57→2.69 for streaming. Both intense-fire runs kept the smoke/firebrand pools effectively full. Idle core work fell below 0.01 ms per simulated second, near timer/call overhead. The optimized module uses approximately 0.81 MiB more WebAssembly memory for caches and frontier bookkeeping in the benchmark; this trades modest memory for lower computation. These are measurements from one execution environment, not a device-independent performance guarantee.

## Streamed world and scope

Multi-scale deterministic noise generates terrain. A 36 m chunk contains a jittered 6×6 tree grid with natural gaps. An 11×11 chunk region, 396 m across, is active around the focus, typically containing several thousand trees. Moving generates new terrain without an authored map edge. Positions use 32-bit floats and eventually lose precision at extreme distances; floating-origin rebasing is not implemented.

Modified tree cells are retained in memory and **pause outside the loaded region**. Returning restores their thermal and fuel state. Existing parcels keep world positions while nearby; moving the focus far away retires parcels outside the loaded neighborhood. Particle clouds are transient and are not archived with offscreen tree state. The retained tree cache grows with modified territory and lasts for the current page session. Reset/reload clears it.

This is a physically inspired interactive sandbox. It is not a validated Rothermel implementation, an operational wildfire forecast, or a complete atmospheric fluid solver.
