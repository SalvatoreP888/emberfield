# Emberfield v2

A browser forest-fire sandbox with a **Rust simulation compiled to WebAssembly** and a **Three.js rendering layer**. Explore a procedurally generated conifer forest, ignite trees, change wind and moisture, apply water, and remove fuel to create firebreaks.

The Rust source and compiled WASM binary are both included. Three.js requires JavaScript; this project keeps terrain heights, tree generation, streaming, heat, fuel, and fire-spread decisions in Rust, while JavaScript handles the renderer, visual effects, camera, input, and interface.

## Run locally

The checked-in `dist/` directory is ready to serve. First, download and unzip the full project. Then use the launcher for your system:

| System | Start EMBERFIELD |
| --- | --- |
| macOS | Double-click `Launch-EMBERFIELD.command` |
| Windows | Double-click `Launch-EMBERFIELD.bat` |
| Linux | Run `./Launch-EMBERFIELD.sh` from the project folder |

The launcher opens EMBERFIELD in your browser using a local-only server. Keep its window open while playing; close it or press Ctrl+C to stop. If the browser does not open automatically, open the address shown in the launcher. Python 3.7 or newer is required; no npm install or Rust build is needed. If macOS says the command is not executable, run `chmod +x Launch-EMBERFIELD.command Launch-EMBERFIELD.sh` in the project folder once.

You can also start the server manually from the project root:

```sh
python3 -m http.server 8000 --directory dist
```

Open **http://localhost:8000/** in a browser that supports WebAssembly. WebGL 2 enables the full Three.js scene. When WebGL is unavailable, the app labels and uses a Canvas compatibility view of the same Rust simulation. Use an HTTP server rather than opening `index.html` with `file://`, because the application fetches the WASM binary and loads JavaScript modules.

No npm installation is required to run this version. Three.js and its used add-ons are vendored under `dist/vendor/`, with their license in `THREE-LICENSE.txt`. The stylesheet requests Google Fonts and includes local font fallbacks.

The initial seed is **2049** and the starting simulation speed is **1×**, with optional 3× and 6× playback. A URL such as `http://localhost:8000/?seed=428` starts another seeded forest. The default Clearing fire scene starts eight simulated seconds after a small ignition, with a developing smoke plume and surface fire. Environment also offers Single ignition and Unburned forest; Reset and Generate recreate the selected scene with the chosen weather. Unburned forest starts at time zero.

## Controls

| Action | Control |
| --- | --- |
| Orbit | Left-drag in Explore mode; right-drag while a painting tool is selected |
| Pan | Right-drag in Explore mode |
| Travel through the forest | W / A / S / D or arrow keys |
| Travel faster | Hold Shift |
| Zoom | Mouse wheel; pinch on touch devices |
| Explore | `1` or the Explore button |
| Ignite trees | `2`, then click or drag on the terrain |
| Apply water | `3`, then click or drag |
| Remove fuel / create a firebreak | `4`, then click or drag |
| Adjust brush radius | `[` and `]`, from 4 m to 26 m |
| Pause / resume | Space or the pause button |
| Simulation speed | Click the speed button to cycle 1×, 3×, and 6× |
| Reset the current forest | Reset button; retains the chosen environment settings |
| Generate from a seed | Edit the seed in Environment, then press Enter or its generate button |
| Wind direction | Click the direction label to rotate by 45° |
| Weather | Environment panel: wind, moisture, rain, and presets |
| Visual detail | Automatic, High, Balanced, or Low in Environment |
| Heat / fuel overlays | Forest view: Natural, Heat, or Remaining fuel |
| Starting scene | Clearing fire, Single ignition, or Unburned forest in Environment |
| Performance readout | Expand Performance in Environment |
| Lighting | Nightfall toggle; this changes the view, not weather conditions |
| Help | `H` or `?` |
| Return to Explore / close Environment | Escape |
| Sound / fullscreen | Buttons in the header |

Explore mode also supports one-finger orbit and two-finger navigation on touch devices. Desktop provides the complete keyboard control set. Sound starts only after its button is pressed, according to browser audio rules.

Automatic detail adjusts resolution, tree detail, effects, shadows, and bloom using recent frame timings. Manual settings keep the chosen quality level. Heat and Remaining fuel recolor the same simulated trees; the legend explains the displayed range. The performance panel shows the 95th-percentile frame time, physics cost per tick, achieved playback speed, loaded trees/chunks, particle counts, and worker status. The requested 6× speed can exceed the device's available processing budget; the achieved rate reports that difference.

## Bird and dragon flight

Choose **Bird** (B) or **Dragon** (G) to fly through the forest with a third-person chase camera. Both creatures have animated wings; the dragon has a larger body, more powerful flaps, a higher top speed, and wider turns.

