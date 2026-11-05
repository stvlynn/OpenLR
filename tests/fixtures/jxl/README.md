# Generated JPEG XL input fixtures

These small original OpenLR images are generated from deterministic numeric samples in [jxl-input.mjs](../jxl-input.mjs), not photographs or third-party assets. Their source and generated files follow the repository license. They exercise integer/FLOAT source precision, signed wide color, GRAY and LUT ICCs, alpha, orientation, and a first animation frame.

The separate validation-only public libjxl encoder reproduces them:

```powershell
node scripts/experiments/jxl-input-color.mjs --generate
```

See [the research record](../../../research/jxl-input-color.md) and [tool build instructions](../../../scripts/codec-color/jxl/README.md). Validation encoder/inspector WASM and native LCMS are reproduction tools only; normal browser/CI tests read the committed `.jxl` files offline.

`metadata.json` records pinned revisions, actual decoder source declarations, pre-CMS and working ranges/sample prefixes, and independent LCMS version/intent/reference measurements. Sample definitions remain in the shared generator rather than repeated large JSON arrays. It also records the known small-width FLOAT roundtrip limitation. Manifest values describe that recorded toolchain, not a general bit-exact promise across compilers or CMS implementations. The undefined XYZ `mft1`, structured HDR, and out-of-domain table cases intentionally produce explicit display compatibility.
