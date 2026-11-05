# Local model-assisted masks

Open **Masks & local repair**, choose an **AI selection** target and press **Generate AI mask**. The result is a selected soft mask with **zero initial adjustments**: selecting Subject or Person alone does not brighten the photo. The red coverage overlay shows the actual inference result. Use **Show overlay (O)** or O to hide/show it, then adjust exposure, contrast or saturation. Opacity, inversion, disabling, removal, undo and persistence use the same local rendering path. Overlay visibility is presentation only and never enters exported pixels. Explicit CLI `adjustments` remain supported. Original photos are unchanged.

| Target | Actual inference | Delivery |
| --- | --- | --- |
| Subject | U²-NetP salient-object detection | Bundled 4,574,861-byte ONNX |
| Person | PPHumanSeg two-class semantic segmentation | Bundled 6,163,938-byte ONNX |
| Sky | FP32 DETR ResNet-50 panoptic, original COCO category **187: sky-other-merged** | Fixed 172,282,717-byte ONNX downloaded on first use and cached |
| Background | Complement of Subject saliency | Reuses U²-NetP; no duplicate model |

These are real model outputs, not color thresholds or hardcoded silhouettes. Subject may include nearby prominent objects; Person answers a different semantic question. Background specifically complements Subject, rather than claiming all providers share one background taxonomy.

## Runtime and storage

Successful `ai-mask` generation finishes any local drawing gesture, switches the local tool to Navigate (`off`) and selects the generated mask with its overlay visible before notifying observers. GUI and CLI share this transition. The local panel's open state is preserved, so generating from its button leaves adjustments accessible; the cursor agrees with the finished tool mode. A failed generation does not perform this success transition.

`ai-models.js` owns fixed model versions/contracts. `ai-runtime.js` uses ONNX Runtime Web 1.31.1, WASM CPU, one thread. Only its matching WASM entry, loader and 14,848,852-byte WASM binary are bundled. No remote inference service, runtime CDN or unmeasured GPU acceleration is used.

`ai-kernel.js` / `sky-kernel.js` are shared by the Worker and native-host startup fallback. Normal jobs terminate their Workers and release sessions/heaps. Main-thread fallback can retain a reusable session and block the UI; see [codec lifecycle](image-codecs.md). UI and CLI use the same application queue and photo/edit identity guards.

Subject uses 320×320 RGB, image-maximum scaling and ImageNet mean/std. Person uses 192×192 RGB and `(pixel/255 - 0.5)/0.5`. Sky preserves aspect ratio at a 512-pixel short edge, capped at a 1024-pixel long edge, with ImageNet normalization. This is inference resolution, not an import/file-size ceiling. The export's declared pixel-mask shape is honored and filled with valid pixels because no padding is introduced.

Sky class scores use softmax; accepted nonempty queries have winning-class confidence ≥0.5. Their mask logits compete by per-pixel softmax across accepted queries; probabilities of sky queries are summed into a soft sky map. This follows panoptic query competition rather than independently applying sigmoid masks. No sky query yields a zero mask, not a heuristic substitute. U²-Net uses its fused first output with upstream min–max saliency normalization. PPHumanSeg probabilities remain soft; Background complements saliency.

Sky bytes are stored once in `openlr-models` IndexedDB under a `sky` manifest and 16 MB ArrayBuffer chunks. Atomic version replacement deletes old chunks. This supports ephemeral WKWebView without Blob writes and avoids Chromium's single-record ArrayBuffer serialization limit; existing Blob/ArrayBuffer records remain readable. Model fetches use `cache: no-store` to avoid a second HTTP disk-cache copy. The large weight is absent from the application bundle. `.tools/ai-models/detr-fp32.onnx` is an ignored research copy for offline evaluation, not a production runtime dependency. Photos never go to the model host. First-download, storage, parse and allocation failures are visible. Offline Sky use requires a completed first download.

Versions are identified by fixed commit/release URLs. SHA-256 values in provenance/experiment records are observations, **not model-load gates**. There is no digest allowlist check.

## Original-coordinate soft masks and CLI

