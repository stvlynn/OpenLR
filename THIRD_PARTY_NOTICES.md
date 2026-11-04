# Third-party provenance and notices

## Engineering references

OpenLR's documentation acknowledges these engineering references:

- [stvlynn/agentic-coding](https://github.com/stvlynn/agentic-coding/tree/b15612fc04242759cc591545677af26dc2b5af32), commit `b15612fc04242759cc591545677af26dc2b5af32`: project-level agent workflow, documentation routing, and layered responsibility conventions. No repository license was found at the reviewed revision.
- [AstraFoundry/Arion](https://github.com/AstraFoundry/Arion/tree/3b1acc15ce251014ba720ee333c3cd74a75ea49b), commit `3b1acc15ce251014ba720ee333c3cd74a75ea49b`: an evolved application of those conventions, including explicit verification scope and native boundaries. The project declares `AGPL-3.0-only`.

OpenLR is licensed AGPL-3.0-only. The following material is reused from AstraFoundry/Arion at commit `3b1acc15ce251014ba720ee333c3cd74a75ea49b` under that license:

| Local path | Upstream path | Changes |
| --- | --- | --- |
| `LICENSE` | `LICENSE` | Full GNU AGPL version 3 text, unchanged |
| `docs/decisions/adr-template.md` | `docs/decisions/adr-template.md` | Added provenance comment; template body unchanged |
| `docs/import-rules.md` | `docs/frontend/import-rules.md` | Adapted imports and examples to OpenLR ES modules and Go/MyGo packages; removed Arion-specific links |

The upstream material belongs to its respective copyright holders, including AstraFoundry and contributors; its source revision does not add a separate copyright line to these documentation templates. The Free Software Foundation's copyright notice in the license text is retained. No skill packages, images, icons, fonts, or bundled runtimes are imported by this template review. No unlicensed `agentic-coding` files are copied. See [the source review](docs/template-sources.md) and [licensing](docs/licensing.md) for evidence and project policy.

## Dependencies and future imports

The initial desktop host uses the following pinned runtime dependencies. License texts copied without modification are retained in `resources/licenses/`, which the MyGo packager includes with the app. These are dependency notices; no upstream application or template source was copied into OpenLR.

| Component | Fixed version | License | Retained text |
| --- | --- | --- | --- |
| [MyGo](https://github.com/egoist/mygo/tree/v0.7.4) | v0.7.4 | MIT, copyright 2026 MyGo contributors | `resources/licenses/mygo-MIT.txt` |
| [purego](https://github.com/ebitengine/purego/tree/v0.11.1) | v0.11.1 | Apache-2.0 | `resources/licenses/purego-Apache-2.0.txt` |
| [golang.org/x/net](https://cs.opensource.google/go/x/net/+/refs/tags/v0.59.0:LICENSE) | v0.59.0 | BSD-3-Clause | `resources/licenses/golang-x-net-BSD.txt` |
| [golang.org/x/text](https://cs.opensource.google/go/x/text/+/refs/tags/v0.43.0:LICENSE) | v0.43.0 | BSD-3-Clause | `resources/licenses/golang-x-text-BSD.txt` |
| [Go standard library/runtime](https://go.googlesource.com/go/+/refs/tags/go1.27.3/LICENSE) | go1.27.3 build toolchain | BSD-3-Clause | `resources/licenses/go-BSD.txt` |

The list was checked against `go version -m build/windows-amd64/OpenLR.exe`. `go.mod` and `go.sum` also contain build-tool dependencies; verify the actual included modules again when producing a later release. The Go SDK is workspace-local tooling under ignored `.tools/` and is not copied into application packages.

Dependency manifests and lockfiles identify package versions. Their upstream packages retain their own copyright and license terms. The engineering-reference review above is not a complete inventory of runtime, development, or transitive dependency licenses.

When vendoring or adapting third-party material, add a record here containing the local paths, upstream URL and fixed revision, copyright holder, applicable license, retained notice locations, and modification summary. Preserve required license texts alongside the imported material. Before distributing a bundle, inventory the actual included packages and assets and include their required notices.

Adobe and Lightroom are names of third-party products discussed as prior art. This repository's name and references do not imply affiliation or endorsement.

## Bundled RAW decoder

`web/vendor/libraw/` contains `@colorhythm/libraw-wasm` 1.1.1 (source commit `9b0f59a5e0f6d3d12a8f6fa594015ef4f30a6e95`) and `typed-cstruct` 0.10.2. Both wrappers are MIT licensed, copyright TOMIKAWA Sotaro; license texts are retained as `LICENSE.MIT` and `typed-cstruct/LICENSE`. Only the bare typed-cstruct import specifiers are adapted for static hosting by `scripts/vendor-raw.mjs`; the WASM binary is unchanged.

The WASM contains LibRaw 0.22.1-Release at `b860248a89d9082b8e0a1e202e516f46af9adb29`, copyright 2008–2025 LibRaw LLC, and the Emscripten runtime (MIT / University of Illinois/NCSA). OpenLR selects LibRaw's LGPL-2.1 distribution option. LibRaw's `COPYRIGHT`, `LICENSE.LGPL`, `LICENSE.CDDL`, Emscripten's license, and the embedded DCB/FBDD and X3F BSD-style notices are retained alongside the module. LibRaw's copyright file also credits its dcraw and MIT-licensed DNG-derived portions; the complete corresponding source archive retains their source notices. These third-party notices do not imply use of Adobe Lightroom code or assets.

Exact library and wrapper source archives are included under `web/vendor/libraw/source/`, with fixed source URLs, hashes, replacement/build instructions and verification scope in [RAW decoding](docs/raw-decoding.md). Redistribution must preserve that source access and the retained notices. Independent modification/replacement and reverse engineering to debug modifications to the LGPL library are permitted; OpenLR's own AGPL license does not remove those permissions.

The EXIF reader uses exifr 7.1.3 by Mike Kovařík, Mutiny.cz (MIT). The unmodified ESM distribution and its license are in web/vendor/exifr/. [Upstream source](https://github.com/MikeKovarik/exifr).

Interface icons are from lucide-static 1.68.0. The individual SVGs and upstream ISC/MIT notices are in web/vendor/icons/. [Lucide](https://github.com/lucide-icons/lucide).

## TIFF, AVIF and JPEG XL codecs

`web/vendor/codecs/` contains UTIF 3.1.0 (MIT, copyright 2017 Photopea), pako 1.0.11 (MIT and zlib notices), @jsquash/avif 2.1.1 and @jsquash/jxl 1.3.0 (Apache-2.0, Google and Jamie Sinclair), and wasm-feature-detect 1.9.0 (Apache-2.0). Package licenses and original module notices are retained. OpenLR adds ESM wrappers around unchanged UTIF/pako bodies and rewrites jSquash's wasm-feature-detect imports to relative local imports with explicit modification comments. WASM binaries are unmodified published package artifacts.

The compiled codecs also contain libavif 1.0.1 (including its dav1d-derived source notices), libaom 3.7.0, libwebp/sharpyuv, libjxl, Brotli, Highway, skcms and the Emscripten runtime. Their required license, authors and applicable patent-grant texts are retained in `web/vendor/codecs/notices/`. Exact source revisions/URLs and hashes are recorded in its `sources.json`; runtime asset hashes are in `manifest.json`. These components retain their own BSD/MIT/Apache/zlib terms; OpenLR's AGPL declaration does not replace them. Preserve the complete notices directory in distributions.

See [image codecs](docs/image-codecs.md) for fixed npm gitHeads, underlying source build inputs, API behavior, adaptation/build steps and actual validation. The package's permissive wrapper license is not presented as the only license of its embedded C/C++ codecs.
