# Native public VideoEncoder configuration experiment

This is an unadopted diagnostic, separate from application encoding policy.
The observed ON trial 15 at `11578a7` accepted at least eight H.264 frames with
zero outputs before its CLI deadline. Its requested codec was `avc1.42400a`,
64×96, 25,000 bit/s, variable bitrate, discarded alpha and AVC-format chunks.
Framerate, latencyMode and hardwareAcceleration were absent. The actual native
backend was not observed. The OFF cohort passed 24/24; the same message or a
completed microprobe cannot retrospectively identify trial 15's backend/cause.

The probe uses public `VideoEncoder`/`VideoFrame` only. It supplies fifteen
generated solid-color frames at 100,000 µs timestamp/duration steps, closes each
submitted frame, and mirrors MediaBunny 1.65.1's post-encode queue gate: after
`encodeQueueSize >= 4`, await one public `dequeue`. No framerate field is added.
The quality/default arm leaves latencyMode and hardwareAcceleration absent;
the other arms request quality/software, realtime/software, realtime/default,
and quality/software with a public flush after each three submitted frames.
The five-arm order is followed by its reverse, with a fresh owned native host
and ephemeral profile for every one of the ten cases.

The flush-three arm varies scheduling relative to the otherwise identical
quality/software arm. The public VideoEncoder flush algorithm emits pending
outputs and keeps the encoder configured; it does not perform reset or impose
the decoder flush algorithm's new-key requirement. Only the first input
requests a keyframe. Actual output types/configurations are retained. This is
a configuration/scheduling causal test, not a production workaround.
[Encoder flush](https://www.w3.org/TR/webcodecs/#dom-videoencoder-flush) ·
[Configuration](https://www.w3.org/TR/webcodecs/#videoencoderconfig)

Hardware preferences may be ignored. `isConfigSupported` returns recognized
configuration fields and support, not backend identity. Realtime mode is
allowed to drop frames, so completing alone cannot qualify it for offline
export. Every successful arm must independently decode all fifteen frames at
the expected dimensions/timestamps and colors. No frame-count assertion is
weakened. [Hardware preference](https://www.w3.org/TR/webcodecs/#hardware-acceleration) ·
[Latency modes](https://www.w3.org/TR/webcodecs/#latency-mode)

The primary lead is WebKit commit
[`ada444cba9efa29f558720f887d8812b4921c576`](https://github.com/WebKit/WebKit/commit/ada444cba9efa29f558720f887d8812b4921c576)
(321682), describing a software H.264 buffering/queue-limit deadlock. It is a
source lead; neither installed-code identity nor backend identity is proved by
these public preferences.

## Preparation and execution

Use stock Go 1.27.3 and the repository's normal vendored dependency graph:

```sh
node scripts/build-native-encoder-probe.mjs build/native-encoder-probe
node scripts/native-encoder-probe.mjs build/native-encoder-probe /path/to/ffmpeg/bin
```

The builder uses `-trimpath -tags mygo_noinspector` and
`-ldflags '-s -w -X github.com/egoist/mygo.production=1'`, matching the ordinary
non-debug MyGo build's runtime and inspector settings. The authoritative pinned
implementation is `vendor/github.com/egoist/mygo/cmd/mygo/build.go` (production
link flags and `productionTags`). This remains a bare fixture executable, not
the packaged OpenLR application; application naming/update/package metadata is
not part of the comparison. Exact flags and Go build information are retained.

`GO_BINARY` selects the stock compiler. `GOOS=darwin GOARCH=arm64` permits a
compilation-only check elsewhere. Native execution requires actual macOS.
FFmpeg/ffprobe may instead be on PATH or selected by `OPENLR_FFMPEG_DIR`.
There is no provider, debugger, diagnostic SDK, private backend API, codec
fallback or application policy modification. The build retains provenance,
probe source, project AGPL-3.0-only text and dependency notices/licenses.
New fixture/script material is OpenLR-generated AGPL-3.0-only source; existing
Go/MyGo and MediaBunny licenses remain unchanged. No outside implementation is
copied.

Renderer setup, feeding and every flush have explicit observation deadlines.
Each report retains requested/supported configurations, absent fields, actual
callback chunks/configuration bytes, submitted/output counts, dequeue events,
queue/state samples, flush outcomes and error identity. A deadline is reported
as a timeout, never an encoder pass. The native host is bounded separately;
forced cleanup is distinguished from clean exit. Only the spawned host/group
is owned; launchd-owned WebKit helpers are outside the receipt. Further hosts
are not launched after unconfirmed cleanup. All results are retained and the
runner exits nonzero if any case lacks strict encoding/decode evidence.

The existing MediaBunny `EncodedVideoPacketSource` remuxes retained AVC chunks
into MP4 without re-encoding. FFmpeg then independently decodes actual frames,
and ffprobe supplies dimensions/timestamps. If the encoder omits chunk duration,
the remux uses the original input frame's known 100,000 µs duration and records
that fact; original callback fields remain in `report.json`. Partial outputs
remain partial failed outcomes even if they decode correctly. `.avc` files are
individual raw callback payloads in AVC length-prefixed format, not standalone
Annex-B streams. No independent Chrome oracle is involved.

Focused preparation checks:

```sh
node --test tests/native-encoder-probe.test.js tests/native-video-probe.test.js
```

The real FFmpeg remux/pixel-path test requires `OPENLR_FFMPEG_DIR`; without it
that one test is explicitly skipped. Controlled encoder doubles test reporting
and public scheduling semantics; they do not establish macOS encoder behavior.

`.github/workflows/macos-native-encoder.yml` runs on `macos-15` with stock Go
1.27.3, Node 24, `npm ci` and FFmpeg/ffprobe. It supports manual runs and pushes
that change its own file on `experiment/native-encoder-ablation`, has a
25-minute job limit, runs the focused real-FFmpeg checks, and always uploads
`build/native-encoder-probe`. The runner's strict nonzero result is preserved
when any case times out, drops frames, fails decoding or lacks cleanup proof.