- **Space** (hold or tap): flap. **A/D** or **←/→**: turn.
- **↑ / S**: pitch up. **↓ / W**: pitch down. Drag the forest to steer; click for captured mouse look on desktop.
- **Shift**: tuck wings and dive. **Ctrl**: air brake. **L**: level pitch.
- **F** (dragon): breathe fire. Aim toward nearby trees or the ground. Breath has limited charge and refills when released; fire that hits fuel ignites and spreads in the same Rust simulation as the regular fire tool.
- **C** or **Camera**: switch between chase and first-person views. **P** or **Pause fire**: pause or resume the wildfire simulation. **Escape** or **Land**: return to the previous exploration camera. Transform switches creatures in flight.
- Follow the golden rings to build a streak, or toggle **Trail** off for free flight. Touch devices have turn, pitch, flap, tuck, and dragon fire buttons.

Diving converts altitude to speed; climbing spends speed. Drag slows a glide, wind causes drift, and low airspeed produces a soft stall. Flapping recovers energy with a cooldown. This is a forgiving point-mass flight model tuned for play, not a full aerodynamic simulator. Flight uses real time independently of wildfire pause and playback speed.

Rapier 0.19.3 is vendored under `dist/vendor/` (Apache-2.0). Swept body, head, tail, and wing probes collide with local terrain, trunks, stumps, and conservative canopy shapes, including at dive speed; tucking narrows the wing clearance. This approximates the animated creature rather than testing every feather. The chase camera also avoids obstacles. Flight requires WebGL 2; the existing Canvas fallback continues to support exploration and wildfire tools. No new install step or CDN connection is needed.

Run `npm run test:flight` for flight physics, collision, ring scoring, dragon fire, and actual WASM fire-spread checks.

## Architecture

| File | Responsibility |
| --- | --- |
| `simulation/src/lib.rs` | Seeded terrain, streamed trees, separate surface/canopy combustion, moisture drying, suppression, buoyant smoke, ballistic firebrands, and retained thermal state |
| `simulation/Cargo.toml` | Dependency-free Rust crate and optimized WASM build configuration |
| `dist/simulation.wasm` | Compiled Rust core served to the browser |
| `dist/simulation.js` | Worker bridge, transferred snapshot views, pure Rust terrain queries, and bounded main-thread fallback |
| `dist/simulation.worker.js` | Fixed-step scheduling, pause/visibility/reset commands, snapshot packing, and transferable-buffer reuse |
| `dist/forest.js` | Spatial batches of instanced trees, three geometry detail levels, cached terrain tiles, dirty uploads, and burn appearance |
| `dist/fire.js` | Surface/canopy flame shaders, quality budgets, depth-sorted smoke, and bounded interpolation of actual Rust particle positions |
| `dist/compatibility.js` | Canvas fallback with cached forest and smoke-density layers; reads the same Rust state and Three.js camera |
| `dist/flight.js`, `dist/flight-avatar.js` | Bird and dragon controls, chase camera, and animated creature models |
| `dist/flight-physics.js`, `dist/flight-collision.js` | Flight energy, wind, swept creature collisions, and camera obstruction |
| `dist/flight-game.js`, `dist/dragon-breath.js` | Optional flight trail and simulation-backed dragon fire |
| `dist/main.js` | Input, camera, UI, weather controls, audio, timing, scene composition, and post-processing |
| `dist/index.html`, `dist/style.css` | Interface and responsive layout |
| `SIMULATION_API.md` | Exported WASM functions, numeric buffer layout, units, and integration contract |

**Simulation and snapshots.** Rust advances at a fixed **20 Hz** in a dedicated Web Worker, independently of display frames. Playback speed changes how much simulated time the worker advances. Catch-up work is bounded, and paused or hidden time is not accumulated for later replay. The worker normally publishes at most 20 snapshots per second; edits can publish immediately. Each snapshot packs tree, combustion-stage, smoke, ember, and statistics arrays into one pooled transferable `ArrayBuffer`, with at most two snapshots outstanding. Backpressure bounds the message queue without stopping the physics. The main thread returns the previous buffer for reuse, so old typed-array views become detached; effects copy any interpolation history they need. No `SharedArrayBuffer` or cross-origin isolation headers are required.

If worker creation or startup fails, the same Rust core runs with a bounded main-thread scheduler. This fallback is separate from the Canvas renderer selected when WebGL 2 is unavailable. A lightweight Rust instance supplies pure seeded terrain queries for the camera and terrain meshes without allocating a second simulated forest.

**Core work reduction.** An active thermal frontier updates burning, heated, wet, and smoldering cells while pristine cells sleep. Weather changes and incoming heat wake eligible cells. Neighbor transfer weights, altitude-dependent wind, optical conversion, and particle flow/terrain samples are cached; packed tree fields and counters update only when their state changes. Streaming builds local neighbors through a cell grid and preserves modified fuel state. Smoke emission cadence and optical parcel mass are coupled, and bounded recycling admits fresh smoke when older, faint parcels fill the pool.

