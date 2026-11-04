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

## Bundled image registration runtime

`web/vendor/opencv/opencv.js` is the unmodified `@techstark/opencv-js` **5.0.0-release.1** npm distribution of OpenCV 5.0.0, licensed Apache-2.0. The retained [NOTICE](web/vendor/opencv/NOTICE), license texts, build information, and SHA-256 inventory identify the wrapper and bundled protobuf (BSD-3-Clause), zlib (zlib license), Flatbuffers (Apache-2.0), and Emscripten runtime (MIT / University of Illinois/NCSA). Their copyrights and license texts remain alongside the runtime. The artifact is pinned in the lockfile and reproduced by `scripts/vendor-opencv.mjs`; it embeds its WASM and makes no CDN request. [OpenCV source](https://github.com/opencv/opencv/tree/5.0.0), [package source](https://github.com/TechStark/opencv-js).

OpenLR uses OpenCV ORB, Hamming descriptor matching, RANSAC homography, and projective warping for [photo merging](docs/photo-merge.md). Its radiance recovery, tone mapping, feather blending, tests, and UI are project code; Adobe's photo-merge implementation is neither copied nor linked.

## Offline SQLite catalog engine

`web/vendor/sqlite/` contains the published **sql.js 1.15.2** browser runtime (MIT, copyright 2017 sql.js authors), with the complete upstream LICENSE and AUTHORS. OpenLR declares the UMD shell's private `module` variable and appends an ES module export around the unchanged factory body; the published WASM is unchanged. [Pinned upstream](https://github.com/sql-js/sql.js/tree/v1.15.2), retained NOTICE, source ID and SHA-256 manifest document that adaptation, reproduced by `scripts/vendor-sqlite.mjs`.

The engine reports **SQLite 3.54.0**; core SQLite is [dedicated to the public domain](https://sqlite.org/copyright.html). The published build also contains contributed extension functions credited in NOTICE and the Emscripten runtime (MIT / University of Illinois/NCSA, complete LICENSE.EMSCRIPTEN retained). Preserve all runtime notices and upstream author attribution. OpenLR's [catalog adapter](docs/catalog-migration.md) and synthetic SQLite/PNG fixtures are independent project code; no Adobe catalog data or third-party parser implementation is bundled.

## Lens calibration database

`web/vendor/lensfun/` retains four unchanged Lensfun calibration XML files and `COPYING.CC_BY-SA_3.0` from [Lensfun commit bc5615d6278cb5fb75dd53e74015367453d5591d](https://github.com/lensfun/lensfun/tree/bc5615d6278cb5fb75dd53e74015367453d5591d), copyright Lensfun contributors and individual calibration authors. The database is licensed **Creative Commons Attribution-ShareAlike 3.0 Unported**, separately from Lensfun software. Its [NOTICE](web/vendor/lensfun/NOTICE) and manifest retain source paths, attribution, revision, file hashes and modifications. Preserve the complete license and attribution in distributions.

`web/lens-data.js` is OpenLR's generated adaptation: camera identifiers and supported rectilinear distortion/TCA samples are extracted to JSON, while unsupported models and vignetting are omitted. This adapted calibration data retains CC BY-SA 3.0; it is not relicensed under AGPL. `scripts/vendor-lensfun.mjs` regenerates it from the retained original files. The independently implemented renderer and UI are OpenLR project source. No Lensfun C/C++ library or lensfunpy package is linked or redistributed. See [optics and geometry](docs/optics-geometry.md) for algorithms, limitations and verification.

## Camera RAW validation fixture

`tests/fixtures/raw/canon-powershot-g1.crw` is sample 2073 from [raw.pixls.us](https://raw.pixls.us/), published there under **CC0-1.0**. Its adjacent JSON records the exact source, license, byte count and SHA-256; [CC0 terms](https://creativecommons.org/publicdomain/zero/1.0/legalcode) apply to that sample. It is used for actual non-DNG RAW conversion testing and does not originate from a user's photo library. The fixture does not license Adobe's applications or Canon trademarks. OpenLR's [DNG writer](docs/dng-export.md) is project source; no Adobe DNG SDK is included.

## TIFF, AVIF and JPEG XL codecs

`web/vendor/codecs/` contains UTIF 3.1.0 (MIT, copyright 2017 Photopea), pako 1.0.11 (MIT and zlib notices), @jsquash/avif 2.1.1 and @jsquash/jxl 1.3.0 (Apache-2.0, Google and Jamie Sinclair), and wasm-feature-detect 1.9.0 (Apache-2.0). Package licenses and original module notices are retained. OpenLR adds ESM wrappers around unchanged UTIF/pako bodies and rewrites jSquash's wasm-feature-detect imports to relative local imports with explicit modification comments. WASM binaries are unmodified published package artifacts.

The compiled codecs also contain libavif 1.0.1 (including its dav1d-derived source notices), libaom 3.7.0, libwebp/sharpyuv, libjxl, Brotli, Highway, skcms and the Emscripten runtime. Their required license, authors and applicable patent-grant texts are retained in `web/vendor/codecs/notices/`. Exact source revisions/URLs and hashes are recorded in its `sources.json`; runtime asset hashes are in `manifest.json`. These components retain their own BSD/MIT/Apache/zlib terms; OpenLR's AGPL declaration does not replace them. Preserve the complete notices directory in distributions.

See [image codecs](docs/image-codecs.md) for fixed npm gitHeads, underlying source build inputs, API behavior, adaptation/build steps and actual validation. The package's permissive wrapper license is not presented as the only license of its embedded C/C++ codecs.

Original + settings archives use fflate 0.8.3 (MIT, Arjun Barrett). Unmodified browser module and license in web/vendor/fflate/. [Upstream](https://github.com/101arrowz/fflate).

The native application menu in menu.go adapts MyGo menu construction, separators and action callback routing from Arion's apps/desktop/bootstrap/windows.go at 3b1acc15ce251014ba720ee333c3cd74a75ea49b, AGPL-3.0-only. OpenLR supplies its own labels, photo actions and frontend event routing.

Video conversion uses the unmodified Mediabunny 1.65.1 browser module (MPL-2.0). The distribution and license are in web/vendor/mediabunny/. [Corresponding source](https://github.com/Vanilagy/mediabunny/tree/v1.65.1).

Catalog migration reads SQLite through sql.js 1.15.2 (MIT, copyright sql.js authors). `web/vendor/sqlite/` retains its AUTHORS, MIT license, unchanged WASM, the Emscripten runtime license and a hash manifest. OpenLR appends an ES-module export to the upstream browser factory; it does not modify the compiled SQLite implementation. The underlying SQLite implementation is public domain. [Pinned wrapper source](https://github.com/sql-js/sql.js/tree/v1.15.2). `scripts/vendor-sqlite.mjs` records and reproduces these vendored files.

## Local segmentation runtime and weights

`web/vendor/onnx/` contains unmodified WASM CPU assets of onnxruntime-web 1.31.1, Microsoft and contributors (MIT). Its complete LICENSE and ThirdPartyNotices.txt retain embedded component notices/source references; preserve both in distributions. Actual included files are inventoried in manifest.json; unused npm providers are not claimed to be bundled.

`web/models/` contains unmodified U²-NetP ONNX from rembg v0.0.0 (U²-Net authors Xuebin Qin et al., Apache-2.0) and PPHumanSeg ONNX from OpenCV Zoo 48b10fa505aeb51fbd127fc60a5c660040e823b7 (Apache-2.0, Shenzhen Institute of Artificial Intelligence and Robotics for Society and contributors). Original licenses, model README/preprocessing source and exact URLs/sizes/digests are retained there.

Sky optionally downloads Xenova's unmodified conversion of Facebook DETR ResNet-50 panoptic at ea24b2d4e0bfae31f0a1299ba3fb892a2df064de, under the original model's Apache-2.0 terms. Original license/model card and licensed COCO taxonomy are retained in web/models/. The 172 MB FP32 weight is not duplicated in the application bundle. Model metadata does not replace these copyright/license notices. See [AI mask sources and verification](docs/ai-masks.md).

Depth range and lens blur optionally download the unmodified ONNX Community conversion of **Depth Anything V2 Small**, 27,258,801 bytes, fixed revision 4472b7362082ad9968fee890ca0f1e5aca36b93d. Small's original model terms are Apache-2.0; no Base/Large/Giant noncommercial weights are used. Original license and small-model card are retained as web/models/LICENSE.DepthAnythingV2 and README.DepthAnythingV2Small.md. Exact source revisions, preprocessing, recorded digest, actual CPU measurements and inference/blur limits are in [depth research](research/depth-tools.md) and [range/depth behavior](docs/range-depth-tools.md).

Enhance optionally downloads **Intel Open Image Denoise RT LDR Small** ONNX weights (© Intel Corporation, Apache-2.0) from pmndrs/denoiser-weights revision 24f30f6b04fc6e8c3b1b1993227d230d3a9344f1, and the **ONNX Model Zoo ESPCN super-resolution-10** weights (Apache-2.0) at revision 395472c4b6b92f788357237983d83fd913cfe7e3. The original weight licenses are retained as web/models/LICENSE.OIDN and LICENSE.ESPCN. Models are unmodified and downloaded only on use. Source model cards, digests, exact URLs, actual neural inference and ablations are recorded in [enhancement research](research/enhance.md). No Real-ESRGAN, noncommercial, or Adobe enhancement weight is included. Product behavior explicitly describes [8-bit raster enhancement](docs/enhance.md), not sensor RAW denoising.

NASA astronaut and SpaceX rocket fixtures are public-domain photographs from scikit-image v0.25.2. Exact sources/rights/digests are in tests/fixtures/ai/README.md; no Adobe or personal photo is used.

Face and eye landmarks for assisted culling and red-eye correction use YuNet, face_detection_yunet_2023mar.onnx, under the MIT license (Shiqi Yu). Unmodified weights and license are in web/models/. [Fixed model source](https://github.com/opencv/opencv_zoo/tree/48b10fa505aeb51fbd127fc60a5c660040e823b7/models/face_detection_yunet).

The packaged OpenLR icon uses the Lucide aperture glyph on an OpenLR background. Lucide notices are retained in web/vendor/icons/LICENSE.
