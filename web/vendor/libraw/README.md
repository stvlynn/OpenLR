# OpenLR bundled RAW decoder

This directory contains the local, replaceable LibRaw WebAssembly decoder.

- @colorhythm/libraw-wasm 1.1.1, source revision 9b0f59a5e0f6d3d12a8f6fa594015ef4f30a6e95, MIT wrapper (LICENSE.MIT).
- LibRaw 0.22.1-Release, source revision b860248a89d9082b8e0a1e202e516f46af9adb29, distributed under LGPL 2.1 (LICENSE.LGPL). Upstream's alternative CDDL license is also preserved (LICENSE.CDDL).
- typed-cstruct 0.10.2, MIT (typed-cstruct/LICENSE).
- Emscripten 4.0.8 runtime (LICENSE.EMSCRIPTEN). Embedded library component credits and licenses are in COPYRIGHT and NOTICE.THIRD-PARTY.

Complete corresponding LibRaw source and the wrapper's custom C API/build scripts are in source/LibRaw.tar.gz and source/colorhythm-libraw-wasm.tar.gz, included with the application. Extract the wrapper, put the extracted LibRaw tree in packages/libraw.wasm/LibRaw, use Emscripten 4.0.8 and the wrapper's locked pnpm dependencies, then run its build scripts. Full provenance and instructions are in the repository's docs/raw-decoding.md.

To use a compatible modified library, replace libraw.mjs and libraw.wasm here and rebuild the OpenLR host (or serve the changed assets directly). No signature check blocks replacement. Modification and reverse engineering for debugging modifications to the LGPL library are permitted. The adjacent source archives and notices must accompany redistribution.

OpenLR changed only bare typed-cstruct import paths to local relative paths. The upstream WASM binary is unchanged, SHA-256 c4cb97a7e4372da41a1ff6ec6e1146f38deb125b733b8bbb2e9c52727953aba8.