**Renderer work reduction.** Trees are grouped into 72 m spatial batches with three geometry detail levels and screen-size hysteresis. Only changed transforms/colors are uploaded; 128 m terrain tiles are cached across nearby streaming moves. Effects use reusable typed storage, snapshot/camera invalidation, visible-source and projected-area budgets, active-prefix uploads, and a shared 32 KiB filtered noise texture. Smoke is depth sorted and interpolated only between matching, validated Rust states, without extrapolation. Surface flames remain near the ground until the simulation reports canopy combustion. Render geometry and decorative undergrowth are generated in the Three.js layer; the renderers contain no independent spread model.

## Rebuild the Rust core

Install Rust and its WebAssembly target, then build from the project root:

```sh
rustup target add wasm32-unknown-unknown
sh simulation/build.sh
```

The script compiles the Rust crate in release mode and copies the output to `dist/simulation.wasm`. There is no wasm-bindgen generation step and no external Rust crate dependency. Refresh the served page after rebuilding.

## Verification

Run the source and compiled-binary checks:

```sh
cargo test --manifest-path simulation/Cargo.toml --release
node simulation/test-wasm.mjs
node scripts/test-worker.mjs
node scripts/test-fire.mjs
npm run check
```

The completed v2 checks include **19 native Rust tests and nine worker integration tests**, plus the shipped-WASM, effects-buffer, and JavaScript syntax checks above. Rust coverage includes determinism, ignition delays, wind reversal, wet-fuel persistence, exhaustion, suppression/firebreaks, streaming, sleeping cells, cached-math accuracy, compact state/counters, buoyancy/drift/cooling, smoke continuity and budget recycling, and landing-driven spotting. The shipped-binary check instantiates `dist/simulation.wasm` and verifies its actual exports and packed state.

Worker tests cover transfer detachment, render-independent timing, pause/visibility, 6× scheduling, paused edits, reset epochs, backpressure, and responsiveness of a real worker thread. Effects checks cover combustion stages, physical positions/diameters, detached-buffer history, seed collisions, paused edits, culling, quality/area limits, upload ranges, shader interfaces, and disposal. These are CPU-side checks, not a GPU shader compilation test.

## Measured CPU performance

The final comparison used the included v1 WASM baseline and shipped v2 WASM, identical seeded scenarios/weather/actions, 20 Hz export calls, three fresh-instance repeats, and 20 simulated seconds measured per repeat. Setup was excluded; the table reports median **CPU milliseconds per simulated second**, including Rust work and state packing. Rendering and worker-message delivery are excluded. See [the comparison](docs/benchmark-comparison.json) and the full [baseline](docs/benchmark-baseline-recheck.json) / [v2](docs/benchmark-optimized.json) samples for hardware, hashes, ranges, and world counts.

| Scenario | v1 CPU ms / simulated second | v2 CPU ms / simulated second | Reduction |
| --- | ---: | ---: | ---: |
| Established fire | 22.14 | 8.21 | 62.9% |
| Large fire | 25.34 | 9.38 | 63.0% |
| Rain | 17.43 | 8.56 | 50.9% |
| Streaming | 5.57 | 2.69 | 51.7% |

Reproduce the core measurements from the project root; run the two commands serially:

```sh
node simulation/benchmark.mjs --wasm simulation/baselines/v1.wasm --label baseline --repeats 3 --seconds 20
node simulation/benchmark.mjs --wasm dist/simulation.wasm --label v2 --repeats 3 --seconds 20
```

Add `--out path/to/report.json` to save a run. Idle timing is near timer/call overhead and is not used as an application speedup claim. v2 also improves the particle budget/model, so matching inputs do not imply bit-identical trajectories to v1.

The separate [effects CPU benchmark](docs/effects-performance.json) measured 31.16% less update time and 76.77% fewer requested upload bytes at Balanced detail with 20 Hz snapshots. With an unchanged snapshot and camera, it performed no source rescans or attribute uploads after warm-up. Run `node scripts/test-fire.mjs --benchmark` to measure the current adapter. [Forest measurements](docs/forest-performance.json) record dirty-upload, terrain-cache, and geometry-budget results; Canvas draw calls in that harness were stubbed.

**GPU rendering and browser FPS improvement remain unverified.** WebGL was unavailable in the validation browser. Shader interfaces and the vendored Three.js r180 prefix/texture contracts were checked statically, but GPU compilation, visual output, fill rate, and frame rate were not measured. The CPU results above are not a browser frame-rate guarantee; final browser interaction observations are recorded separately in `VERIFICATION.md`.

