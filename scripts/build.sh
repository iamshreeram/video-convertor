#!/usr/bin/env bash
# Builds the wasm bundle into dist/ (GitHub Pages site) and, with --node, a
# CommonJS nodejs-target build into dist-node/ for scripts/node-smoke.mjs.
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

build_node=0
for arg in "$@"; do
  case "$arg" in
    --node) build_node=1 ;;
    *)
      echo "build.sh: unknown argument: $arg (supported: --node)" >&2
      exit 1
      ;;
  esac
done

pinned="$(sed -n 's/^wasm-bindgen = "=\(.*\)"$/\1/p' Cargo.toml)"
if [ -z "$pinned" ]; then
  echo "build.sh: cannot find the pinned wasm-bindgen version in Cargo.toml" >&2
  exit 1
fi
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "build.sh: wasm-bindgen CLI not found; install wasm-bindgen-cli $pinned" >&2
  exit 1
fi
installed="$(wasm-bindgen --version | awk '{print $2}')"
if [ "$installed" != "$pinned" ]; then
  echo "build.sh: wasm-bindgen CLI is $installed but Cargo.toml pins $pinned" >&2
  exit 1
fi

cargo build --release --target wasm32-unknown-unknown

wasm_in="target/wasm32-unknown-unknown/release/mkv2mp4.wasm"

rm -rf dist
mkdir -p dist
wasm-bindgen "$wasm_in" --target web --out-dir dist/pkg --out-name mkv2mp4 --no-typescript

# Optional size optimisation: a failing wasm-opt must never fail the build.
if command -v wasm-opt >/dev/null 2>&1; then
  if wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int \
    dist/pkg/mkv2mp4_bg.wasm -o dist/pkg/mkv2mp4_bg.opt.wasm; then
    mv dist/pkg/mkv2mp4_bg.opt.wasm dist/pkg/mkv2mp4_bg.wasm
  else
    echo "build.sh: wasm-opt failed; keeping the unoptimized wasm" >&2
    rm -f dist/pkg/mkv2mp4_bg.opt.wasm
  fi
else
  echo "build.sh: wasm-opt not found; skipping size optimisation" >&2
fi

cp -R web/* dist/
touch dist/.nojekyll

if [ "$build_node" -eq 1 ]; then
  rm -rf dist-node
  wasm-bindgen "$wasm_in" --target nodejs --out-dir dist-node --out-name mkv2mp4 --no-typescript
  # The repo root may gain a "type": "module" package.json; pin this directory to CommonJS.
  printf '%s' '{"type":"commonjs"}' > dist-node/package.json
fi

echo "build.sh: wasm size: $(wc -c < dist/pkg/mkv2mp4_bg.wasm) bytes"
echo "build.sh: done"
