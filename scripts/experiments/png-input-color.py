"""Valid generated PNGs only: native libpng raw samples plus LCMS float color reference."""
import ctypes as c
import ctypes.util
import json
import os
from pathlib import Path
import struct
import sys


def load_library(environment, name, pattern):
    explicit = os.environ.get(environment)
    candidates = [explicit] if explicit else []
    if not explicit:
        found = ctypes.util.find_library(name)
        if found:
            candidates.append(found)
        candidates.extend(str(p.resolve()) for p in Path('.tools/pw-browsers').glob(pattern))
    for candidate in candidates:
        try:
            return c.CDLL(candidate)
        except OSError:
            pass
    print(json.dumps({'unavailable': f'Native {name} not found; set {environment}'}))
    sys.exit(77)


png = load_library('OPENLR_LIBPNG_LIBRARY', 'png16', 'webkit-*/libpng16.dll')
cms = load_library('OPENLR_LCMS_LIBRARY', 'lcms2', 'webkit-*/lcms2-2.dll')


def api(library, name, arguments, result):
    function = getattr(library, name)
    function.argtypes = arguments
    function.restype = result
    return function


png_version = api(png, 'png_get_libpng_ver', [c.c_void_p], c.c_char_p)(None)
create_png = api(png, 'png_create_read_struct', [c.c_char_p, c.c_void_p, c.c_void_p, c.c_void_p], c.c_void_p)
create_info = api(png, 'png_create_info_struct', [c.c_void_p], c.c_void_p)
set_read = api(png, 'png_set_read_fn', [c.c_void_p, c.c_void_p, c.c_void_p], None)
read_info = api(png, 'png_read_info', [c.c_void_p, c.c_void_p], None)
get_rowbytes = api(png, 'png_get_rowbytes', [c.c_void_p, c.c_void_p], c.c_size_t)
get_height = api(png, 'png_get_image_height', [c.c_void_p, c.c_void_p], c.c_uint32)
get_gamma = api(png, 'png_get_gAMA', [c.c_void_p, c.c_void_p, c.POINTER(c.c_double)], c.c_uint32)
get_chrm = api(png, 'png_get_cHRM', [c.c_void_p, c.c_void_p] + [c.POINTER(c.c_double)] * 8, c.c_uint32)
read_image = api(png, 'png_read_image', [c.c_void_p, c.POINTER(c.c_void_p)], None)
read_end = api(png, 'png_read_end', [c.c_void_p, c.c_void_p], None)
destroy_png = api(png, 'png_destroy_read_struct', [c.POINTER(c.c_void_p), c.POINTER(c.c_void_p), c.c_void_p], None)