## Quality and rendering budgets

Rust independently caps physical smoke at **2,800 parcels** and embers at **1,000 particles**. Render caps apply after visibility and screen-size selection, so fewer effects may be drawn. Lowering visual detail does not alter fuel consumption or fire spread.

| WebGL detail | Fire sources | Maximum flame ribbons | Smoke parcels | Ember slots | Smoke projected-area budget |
| --- | ---: | ---: | ---: | ---: | ---: |
| Low | 140 | 560 | 800 | 300 | 1.8 viewport areas |
| Balanced | 240 | 1,440 | 1,500 | 650 | 3.4 viewport areas |
| High | 400 | 3,200 | 2,600 | 1,200 | 5.8 viewport areas |

The flame limits assume both surface and canopy stages are active; distance and projected area reduce the number of ribbons further. High's ember allocation exceeds the current Rust pool, so at most 1,000 physical embers can be present. Smoke-area budgets count overlapping projected billboards and use bounded density compensation for omitted parcels. Low disables shadows and bloom; Balanced and High enable them. WebGL pixel-ratio caps are 0.85, 1.15, and 1.5 respectively, additionally bounded by the device ratio.

| Canvas detail | Smoke parcels selected | Embers selected | Smoke-density layer width cap |
| --- | ---: | ---: | ---: |
| Low | 280 | 32 | 320 px |
| Balanced | 650 | 64 | 480 px |
| High | 1,000 | 96 | 640 px |

Canvas smoke is composited into a cached density layer up to those widths, with smaller layers on narrow viewports; visibility and projected-area budgets can reduce the selected count. Canvas pixel-ratio caps are 0.75, 1, and 1.25. Both renderers preserve Rust particle positions and the distinction between ground fire, crown fire, and lingering smoke.

## Model and practical limits

**Streamed world.** The forest has no authored map boundary. Terrain and trees are generated from the seed as the camera focus moves. An **11×11 chunk region, 396 m across**, is active at one time. Each chunk is 36 m across; the initial seed loads approximately 3,600 trees.

**Retained changes.** Modified trees outside the active region are kept in an in-memory map. Offscreen regions pause and resume when revisited. The cache grows with modified territory; it is not a disk save, and reloading or resetting clears it. The simulation does not attempt to advance an infinite forest simultaneously.

**Coordinates.** World positions use 32-bit floats. Large-distance exploration eventually loses coordinate precision. The current version does not implement floating-origin rebasing or planet-scale precision.

**Fire behavior.** Each occupied tree cell contains separate surface and canopy fuel, stored heat, fuel water, ignition dwell, and smoldering state. Incoming heat first pays a moisture-drying energy cost. Directional wind and terrain slope influence heat transfer; sustained surface heat can ignite the crown. Fuel consumption determines heat release and particle emission. Hot simulated firebrands can deposit heat after landing on eligible fuel, which must still satisfy moisture and ignition conditions. Coefficients are tuned for interactive behavior. This is a physically inspired sandbox, not a calibrated wildfire forecast. Decorative ferns, rocks, and logs do not have independent fuel states.

**Smoke physics.** Rust integrates smoke parcel velocity, temperature, optical mass, diameter, and lifetime at 20 Hz. Temperature-dependent buoyancy, altitude-dependent wind, drag, coherent curl flow, entrainment cooling, expansion, and dissipation shape the plume. Existing smoke remains after suppression and gradually disperses. This is a bounded parcel model with procedural turbulence, not a pressure-projected Navier–Stokes/Euler solver. It does not resolve canopy collisions, fire-driven weather, or full volumetric light transport.

**Ember physics.** Rust integrates lofting, wind drag, gravity, cooling, terrain contact, and probabilistic heat deposition. Rendering uses those same positions. Painting a firebreak removes its fuel and displays cut stumps; applying water wets and cools fuel. Neither action retroactively removes smoke already in the air.

**Readouts.** Burning counts include active surface or canopy fire in the loaded tree cells. Area is an estimate based on consumed fuel equivalents: one fully consumed cell represents 36 m², with surface and canopy fuel weighted 18% and 82%. It is not a measured burn perimeter, and cut firebreak trees are excluded. Moving far enough away can therefore reduce the displayed local totals.

## Design references

The implementation uses the broad ideas of fuel/environment-dependent spread, buoyancy, and turbulent plume motion. It does not reproduce or claim validation against the complete numerical models in these references.

- Rothermel, R. C. (1972), [A mathematical model for predicting fire spread in wildland fuels](https://research.fs.usda.gov/treesearch/32533).
- Fedkiw, R., Stam, J., and Jensen, H. W. (2001), [Visual Simulation of Smoke](https://physbam.stanford.edu/papers/stanford2001-01.pdf).
