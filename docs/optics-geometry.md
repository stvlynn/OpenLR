# Optics and geometry

The **Optics & geometry** panel applies actual lens and projective corrections to still photos. It offers manual radial distortion, red/cyan and blue/yellow transverse chromatic aberration (TCA), vertical/horizontal perspective, straightening angle, horizontal skew, aspect, scale and offsets. Transparent uncovered pixels remain transparent. Crop and scale can remove unwanted edges; OpenLR does not synthesize missing image content.

**Match EXIF** lists exact camera/lens candidates from the bundled Lensfun subset. Review the lens, actual focal length in millimeters and camera crop factor, then press **Apply profile**. Matching does not analyze or calibrate an unknown lens. Missing or unsupported EXIF produces no invented match. The older CIFF Canon G1 test fixture, for example, requires manual profile selection because the current EXIF reader does not expose its camera tags.

The subset contains 344 camera records and 449 rectilinear profiles from Canon compact, Canon/Nikon SLR and Sony mirrorless source files. Only supported distortion and TCA samples are exposed. Fisheye, ACM, vignetting, optical-center offsets and unsupported model types are excluded. This is a documented subset, not the complete Lensfun database or a binding to Lensfun's C++ library.

Profile application selects an exact calibration sample or linearly interpolates coefficients between adjacent samples of the same model. It rejects extrapolation beyond the available focal range and rejects a sensor larger than the calibrated coverage. Distortion and TCA may have different sample ranges; unavailable components remain disabled and the UI reports missing TCA. Stored recipes retain the applied coefficient snapshot, source path, commit and license, so a later database update does not silently change existing edits.

**Draw straighten line** accepts two actual image points on a horizontal or vertical reference. It solves a rotation from that line, accounting for existing perspective, crop, reflection and quarter-turn rotation. There is no automatic scene inference. Commands reject coincident points, folded radial mappings and projective horizons crossing the canvas.

## Rendering and coordinates

`web/optics.js` compiles one mapping shared by image resampling, local-tool input and overlays. The pipeline is original-image local masks/repair, lens/TCA and geometry, crop/quarter-turn/reflection, then global color rendering. Crop fractions refer to the corrected base canvas, which retains the original image bounds.

The forward geometric homography applies perspective, horizontal shear, aspect/scale, rotation and translation in that order. Rendering uses its inverse and the calibrated radial map to sample the original. Red and blue have separate TCA sampling locations. Bilinear interpolation operates in linear light with alpha weighting; coordinates outside the original produce transparency. Preview resampling may use a smaller source canvas, while export uses full resolution. This pipeline uses the rendered decoder surface; it does not modify sensor mosaics or claim additional RAW precision.

Brush/repair coordinates remain normalized original-image positions. Pointer input reverses crop/turn/reflection and then lens/geometry; transparent-edge input is ignored. Mask overlays follow the same spatial warp, with green/reference geometry rather than channel-dependent TCA. Saved versions, local sidecars and OpenLR's XMP recipe preserve the optics branch. XMP import validates it separately from crop and local-tool settings.

## Shared commands

The CLI, UI and live agent all use `web/agent-protocol.js` and the same dispatcher. Examples:

```sh
node cli/openlr.mjs lens-profiles --query "PowerShot G1"
node cli/openlr.mjs lens-match
node cli/openlr.mjs lens-apply --id compact-canon:5:0 --focal 14.6 --cropFactor 4.843
node cli/openlr.mjs optics --changes '{"vertical":8,"rotate":2.5,"scale":110}'
node cli/openlr.mjs optics --changes '{"profileTCA":false}'
node cli/openlr.mjs straighten --start '{"x":0.2,"y":0.3}' --end '{"x":0.8,"y":0.4}' --axis horizontal
node cli/openlr.mjs preview --output corrected.png
node cli/openlr.mjs optics-reset
```

Profile IDs are database-revision identifiers; discover them instead of assuming that an ID matches arbitrary camera hardware. `straighten` points are original-image coordinates in 0..1; `straighten-tool` starts the GUI reference picker. Use command help/schema for accepted ranges.

## Sources and verification

Lensfun calibration data and the generated `web/lens-data.js` adaptation retain **CC BY-SA 3.0**. The four unchanged upstream XML files, complete license, attribution and hash inventory are in `web/vendor/lensfun/`. The renderer is separate OpenLR project code. `node scripts/vendor-lensfun.mjs` regenerates the supported subset from those retained sources without a network request. Preserve its attribution and ShareAlike license when distributing modified calibration data. See [third-party notices](../THIRD_PARTY_NOTICES.md) and [research evidence](../research/optics-geometry.md).

Run `node --test tests/optics.test.js tests/optics-workflow.test.js`. The numerical tests use independently generated barrel-distorted line grids, simulated channel magnification and projective keystone frames. They measure corrected lines and color separation, verify transparent edges and invalid transforms, check real calibration/interpolation values, and round-trip local coordinates through crop/reflection/all quarter-turns. Browser E2E imports a genuine CRW, applies a selected calibrated profile, checks changed preview pixels, draws an original-coordinate brush and straightening reference through transformed geometry, validates XMP round-trip and reload persistence. These tests establish model behavior; they do not establish measured optical accuracy for every physical lens, focus distance or RAW decoder crop.
