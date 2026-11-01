# Emberfield v2 verification

## Results and measurement scope

The final build passes **19 native Rust tests, the shipped-WASM integration suite, nine worker integration checks, the effects regression suite, and JavaScript syntax checks**. Browser interaction and visual inspection used the labeled Canvas compatibility view because WebGL is disabled in the available cloud browser. Full GPU shader compilation and WebGL visual output remain unverified.

The performance figures below measure specific CPU and buffer-upload workloads in one environment. They are not browser FPS guarantees. The cloud browser throttled display callbacks to approximately one per second even while the worker maintained its requested playback rate; its displayed frame rate is therefore unsuitable for comparing GPU performance.

## Rust core performance

The old and new binaries were measured serially, with three fresh-instance repetitions per scenario, identical seeds/weather/actions, a 20 Hz calling pattern, and 20 simulated seconds of measured work. Scenario setup was excluded. Timings include WASM computation and numeric snapshot packing, but exclude worker transfer and rendering.

| Scenario | v1 CPU ms / simulated second | v2 CPU ms / simulated second | Speedup |
| --- | ---: | ---: | ---: |
| Established fire at 100 s | 22.14 | 8.21 | 2.70× |
| Large fire at 240 s | 25.34 | 9.38 | 2.70× |
| Rain | 17.43 | 8.56 | 2.04× |
| Streaming | 5.57 | 2.69 | 2.07× |

Pristine idle forest now sleeps instead of scanning all cells. Its measured core cost fell below 0.01 ms per simulated second, near timer/call overhead; the resulting large ratio is not an application speedup claim. Cache/frontier storage uses approximately **0.81 MiB** more WASM memory in these scenarios.

Model changes can alter workloads. Raw reports retain both sets of counts: the large-fire comparison had 581 versus 582 burning cells, with approximately 2,800 smoke parcels and 1,000 firebrands on both sides. The original binary is included in `simulation/baselines/v1.wasm` for reproduction.

Evidence: `docs/benchmark-baseline-recheck.json`, `docs/benchmark-optimized.json`, and `docs/benchmark-comparison.json`. `docs/benchmark-baseline.json` preserves the initial measurement separately.

## Rendering and transfer work

| CPU or upload check | Before | After |
| --- | ---: | ---: |
| Forest synchronization of an unchanged new snapshot, median | 2.68 ms | 0.047 ms |
| Buffer invalidations over 200 unchanged forest snapshots | 1,600 | 0 |
| Forest streaming by 40 m | 40.5 ms | 7.9 ms |
| Height samples for that stream | 27,458 | 2 |
| Effects CPU over 1,800 display updates with 20 Hz snapshots | 382.63 ms | 263.40 ms |
| Effects requested upload bytes in that fixture | 169.83 MiB | 39.45 MiB |

The effects comparison uses a dense synthetic fixture with 3,600 trees, 400 burning sources, 2,800 smoke parcels, and 1,000 embers. The new Balanced mode applies distance and projected-area budgets and can draw fewer effects, so its 76.77% upload reduction includes selection as well as avoiding unnecessary work. It does not compare identical image quality or measure GPU execution. Unchanged adopted snapshots produce no repeat particle scans or attribute uploads; animation uniforms still update.

The forest fixture uses actual WASM buffers and Three.js objects. At its initial camera, estimated tree geometry is approximately 330k / 450k / 687k triangles at Low / Balanced / High, compared with 759k in the original forest-wide batches. These are geometry counts, not measured GPU timings.

For the final 12-second smoke scene, the Canvas adapter measured 1.52 ms median CPU work per new snapshot and 0.028 ms for a cached frame, with no plume rebuild across 100 unchanged frames. Canvas raster calls were stubbed in this microbenchmark, so these numbers exclude rasterization and compositing. The actual browser was inspected separately.

Evidence: `docs/forest-performance.json` and `docs/effects-performance.json`, including source hashes and explicit measurement limits.

## Core behavior and final binary

The shipped `dist/simulation.wasm` is **66,911 bytes**, with zero imported host functions. SHA-256:

```text
86aa3878f0b535a176d21de84a272c336f7f475be86531dfe1d964d4ec546a51
```

Native and compiled-binary checks cover deterministic generation; gradual surface-to-canopy ignition; wind-biased spread; fuel exhaustion; water, rain, and cut fuel; restoration after streaming; repeatable particle trajectories; buoyant rise, downwind drift, cooling and dissipation; hot-ember ground contact; sleeping and waking thermal cells; numerical approximation bounds; smoke budget admission; and source optical-mass preservation when emission cadence changes.

For seed 2049, wind 14 km/h toward northeast, baseline moisture 18%, no rain, and the application's two starter ignitions:

