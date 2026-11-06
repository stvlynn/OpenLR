# HDR and panorama merging

Select at least two photos and choose **Merge photos**. The dialog lists the source order and offers HDR or a perspective panorama. A successful merge creates and selects a new imported-library photo; all source originals, edits, ratings, and versions remain unchanged. Local-folder sources are read from their authorized paths, and the result is added to Library. Source edit recipes are deliberately excluded from both merge algorithms.

The implementation and its limits are independent of Adobe's engine. Sources, dependency provenance, and static Lightroom evidence are recorded in [merge research](../research/photo-merge.md) and [third-party notices](../THIRD_PARTY_NOTICES.md).

## HDR

Use actual exposure brackets of the same scene. The dialog derives relative exposure from shutter time, aperture, and ISO when every source has those tags. Otherwise enter each source's brightness offset in EV, such as `-2, 0, 2`, in the displayed order. Positive EV means a brighter captured exposure. Do not enter a display adjustment made after capture as though it were a camera exposure.

RAW/DNG sources use the same LibRaw kernel and settings as ordinary decoding, with 16-bit output and a unit gamma curve for both paths. Ordinary decoding converts those samples to its standard sRGB display bitmap; fusion retains the linear samples. Camera white balance, linear sRGB output primaries, no automatic brightening, and fixed brightness remain shared. The linear samples are normalized against LibRaw's white point; this is processed linear camera RGB, not the untouched sensor mosaic. The 8-bit sRGB representation is used only for feature detection and clipping weights. Registration warps the linear Float32 RGB separately, so fusion does not recover RAW light values from an 8-bit preview.

For rendered image inputs, the algorithm assumes an sRGB transfer function. Arbitrary camera tone curves, local tone mapping, or inconsistent white balance can violate exposure calibration. Prefer RAW sources or consistently rendered sRGB brackets.

The exposure factor is proportional to `ExposureTime × ISO / FNumber²`, or `2^EV` for explicit offsets. ORB/Hamming matching and RANSAC estimate each source's homography into the middle exposure. The largest fully valid common rectangle is retained; a set sharing less than half the reference frame fails. Auto align can be disabled explicitly for identically framed tripod images; that mode requires equal source dimensions and does not fabricate a transform for a failed handheld alignment.

Each usable channel contributes its linear intensity divided by relative exposure, weighted toward unsaturated encoded values. Fusion retains a Float32 radiance buffer and values above display white. A consistency check rejects broad disagreement after exposure normalization. It is not motion-aware deghosting: moving objects may still cause local artifacts, and scenes with extensive motion should be rejected or recaptured. Samples clipped in every bracket cannot be recovered; their fraction appears in diagnostics.

The new catalog photo is a Reinhard tone-mapped PNG for normal editing and preview. **Export HDR radiance** or `export-hdr` exports the separately stored, scene-linear Radiance RGBE file before subsequent display edits. RGBE stores a shared exponent and eight-bit channel mantissas, preserving high dynamic range with its own quantization; it is not a 32-bit-per-channel EXR. This path does not add HDR monitor output, HDR DNG writing, or full-precision scene-linear slider editing to the display renderer.

## Panorama

Use overlapping, textured photographs with consistent exposure. Each source must reliably match a previously placed source in the listed order. ORB descriptors are matched with Hamming nearest-neighbor ratio tests; RANSAC rejects inconsistent correspondences. Matches confined to a tiny region, too few inliers, unstable homographies, and implausible scale changes fail explicitly.

The accepted projective transforms determine output bounds from the source corners. Each original is warped at full output resolution and feather-blended in linear light. The transform preserves genuine overlap; it does not concatenate frames or pad gaps with invented pixels. Uncovered output edges remain transparent. The projection is perspective only; spherical/cylindrical projection, camera bundle adjustment, content-aware fill, seam optimization, and parallax correction are not implemented. Moving subjects or strong parallax can create visible seams even when feature registration succeeds.

Feature analysis uses images with a maximum edge of 1,600 pixels, then expresses transforms in original-image coordinates. This is a registration sampling budget, not a source-file or output-size ceiling. Output, decoded frames, Float32 accumulators, and WASM heaps still require real RAM and supported canvas dimensions; allocation failures are surfaced.

## Runtime and command contract

`merge-core.js` owns the algorithms. `merge-kernel.js` loads the pinned local OpenCV runtime and is shared by `merge-worker.js` and the explicit startup fallback in `image-worker.js`. Heavy work runs in a short-lived worker where supported; startup failure records a diagnostic and runs the identical kernel with the retained input buffers. Native transport timeouts can expire before a very large job finishes; inspect state before retrying a merge.

```powershell
node cli/openlr.mjs schema merge-hdr
node cli/openlr.mjs select-many --ids '["photo-a","photo-b","photo-c"]'
node cli/openlr.mjs merge-hdr --evs '[-2,0,2]'
node cli/openlr.mjs export-hdr --output merged.hdr
node cli/openlr.mjs preview --output merged-preview.png
node cli/openlr.mjs merge-panorama --ids '["left-id","middle-id","right-id"]'
```

The optional `ids` array identifies a unique ordered list of visible source photos. When omitted, the current selection supplies that order. `merge-hdr` accepts optional `evs` and `align`; it requires complete exposure metadata if `evs` is omitted. Both merge commands return the new ID, dimensions, source IDs/names, transforms, match/inlier counts, and method diagnostics. They use the same dispatcher as the dialog and every other agent operation.

## Verification

`tests/merge.test.js` generates exposure-calibrated textured scenes and independently reads the emitted RGBE file. It checks displaced-bracket registration below two pixels, radiance above one and more than eight stops of recovered range, sampled radiance error below 12%, panorama geometry below three pixels, average channel error below 9/255, preserved sub-eight-bit differences on linear inputs, and calibration/nonoverlap/texture failures.

`tests/merge-workflow.test.js` runs the actual WASM worker in Chrome through multi-selection and the merge dialog, exports and reopens both results, verifies original-byte preservation, merges generated sensor DNGs through the real linear RAW decoder, and forces worker startup failure to exercise the shared kernel. Generated scenes test known geometry and radiometry; they are not a broad photographic quality benchmark.

Run `node scripts/native-integration-smoke.mjs /path/to/OpenLR` to verify the same generated scenes through the packaged desktop CLI. It decodes the written panorama PNG and checks color error in both overlaps and the outer scene bands, along with transparent edges. It reads the complete RGBE stream, compares sampled radiance to the generated scene, and checks the tone-mapped PNG. An edit changes the tone-mapped pixels while the exported radiance bytes stay identical. Source edits, ratings, versions and original bytes are checked after each merge.