Output probabilities become 0–255 soft samples in a portable `base64-u8` raster covering the normalized decoded original. The renderer bilinearly samples it before crop/rotation/flip. Inference need not rerun for exposure changes, geometry, export, undo or restart. The raster, target, model revision and preprocessing metadata persist in `edit.localTools.masks` and travel with copied recipes and saved versions.

```powershell
node cli/openlr.mjs schema ai-mask
node cli/openlr.mjs ai-mask --target person --dry-run
node cli/openlr.mjs ai-mask --target subject
node cli/openlr.mjs ai-mask --target sky
node cli/openlr.mjs ai-mask --target background --args '{"adjustments":{"Exposure":0.5}}'
node cli/openlr.mjs state
node cli/openlr.mjs mask.update --args '{"id":"ID from state","changes":{"opacity":0.7,"adjustments":{"Exposure":1}}}'
```

The result includes the mask ID and timing breakdown; `state` includes its raster/provenance. Optional `photoId` rejects a request after selection changes. Unsupported targets fail visibly.

## Rights and build provenance

| Artifact | Source / retained rights |
| --- | --- |
| U²-NetP | Unmodified rembg v0.0.0 release ONNX; U²-Net authors Xuebin Qin et al., Apache-2.0. Original source revision `ac7e1c817ecab7c7dff5ce6b1abba61cd213ff29`. `web/models/LICENSE.U2NET`. |
| PPHumanSeg | OpenCV Zoo `48b10fa505aeb51fbd127fc60a5c660040e823b7`; its directory explicitly licenses all files, including weights, Apache-2.0. Copyright 2021 Shenzhen Institute of Artificial Intelligence and Robotics for Society and contributors. Model README, license and preprocessing source retained. |
| DETR panoptic | Facebook model card declares Apache-2.0; unmodified Xenova FP32 ONNX `ea24b2d4e0bfae31f0a1299ba3fb892a2df064de`. Original DETR license/model card and licensed COCO panoptic taxonomy retained. |
| ONNX Runtime Web | npm 1.31.1, Microsoft and contributors, MIT. Full LICENSE and ThirdPartyNotices.txt in `web/vendor/onnx/`; embedded components retain their notices/source references. |

Exact URLs/sizes/digests are in `web/models/manifest.json`, `web/models/notices.json`, `research/ai/candidates.json` and `research/ai/sky-weight.json`; runtime inventory is `web/vendor/onnx/manifest.json`. No model/runtime binary was modified. `scripts/vendor-ai.mjs` copies selected local runtime assets; `scripts/fetch-ai-models.mjs` downloads the two small weights from versioned sources; `scripts/fetch-ai-notices.mjs` retains notices. `scripts/fetch-sky-research.mjs` explicitly fetches the optional research weight once. Full/FP16 variants are not redundantly bundled.

NVIDIA SegFormer was rejected because its original license limits use to non-commercial research/evaluation, regardless of mirror metadata. MIT sky-specific U²-Net alternatives were investigated at fixed revisions (175,997,079 / 88,084,505 bytes); the FP32 panoptic model was selected after actual quantization and resolution ablations. See [the experiment record](../research/ai-masks.md).

## Verification and limitations

`node --test tests/ai-mask.test.js` uses real models for UI generation, local pixel changes, original preservation, persistence, soft sampling, Subject/Background complement and shared-kernel startup fallback. Its optional sky subtest verifies original category 187 and one download followed by cache reuse across reload. A checkout without the optional research weight explicitly skips that named subtest; run `node scripts/fetch-sky-research.mjs` first to enable it offline.

`node scripts/benchmark-ai.mjs` records cold/warm timings and normalization/resolution ablations on public-domain NASA/SpaceX fixtures, with numerical records and a visual comparison in `research/ai/`. These two images and manual region probes are not a dense ground-truth or validation-set IoU evaluation. Fine hair, small objects, towers/wires, low light and unusual images remain difficult. Review the overlay. Browser evidence does not alone prove every native WebView/provider; native checks belong to the application integration suite.