def decode_raw(encoded):
    raw = c.create_string_buffer(bytes(encoded))
    cursor = 0
    reader_type = c.CFUNCTYPE(None, c.c_void_p, c.c_void_p, c.c_size_t)

    @reader_type
    def reader(_png, destination, size):
        nonlocal cursor
        assert cursor + size <= len(encoded)
        c.memmove(destination, c.addressof(raw) + cursor, size)
        cursor += size

    handle, info = c.c_void_p(create_png(png_version, None, None, None)), c.c_void_p()
    assert handle
    info.value = create_info(handle)
    try:
        set_read(handle, None, reader)
        read_info(handle, info)
        gamma = c.c_double()
        has_gamma = get_gamma(handle, info, c.byref(gamma))
        chrm = [c.c_double() for _ in range(8)]
        has_chrm = get_chrm(handle, info, *[c.byref(value) for value in chrm])
        stride, height = get_rowbytes(handle, info), get_height(handle, info)
        storage = (c.c_ubyte * (stride * height))()
        rows = (c.c_void_p * height)(*[c.addressof(storage) + row * stride for row in range(height)])
        # No png_set_gamma, alpha mode, strip16, shift/sBIT, or premultiplication.
        read_image(handle, rows)
        read_end(handle, None)
        words = list(struct.unpack('>' + 'H' * (len(storage) // 2), bytes(storage)))
        return words, gamma.value if has_gamma else None, [value.value for value in chrm] if has_chrm else None
    finally:
        destroy_png(c.byref(handle), c.byref(info), None)


class xyY(c.Structure):
    _fields_ = [('x', c.c_double), ('y', c.c_double), ('Y', c.c_double)]


class Primaries(c.Structure):
    _fields_ = [('red', xyY), ('green', xyY), ('blue', xyY)]


build_gamma = api(cms, 'cmsBuildGamma', [c.c_void_p, c.c_double], c.c_void_p)
create_rgb = api(cms, 'cmsCreateRGBProfile', [c.POINTER(xyY), c.POINTER(Primaries), c.POINTER(c.c_void_p)], c.c_void_p)
open_profile = api(cms, 'cmsOpenProfileFromMem', [c.c_void_p, c.c_uint32], c.c_void_p)
free_curve = api(cms, 'cmsFreeToneCurve', [c.c_void_p], None)
create_transform = api(cms, 'cmsCreateTransform', [c.c_void_p, c.c_uint32, c.c_void_p, c.c_uint32, c.c_uint32, c.c_uint32], c.c_void_p)
run_transform = api(cms, 'cmsDoTransform', [c.c_void_p, c.c_void_p, c.c_void_p, c.c_uint32], None)
delete_transform = api(cms, 'cmsDeleteTransform', [c.c_void_p], None)
close_profile = api(cms, 'cmsCloseProfile', [c.c_void_p], c.c_int)


def rgb_profile(chrm, exponent):
    white = xyY(*chrm['white'], 1)
    primaries = Primaries(*[xyY(*chrm[key], 1) for key in ['red', 'green', 'blue']])
    curve = build_gamma(None, exponent)
    try:
        return create_rgb(c.byref(white), c.byref(primaries), (c.c_void_p * 3)(curve, curve, curve))
    finally:
        free_curve(curve)


def float_format(space, channels):
    return (1 << 22) | (space << 16) | (channels << 3) | 4


payload = json.load(sys.stdin)
target = rgb_profile(payload['srgbChromaticities'], 1)
assert target
metrics = {}
try:
    for case in payload['cases']:
        words, gamma, chrm = decode_raw(case['png'])
        assert words == case['words'], (case['name'], 'native PNG raw sample mismatch')
        if case.get('profile'):
            raw_profile = c.create_string_buffer(bytes(case['profile']))
            source = open_profile(raw_profile, len(case['profile']))
            channels, space = 1, 3
        else:
            assert gamma == case['gamma'], (case['name'], gamma)
            expected_chrm = [v for key in ['white', 'red', 'green', 'blue'] for v in case['chromaticities'][key]]
            assert max(abs(a - b) for a, b in zip(chrm, expected_chrm)) < 1e-12
            source = rgb_profile(case['chromaticities'], 1 / gamma)
            channels, space = 3, 4
        assert source
        transform = create_transform(source, float_format(space, channels), target, float_format(4, 3), 1, 0x140)
        assert transform
        try:
            samples = [v for color in case['input'] for v in color[:channels]]
            data = (c.c_float * len(samples))(*samples)
            output = (c.c_float * (len(case['input']) * 3))()
            run_transform(transform, data, output, len(case['input']))
            errors = [abs(output[i * 3 + j] - color[j]) for i, color in enumerate(case['expected']) for j in range(3)]
            maximum = max(errors)
            tolerance = 8e-5 if case['name'].startswith('gray-table') else 2e-6
            assert maximum <= tolerance, (case['name'], maximum, tolerance)
            metrics[case['name']] = {'maxLinearSrgbError': maximum, 'samples': len(case['input']), 'raw16Exact': True}
        finally:
            delete_transform(transform)
            close_profile(source)
finally:
    close_profile(target)
print(json.dumps({'libpng': png_version.decode(), 'lcms': api(cms, 'cmsGetEncodedCMMversion', [], c.c_uint32)(), 'metrics': metrics}))
