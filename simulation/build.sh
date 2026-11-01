#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/emberfield_simulation.wasm ../dist/simulation.wasm

