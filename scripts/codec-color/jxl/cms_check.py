"""Independent Pillow/Little CMS interpretation of actual decoded JXL data."""
import io
import json
import pathlib
import sys
from PIL import Image, ImageCms, features

directory = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else
                         ".tools/codec-color/jxl/experiment")
report = json.loads((directory / "results.json").read_text())
size = (report["width"], report["height"])
source = Image.frombytes("RGBA", size, (directory / "source.rgba").read_bytes()).convert("RGB")
srgb = ImageCms.createProfile("sRGB")
measurements = []
for row in report["results"]:
    stem = f'{row["space"]}-{row["quality"]}-{"modular" if row["modular"] else "vardct"}'
    profile = ImageCms.ImageCmsProfile(io.BytesIO((directory / (stem + ".icc")).read_bytes()))
    decoded = Image.frombytes("RGBA", size, (directory / (stem + ".rgba")).read_bytes()).convert("RGB")
    transform = ImageCms.buildTransformFromOpenProfiles(profile, srgb, "RGB", "RGB",
        renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
        flags=ImageCms.Flags.NOOPTIMIZE)
    appearance = ImageCms.applyTransform(decoded, transform).tobytes()
    original = source.tobytes()
    errors = sorted(abs(a - b) for a, b in zip(appearance, original))
    # The negative control interprets unconverted sRGB numbers as target samples.
    wrong = ImageCms.applyTransform(source, transform).tobytes()
    wrong_errors = [abs(a - b) for a, b in zip(wrong, original)]
    measurements.append({"space": row["space"], "quality": row["quality"],
        "modular": row["modular"], "profile": ImageCms.getProfileDescription(profile).strip(),
        "meanRGB": sum(errors) / len(errors), "p99RGB": errors[int(len(errors) * .99)],
        "maxRGB": errors[-1], "labelOnlyMeanRGB": sum(wrong_errors) / len(wrong_errors)})
output = {"pillow": features.version("pil"), "lcms": features.version("littlecms2"),
          "measurements": measurements}
(directory / "cms-results.json").write_text(json.dumps(output, indent=2) + "\n")
print(json.dumps(output, indent=2))
