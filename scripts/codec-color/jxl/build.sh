#!/usr/bin/env bash
set -euo pipefail
# Requires activated Emscripten 3.1.64, CMake >=3.20, Ninja and python3.
toolchain_version=$(emcc --version)
if [[ "$toolchain_version" != *" 3.1.64 "* ]]; then
  printf 'JPEG XL bindings require Emscripten 3.1.64; activate that toolchain first.\n' >&2
  exit 1
fi
repository=$(cd "$(dirname "$0")/../../.." && pwd)
work="$repository/.tools/codec-color/jxl"
variant="${OPENLR_JXL_VARIANT:-st}"
case "$variant" in
  st) build="$work/build"; threads=OFF; simd=OFF ;;
  mt) build="$work/build-mt"; threads=ON; simd=OFF ;;
  mt_simd) build="$work/build-mt-simd"; threads=ON; simd=ON ;;
  *) printf 'Unknown JPEG XL build variant: %s\n' "$variant" >&2; exit 1 ;;
esac
python3 "$repository/scripts/codec-color/jxl/fetch_sources.py" "$work"
emcmake cmake -G Ninja -S "$repository/scripts/codec-color/jxl" -B "$build" \
  -DOPENLR_JXL_SOURCE="$work/source/libjxl" -DCMAKE_BUILD_TYPE=Release \
  -DOPENLR_THREADS="$threads" -DOPENLR_SIMD="$simd" \
  -DOPENLR_JXL_EXPERIMENTS="${OPENLR_JXL_EXPERIMENTS:-OFF}"
targets=(jxl_color_enc)
if [[ "$variant" == st ]]; then targets+=(jxl_inspect jxl_color_dec jxl_input_fixture); fi
cmake --build "$build" --target "${targets[@]}" --parallel "${OPENLR_BUILD_JOBS:-4}"
