#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace="$(cd "$script_dir/../../.." && pwd)"
work_dir="${OPENLR_AVIF_BUILD_DIR:-$workspace/.tools/codec-color/avif}"
source_dir="$work_dir/sources"
command -v emcmake >/dev/null
command -v cmake >/dev/null
command -v ninja >/dev/null
if [[ "$(emcc --version | head -n 1)" != *3.1.64* ]]; then
  echo "This recipe requires Emscripten 3.1.64" >&2
  exit 1
fi
mkdir -p "$source_dir"
for name in libavif libaom libwebp; do
  if [[ ! -f "$source_dir/$name/CMakeLists.txt" ]]; then
    echo "Missing pinned source directory $source_dir/$name; see sources.json" >&2
    exit 1
  fi
done
for mode in st mt; do
  threaded=OFF
  [[ "$mode" == mt ]] && threaded=ON
  emcmake cmake -G Ninja -S "$script_dir" -B "$work_dir/build-$mode" \
    -DCMAKE_BUILD_TYPE=Release -DCODEC_SOURCE_DIR="$source_dir" -DOPENLR_THREADS="$threaded"
  cmake --build "$work_dir/build-$mode" --parallel "${OPENLR_BUILD_JOBS:-2}"
done
mkdir -p "$work_dir/output/enc" "$work_dir/output/dec"
cp "$work_dir/build-st/avif_enc.js" "$work_dir/build-st/avif_enc.wasm" "$work_dir/output/enc/"
cp "$work_dir/build-st/avif_dec.js" "$work_dir/build-st/avif_dec.wasm" "$work_dir/output/dec/"
cp "$work_dir/build-mt/avif_enc_mt.js" "$work_dir/build-mt/avif_enc_mt.wasm" "$work_dir/build-mt/avif_enc_mt.worker.mjs" "$work_dir/output/enc/"
echo "Built actual color-capable AVIF modules in $work_dir/output"
