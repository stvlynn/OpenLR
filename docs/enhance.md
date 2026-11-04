# Local neural Enhance / Denoise

Select a photo and press **Enhance / Denoise**. Choose **AI raster denoise · OIDN** or **AI super resolution · 3×**, set strength, and create an enhanced copy. Both operations perform real ONNX neural inference locally. They create a new 8-bit sRGB PNG from the **current edited raster**, including crop and local/global edits. Source files and their edit recipes stay available. The new photo starts with an empty edit recipe because source edits are already baked into its pixels; its provenance records the source ID/name, source edit snapshot, model revision, scale, strength and timings.

**This is not sensor RAW denoising.** A RAW input first follows the existing LibRaw display decode and raster edit path. The operation does not process Bayer/X-Trans sensor samples, recover higher RAW bit depth, perform joint neural demosaicing, or produce an enhanced RAW/DNG. Traditional Noise reduction remains a separate ordinary image-processing control; it is not labeled as AI.

| Operation | Actual licensed model | Download and output |
| --- | --- | --- |
| Denoise | Intel Open Image Denoise RT LDR Small, unmodified pmndrs ONNX conversion, Apache-2.0 | 1,272,337 bytes; same dimensions |
| Super resolution | ONNX Model Zoo ESPCN sub-pixel CNN, Apache-2.0 | 240,078 bytes; 3× width and height |

Only the selected small model downloads on first use. Fixed commit URLs, original weight licenses and source model cards are recorded in [enhancement research](../research/enhance.md). The shared `openlr-models` ArrayBuffer-chunk cache stores one version per provider, replaces old chunks atomically, supports ephemeral WebView hosts, and avoids a duplicate HTTP disk-cache copy. Models are absent from the application bundle. Digests are observational provenance, not download gates. Photos are not sent to either model host. Offline inference needs a completed first download.

Denoise converts decoded sRGB to linear RGB, runs the LDR U-Net, converts back to sRGB and blends by strength. The model was trained for rendered/ray-traced noise, rather than camera sensor RAW noise. It reduces the tested added-noise fixture but may soften fine detail, alter real camera noise, or fail on a different noise distribution. The explicit no-transfer ablation scored better on one sRGB Gaussian fixture; production follows the inspected adapter's linear-input contract, not a fixture-tuned exception.

ESPCN predicts 3× full-range BT.601 luminance. Color differences and alpha are interpolated from the source; strength blends learned luminance with the interpolation baseline. This is a small learned reconstruction model, not a face-restoration or generative-detail service. The actual graph has fixed 224×224 input, despite the model card describing dynamic sizes. OpenLR pads/tiles to that real shape without resizing the whole photograph or rewriting the graph.

Both kernels process bounded tiles while retaining the original image dimensions. Denoise uses 256-pixel cores, a 64-pixel reflected context halo and 16-pixel network alignment. ESPCN uses up to 208-pixel cores and an 8-pixel halo inside the required 224-pixel graph. Context is discarded when each core is copied into the output. Alpha is preserved at original or interpolated output coordinates. Total work/output memory still scale with the photograph and 3× super resolution produces nine times as many pixels. Allocation and model errors are visible; there is no arbitrary import or photo-size ceiling. Worker progress resets the shared two-minute inactivity watchdog between tiles. Startup failures use the **same** inference kernel on the main thread, which can block the interface; model-processing errors do not switch to a fake smoothing algorithm.

```powershell
node cli/openlr.mjs enhance --mode denoise --strength 0.7
node cli/openlr.mjs enhance --mode super-resolution --strength 1
```

The UI and CLI share the serialized command dispatcher, selected-photo guards and derived-photo storage. `tests/enhance.test.js` exercises actual model UI inference, known-noise improvement, original byte preservation, 3× PNG dimensions, source edit provenance, model reuse after restart and shared-kernel fallback. Optional-weight tests explicitly skip if ignored research weights are absent; prepare them with `node scripts/fetch-enhance-research.mjs`. `scripts/benchmark-enhance.mjs` records the actual normalization, tile and interpolation ablations; it is not a validation-set quality guarantee.
