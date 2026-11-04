# OpenLR local TIFF / AVIF / JPEG XL codecs

These are pinned open-source dependencies, not Adobe code. The native application embeds this whole directory for offline operation.

- UTIF 3.1.0 (Photopea, MIT), ESM adapter in utif.js; LICENSE.UTIF.
- pako 1.0.11 (Vitaly Puzrin / Andrei Tuputcyn, MIT and zlib-port notices), ESM adapter in pako.js; LICENSE.pako and NOTICE.pako-zlib.
- @jsquash/avif 2.1.1 and @jsquash/jxl 1.3.0 (Google / Jamie Sinclair, Apache-2.0); package LICENSE files are in avif/ and jxl/.
- wasm-feature-detect 1.9.0, Apache-2.0; LICENSE.wasm-feature-detect.

The notices/ directory preserves underlying libavif, libaom, libwebp/sharpyuv, libjxl, Brotli, Highway, skcms and Emscripten licenses, copyright/author and patent notices. notices/sources.json gives their exact source URLs and file hashes. Retain them when distributing these binaries.

JS changes are limited to CommonJS/UMD ESM adapters and bare-to-relative wasm-feature-detect imports. The WASM binaries are unchanged. manifest.json gives all runtime asset sizes and SHA-256. Regenerate from locked npm packages with scripts/vendor-codecs.mjs. Full provenance, codec limits and test scope are in the repository's docs/image-codecs.md.
