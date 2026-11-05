# Color-capable codec builds

The application ships these artifacts offline. Rebuilding them is developer work,
not an application startup step. Sources are fixed by the adjacent `sources.json`
files; downloads and build directories stay under ignored `.tools/`.

Use Linux (including WSL) with Node, Python 3, Git, CMake 3.20+ and Ninja. Install
and activate [Emscripten SDK 3.1.64](https://github.com/emscripten-core/emsdk/tree/3.1.64):

```sh
git clone --branch 3.1.64 --depth 1 https://github.com/emscripten-core/emsdk.git .tools/emsdk
python3 .tools/emsdk/emsdk.py install 3.1.64
python3 .tools/emsdk/emsdk.py activate 3.1.64
source scripts/codec-color/environment.sh
node scripts/codec-color/avif/fetch-sources.mjs
bash scripts/codec-color/avif/build.sh
bash scripts/codec-color/jxl/build.sh
OPENLR_JXL_VARIANT=mt bash scripts/codec-color/jxl/build.sh
OPENLR_JXL_VARIANT=mt_simd bash scripts/codec-color/jxl/build.sh
node scripts/codec-color/install.mjs
```

`OPENLR_EMSDK` can select an already installed SDK. On WSL, a Linux-native SDK
directory avoids the measured overhead of repeated compiler/Python launches from
`/mnt/c`. `OPENLR_BUILD_JOBS` defaults to four. Normal system CMake/Ninja work;
the environment helper also recognizes ignored local wheel installations used
for validation (CMake 3.31.6, Ninja 1.11.1.4).

The installer checks that every variant exists before replacing artifacts. It
removes obsolete encoder wrappers/binaries and unused SDK worker placeholders and refreshes the existing asset
inventory. `npm run build:codecs` refreshes npm-derived dependencies without
overwriting rebuilt bindings. This is source reproducibility, not a claim that
different environments produce byte-identical binaries.

AVIF adapts Apache-2.0 jSquash bindings and retains their attribution/license.
JPEG XL uses independent public API bindings; its inspector and optional
compression experiment interface are validation tools, not shipped runtime
features. Libpng/zlib are pinned libjxl configuration prerequisites, absent from
the actual encoder link inputs. Codec/library/Emscripten terms remain in
`web/vendor/codecs/notices/` and the fetched source archives.

See [AVIF validation](../../research/avif-color-binding.md) and
[JPEG XL validation](../../research/jxl-color-binding.md) for real WASM, bitstream,
profile and independent CMS experiments. Application checks:

```sh
node --test tests/codecs.test.js tests/color-workflow.test.js tests/worker-fallback.test.js
node scripts/native-smoke.mjs /path/to/OpenLR
```
