"""Independent native LCMS float reference; validation tooling, never a runtime dependency."""
import ctypes as c
import ctypes.util
import json
import os
from pathlib import Path
import sys


def load_library():
    explicit = os.environ.get("OPENLR_LCMS_LIBRARY")
    candidates = [explicit] if explicit else []
    if not explicit:
        found = ctypes.util.find_library("lcms2")
        if found:
            candidates.append(found)
        candidates.extend(str(p.resolve()) for p in Path(".tools/pw-browsers").glob("webkit-*/lcms2-2.dll"))
    errors = []
    for candidate in candidates:
        try:
            library = c.CDLL(candidate)
            getattr(library, "cmsCreateTransform")
            return library
        except (OSError, AttributeError) as error:
            errors.append(str(error))
    print(json.dumps({"unavailable": "Native LCMS not found; set OPENLR_LCMS_LIBRARY", "errors": errors}))
    sys.exit(77)


library = load_library()


def api(name, arguments, result):
    function = getattr(library, name)
    function.argtypes = arguments
    function.restype = result
    return function


open_profile = api("cmsOpenProfileFromMem", [c.c_void_p, c.c_uint32], c.c_void_p)
create_xyz = api("cmsCreateXYZProfile", [], c.c_void_p)
create_transform = api("cmsCreateTransform", [c.c_void_p, c.c_uint32, c.c_void_p, c.c_uint32, c.c_uint32, c.c_uint32], c.c_void_p)
run_transform = api("cmsDoTransform", [c.c_void_p, c.c_void_p, c.c_void_p, c.c_uint32], None)
delete_transform = api("cmsDeleteTransform", [c.c_void_p], None)
close_profile = api("cmsCloseProfile", [c.c_void_p], c.c_int)
version = api("cmsGetEncodedCMMversion", [], c.c_uint32)()

# LCMS 2 public header: FLOAT_SH(1)|COLORSPACE_SH(PT_RGB/PT_XYZ)|CHANNELS_SH(3)|BYTES_SH(4).
def float_format(space):
    return (1 << 22) | (space << 16) | (3 << 3) | 4


payload = json.load(sys.stdin)
colors = payload["colors"]
values = [value for color in colors for value in color]
source = (c.c_float * len(values))(*values)
xyz_profile = create_xyz()
assert xyz_profile
metrics = {}
try:
    for name, encoded in payload["profiles"].items():
        raw = c.create_string_buffer(bytes(encoded))
        profile = open_profile(raw, len(encoded))
        assert profile, name
        transform = None
        try:
            # Relative colorimetric (1), NOOPTIMIZE (0x100), NOCACHE (0x40); no BPC.
            transform = create_transform(profile, float_format(4), xyz_profile, float_format(9), 1, 0x140)
            assert transform, name
            output = (c.c_float * len(values))()
            run_transform(transform, source, output, len(colors))
            matrix = payload["xyzToLinearSrgb"]
            errors = []
            for index, expected in enumerate(payload["expected"][name]):
                xyz = output[index * 3:index * 3 + 3]
                reference = [sum(matrix[row * 3 + col] * xyz[col] for col in range(3)) for row in range(3)]
                errors.extend(abs(reference[channel] - expected[channel]) for channel in range(3))
            maximum = max(errors)
            tolerance = 8e-5 if name.startswith("table-") else 5e-7
            assert maximum <= tolerance, (name, maximum, tolerance)
            metrics[name] = {"maxLinearSrgbError": maximum, "meanLinearSrgbError": sum(errors) / len(errors), "tolerance": tolerance}
        finally:
            if transform:
                delete_transform(transform)
            close_profile(profile)
finally:
    close_profile(xyz_profile)
print(json.dumps({"lcms": version, "samples": len(colors), "metrics": metrics}))
