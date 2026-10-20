#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
rustc --target wasm32-unknown-unknown --crate-type cdylib -C opt-level=z -C strip=symbols -C panic=abort \
  -C link-arg=--export-memory -C link-arg=--initial-memory=16777216 \
  -o flood_fill.wasm flood_fill.rs