| Measurement | v2 result |
| --- | ---: |
| Loaded trees / chunks | 3,601 / 121 |
| Burning cells at 8 simulated seconds | 14 |
| Crown fires at 8 simulated seconds | 0 |
| Smoke parcels at 8 simulated seconds | 490 |
| Burning cells at 100 simulated seconds | 152 |
| Crown fires at 100 simulated seconds | 70 |
| Active thermal/wet cells at 100 simulated seconds | 191 |
| Exhausted cells at 400 simulated seconds | 455 |

These are implementation checks, not real-world fire predictions. A burning cell can contain surface and canopy fire simultaneously.

Smoke continuity was checked on actual Rust parcels at 12 seconds. The final scene has 742 parcels and a median nearest-center spacing of 0.457 times the neighboring parcels' mean diameter. Only 0.81% lack a neighbor within one mean diameter, compared with 35.43% before the final cadence correction. This comparison concerns the intermediate v2 smoke cadence, not the original v1 benchmark. Optical mass per parcel decreases as emission cadence increases; the 2,800-parcel pool cap remains unchanged. Evidence: `docs/plume-continuity.json`.

## Worker and adapter correctness

The nine worker checks exercise the production scheduler and compiled binary:

1. Snapshot arrays match authoritative WASM buffers.
2. Transferred old buffers detach while replacement snapshots remain valid.
3. Physics progression is independent of display-frame frequency.
4. Pause and hidden tabs do not accumulate a catch-up backlog.
5. 6× playback retains fixed steps and bounded catch-up work.
6. Brush commands publish ignition, suppression, and cut fuel while paused.
7. Reset advances the epoch and rejects stale snapshots and commands.
8. At most two transfer buffers remain outstanding while physics continues.
9. An actual worker thread transfers data while the host heartbeat remains responsive.

The effects suite checks stage separation, direct Rust particle fields, detached-buffer replacement, safe interpolation, duplicate-seed rejection, paused updates, no redundant work, culling, quality/area budgets, prefix uploads, shader interfaces, and disposal. Forest checks cover near-plane projection at default, 225 m, and 17 m camera distances; detached snapshot replacement; overlay changes without matrix uploads; retained thermal state across quality changes; and monotonic smoke optical density.

Shader interfaces, texture formats, attribute/varying counts, and Three.js r180 prefix behavior were inspected against the vendored source. This does not substitute for GPU compilation.

## Integrated browser checks

The final worker-backed app was exercised in the Canvas compatibility view:

- An unburned scene reset to zero active ignitions. While paused, an ignition brush raised the count from 0 to 6; water returned it to 0. Firebreak editing displayed cut stumps.
- Natural, Heat, and Remaining fuel views were selectable while paused. The fuel overlay and cut region were visually inspected. The WebGL paused-overlay dirty-state integration was fixed by synchronizing colors immediately after selection.
- Low, Balanced, and High detail controls applied without resetting physics. Clearing-fire and unburned starting scenes reset successfully.
- At 6× playback, a growing high-wind fire remained in the worker while navigation and controls operated. One observed snapshot reported 5.99× actual simulation rate, 275 burning cells, 2,798 smoke parcels, and 1,000 embers.
- Shift+W travel reached approximately 24 m west / 38 m north. Revision advanced from 3 to 6, loaded trees changed from 3,601 to 3,590, and the active region stayed at 121 chunks. Zooming did not produce near-plane tree blowups.
- Rainstorm, Nightfall, pause/resume, and the expanded Performance readouts were exercised. Dense-fire readouts displayed worker timing and bounded particle counts.
- Integration review corrected painting during an asynchronous reset and kept worker control suspended while a graphics context is lost. Context-loss logic was reviewed; a real WebGL loss/restore event could not be exercised here.

`docs/preview-v2.jpg` records the updated browser compatibility view. It is not a GPU-rendered screenshot. Mobile browser/device coverage remains unverified.

## Reproduce

The checked-in `dist/` app runs without rebuilding. For source verification with Rust, Node, and the WASM target installed:

```sh
cargo test --manifest-path simulation/Cargo.toml --release
node simulation/test-wasm.mjs
node scripts/test-worker.mjs
node scripts/test-fire.mjs
npm run check
python3 -m http.server 8000 --directory dist
```

To rebuild, run `rustup target add wasm32-unknown-unknown` followed by `sh simulation/build.sh`. Run CPU comparisons sequentially:

```sh
node simulation/benchmark.mjs --wasm simulation/baselines/v1.wasm --label baseline --out docs/benchmark-baseline-reproduced.json
node simulation/benchmark.mjs --wasm dist/simulation.wasm --label current --out docs/benchmark-current.json
```

## Model scope

This is a physically inspired interactive model with separate surface/canopy fuels and representative smoke/firebrand parcels. It is not a calibrated wildfire forecast or a pressure-projected fluid solver. Only the loaded 396 m region advances; altered offscreen tree state remains in memory and resumes on revisit. Particle pools and rendering budgets are bounded. See `SIMULATION_API.md` for units, exported buffers, approximations, and streaming limits.
