#!/usr/bin/env bash
# Build wllama (llama.cpp -> WebAssembly) from a pinned commit and copy the
# runtime files into web/vendor/wllama/.
#
# The npm release of wllama (3.8.1) bundles a llama.cpp that predates the
# PLaMo 3 tokenizer and fails with "unknown tokenizer: 'plamo3'", so the
# runtime is built from source. Requires git, docker and Node.js 22.
set -euo pipefail

WLLAMA_REPO="https://github.com/ngxson/wllama.git"
# wllama 3.12.0 (master, 2026-11-06); its llama.cpp submodule is d38bea3 (2026-11-05),
# which includes the plamo3 architecture and tokenizer.
WLLAMA_COMMIT="c10c21114984e37fe6ba4edbba446c28c5b7a954"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${WLLAMA_SRC_DIR:-$ROOT/.wllama}"
OUT="$ROOT/web/vendor/wllama"

if [ ! -d "$SRC/.git" ]; then
  git init -q "$SRC"
  git -C "$SRC" remote add origin "$WLLAMA_REPO"
fi
git -C "$SRC" fetch -q --depth 1 origin "$WLLAMA_COMMIT"
git -C "$SRC" checkout -q --force "$WLLAMA_COMMIT"
git -C "$SRC" submodule update --init --depth 1 --recursive

(
  cd "$SRC"
  ./scripts/build_wasm.sh        # main build (JSPI + Memory64) and compat build
  npm ci --include=dev
  npm run build:worker
  npm run build:tsup
  ./scripts/post_build.sh
)

rm -rf "$OUT"
mkdir -p "$OUT/compat"
cp "$SRC/esm/index.js" "$OUT/index.js"
cp "$SRC/esm/wasm/wllama.wasm" "$OUT/wllama.wasm"
cp "$SRC/compat/wasm/wllama.js" "$OUT/compat/wllama.js"
cp "$SRC/compat/wasm/wllama.wasm" "$OUT/compat/wllama.wasm"
cp "$SRC/LICENCE" "$OUT/LICENCE"
cp "$SRC/llama.cpp/LICENSE" "$OUT/LICENSE.llama.cpp"
printf 'wllama %s\nllama.cpp %s\n' "$WLLAMA_COMMIT" "$(git -C "$SRC/llama.cpp" rev-parse HEAD)" > "$OUT/VERSION"
ls -l "$OUT" "$OUT/compat"
