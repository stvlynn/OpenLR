"""Generate the OpenLR raw Opus fixture using libopus 1.4 on Linux."""

import ctypes as c
import json
import math
from pathlib import Path


opus = c.CDLL("libopus.so.0")
opus.opus_get_version_string.restype = c.c_char_p
opus.opus_encoder_create.argtypes = [c.c_int32, c.c_int, c.c_int, c.POINTER(c.c_int)]
opus.opus_encoder_create.restype = c.c_void_p
opus.opus_encoder_ctl.argtypes = [c.c_void_p, c.c_int]
opus.opus_encode_float.argtypes = [c.c_void_p, c.POINTER(c.c_float), c.c_int, c.POINTER(c.c_ubyte), c.c_int32]
opus.opus_encoder_destroy.argtypes = [c.c_void_p]
opus.opus_decoder_create.argtypes = [c.c_int32, c.c_int, c.POINTER(c.c_int)]
opus.opus_decoder_create.restype = c.c_void_p
opus.opus_decode_float.argtypes = [c.c_void_p, c.POINTER(c.c_ubyte), c.c_int32, c.POINTER(c.c_float), c.c_int, c.c_int]
opus.opus_decoder_destroy.argtypes = [c.c_void_p]
opus.opus_packet_get_nb_samples.argtypes = [c.POINTER(c.c_ubyte), c.c_int32, c.c_int32]
opus.opus_repacketizer_create.restype = c.c_void_p
opus.opus_repacketizer_cat.argtypes = [c.c_void_p, c.POINTER(c.c_ubyte), c.c_int32]
opus.opus_repacketizer_out.argtypes = [c.c_void_p, c.POINTER(c.c_ubyte), c.c_int32]
opus.opus_repacketizer_destroy.argtypes = [c.c_void_p]

RATE = 48000
MODES = {"silk": (1000, 1103, 30000), "hybrid": (1001, 1105, 64000), "celt": (1002, 1105, 96000)}


def packet_description(data, frames):
    config = data[0] >> 3
    mode = "silk" if config < 12 else "hybrid" if config < 16 else "celt"
    return {"mode": mode, "frames": frames, "data": bytes(data).hex()}


def encode(channels, schedule):
    error = c.c_int()
    state = opus.opus_encoder_create(RATE, channels, 2049, c.byref(error))
    assert state and error.value == 0
    packets = []
    start = 0
    out = (c.c_ubyte * 8192)()
    try:
        for mode, frames in schedule:
            mode_id, bandwidth, bitrate = MODES[mode]
            # The private force-mode control is used to generate fixtures only.
            for request, value in [(11002, mode_id), (4008, bandwidth), (4002, bitrate)]:
                assert opus.opus_encoder_ctl(state, request, c.c_int(value)) == 0
            pcm = (c.c_float * (frames * channels))()
            for frame in range(frames):
                t = (start + frame) / RATE
                for channel in range(channels):
                    tone = 0.17 * math.sin(2 * math.pi * (333, 777)[channel] * t)
                    chirp = 0.09 * math.sin(2 * math.pi * (571 * t + 521 * t * t))
                    pulse = 0.48 if (start + frame + channel * 43) % 3109 < 73 else 0
                    pcm[frame * channels + channel] = tone + chirp + pulse
            length = opus.opus_encode_float(state, pcm, frames, out, len(out))
            assert length > 0 and opus.opus_packet_get_nb_samples(out, length, RATE) == frames
            packets.append(packet_description(out[:length], frames))
            start += frames
        return packets
    finally:
        opus.opus_encoder_destroy(state)


def combine(packets):
    state = opus.opus_repacketizer_create()
    assert state
    try:
        # Keep each packet's input pointer valid until repacketization completes.
        inputs = [bytes.fromhex(packet["data"]) for packet in packets]
        buffers = [(c.c_ubyte * len(data)).from_buffer_copy(data) for data in inputs]
        for buffer in buffers:
            assert opus.opus_repacketizer_cat(state, buffer, len(buffer)) == 0
        out = (c.c_ubyte * 8192)()
        length = opus.opus_repacketizer_out(state, out, len(out))
        assert length > 0 and opus.opus_packet_get_nb_samples(out, length, RATE) == 5760
        return packet_description(out[:length], 5760)
    finally:
        opus.opus_repacketizer_destroy(state)


def reference_samples(channels, packets):
    error = c.c_int()
    state = opus.opus_decoder_create(RATE, channels, c.byref(error))
    assert state and error.value == 0
    pcm = (c.c_float * (5760 * channels))()
    audio = []
    try:
        for packet in packets:
            data = bytes.fromhex(packet["data"])
            buffer = (c.c_ubyte * len(data)).from_buffer_copy(data)
            frames = opus.opus_decode_float(state, buffer, len(buffer), pcm, 5760, 0)
            assert frames == packet["frames"]
            audio.extend(pcm[:frames * channels])
    finally:
        opus.opus_decoder_destroy(state)
    positions = [0, 121, 358, 701, 1433, 4031, 5187, 8456, 11119, 12671, len(audio) // channels - 1]
    return [[frame, audio[frame * channels:(frame + 1) * channels]] for frame in positions]


def fixture():
    version = opus.opus_get_version_string().decode()
    assert version == "libopus 1.4", version
    mixed = [(mode, 960) for mode in ["silk", "hybrid", "celt", "silk", "celt", "hybrid"] for _ in range(4)]
    variable = [("celt", size) for size in [120, 240, 480, 960, 1920, 2880] * 2 + [960] * 6]
    streams = []
    for name, channels, schedule in [("mono-mixed", 1, mixed), ("stereo-mixed", 2, mixed), ("celt-durations", 1, variable)]:
        packets = encode(channels, schedule)
        if name == "celt-durations":
            packets = packets[:-6] + [combine(packets[-6:])]
        assert {packet["mode"] for packet in packets} == {mode for mode, _ in schedule}
        streams.append({"name": name, "channels": channels, "packets": packets,
                        "referenceSamples": reference_samples(channels, packets)})
    return {"reference": version, "sampleRate": RATE, "streams": streams}


if __name__ == "__main__":
    path = Path(__file__).with_name("packets.json")
    path.write_text(json.dumps(fixture(), indent=2) + "\n", encoding="utf-8")
