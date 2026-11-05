"""Independent actual AVIF decode and CMS measurements; Pillow is test tooling."""
import io
import json
import os
from pathlib import Path

from PIL import Image, ImageCms, features

workspace = Path(__file__).resolve().parents[3]
fixtures = Path(os.environ.get("OPENLR_AVIF_BUILD_DIR", workspace / ".tools/codec-color/avif")) / "fixtures"
source = (fixtures / "source.rgba").read_bytes()
srgb = ImageCms.createProfile("sRGB")
records = []
for target in ["srgb", "display-p3", "adobe-rgb", "prophoto-rgb", "rec2020"]:
    image = Image.open(fixtures / f"{target}.avif")
    native = image.convert("RGBA")
    expected = (fixtures / f"{target}.rgba").read_bytes()
    assert native.size == (32, 24)
    assert native.tobytes() == expected, f"{target}: independent native pixels differ"
    icc = image.info.get("icc_profile")
    assert icc, f"{target}: independent decoder did not expose ICC"
    assert icc == (fixtures / f"{target}.icc").read_bytes(), f"{target}: independent ICC differs"
    profile = ImageCms.ImageCmsProfile(io.BytesIO(icc))
    managed = ImageCms.profileToProfile(native, profile, srgb, renderingIntent=1, outputMode="RGBA")
    # Quantization/gamut error is measured separately from codec losslessness.
    errors = [abs(value - source[index]) for index, value in enumerate(managed.tobytes()) if index % 4 != 3]
    alpha = managed.getchannel("A").tobytes()
    assert alpha == source[3::4], f"{target}: alpha changed"
    records.append({"space": target, "nativeMaxError": 0, "iccBytes": len(icc), "cmsMaxError": max(errors), "cmsMeanError": sum(errors) / len(errors)})
result = {"pillow": Image.__version__, "libavif": features.version("avif"), "littlecms": features.version("littlecms2"), "records": records}
(fixtures / "independent-cms.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(json.dumps(result, indent=2))
