"""Independent LCMS reference for decoded JPEG XL DATA-profile Float32 samples."""
import ctypes as c
import ctypes.util
import json
import os
from pathlib import Path
import sys

candidate = os.environ.get('OPENLR_LCMS_LIBRARY') or ctypes.util.find_library('lcms2')
if not candidate:
    candidate = next((str(p.resolve()) for p in Path('.tools/pw-browsers').glob('webkit-*/lcms2-2.dll')), None)
if not candidate:
    print(json.dumps({'unavailable': 'Native LCMS missing; set OPENLR_LCMS_LIBRARY'}))
    sys.exit(77)
library = c.CDLL(candidate)


def api(name, arguments, result):
    function = getattr(library, name)
    function.argtypes = arguments
    function.restype = result
    return function


class xyY(c.Structure):
    _fields_ = [('x', c.c_double), ('y', c.c_double), ('Y', c.c_double)]


class Primaries(c.Structure):
    _fields_ = [('red', xyY), ('green', xyY), ('blue', xyY)]


open_profile = api('cmsOpenProfileFromMem', [c.c_void_p, c.c_uint32], c.c_void_p)
build_gamma = api('cmsBuildGamma', [c.c_void_p, c.c_double], c.c_void_p)
create_rgb = api('cmsCreateRGBProfile', [c.POINTER(xyY), c.POINTER(Primaries), c.POINTER(c.c_void_p)], c.c_void_p)
free_curve = api('cmsFreeToneCurve', [c.c_void_p], None)
close_profile = api('cmsCloseProfile', [c.c_void_p], c.c_int)
create_transform = api('cmsCreateTransform', [c.c_void_p, c.c_uint32, c.c_void_p, c.c_uint32, c.c_uint32, c.c_uint32], c.c_void_p)
run = api('cmsDoTransform', [c.c_void_p, c.c_void_p, c.c_void_p, c.c_uint32], None)
delete_transform = api('cmsDeleteTransform', [c.c_void_p], None)
white, primaries = xyY(.3127, .329, 1), Primaries(xyY(.64, .33, 1), xyY(.3, .6, 1), xyY(.15, .06, 1))
curve = build_gamma(None, 1)
target = create_rgb(c.byref(white), c.byref(primaries), (c.c_void_p * 3)(curve, curve, curve))
free_curve(curve)
assert target
payload = json.load(sys.stdin)
metrics = {}
try:
    for case in payload['cases']:
        raw = c.create_string_buffer(bytes(case['profile']))
        source = open_profile(raw, len(case['profile']))
        assert source, case['name']
        gray = bytes(case['profile'][16:20]) == b'GRAY'
        channels, space = (1, 3) if gray else (3, 4)
        rgb_float = (1 << 22) | (4 << 16) | (3 << 3) | 4
        source_float = (1 << 22) | (space << 16) | (channels << 3) | 4
        transform = create_transform(source, source_float, target, rgb_float, case.get('intent', 1), 0x140)
        assert transform, case['name']
        try:
            values = [value for pixel in case['input'] for value in pixel[:channels]]
            input_buffer = (c.c_float * len(values))(*values)
            output = (c.c_float * (len(case['input']) * 3))()
            run(transform, input_buffer, output, len(case['input']))
            errors = [abs(output[i * 3 + channel] - pixel[channel]) for i, pixel in enumerate(case['expected']) for channel in range(3)]
            metrics[case['name']] = {'maxLinearSrgbError': max(errors), 'meanLinearSrgbError': sum(errors) / len(errors), 'samples': len(case['input']), 'intent': case.get('intent', 1), 'firstReference': list(output)[:9]}
        finally:
            delete_transform(transform)
            close_profile(source)
finally:
    close_profile(target)
print(json.dumps({'lcms': api('cmsGetEncodedCMMversion', [], c.c_uint32)(), 'metrics': metrics}))
