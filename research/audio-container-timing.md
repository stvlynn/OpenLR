# Audio container timing

MediaBunny 1.65.1 sends encoded packets unchanged to a custom decoder. Only its WebCodecs branch sets `expectedFirstTimestamp` and offsets the decoded Opus origin by pre-skip. The shared sample wrapper can then smooth a timestamp gap smaller than one buffer duration. Custom encoder packets pass directly to the muxer. Native WebCodecs priming correction runs in the separate encoder branch. `Conversion` slices decoded PCM at the requested sample boundaries, but its default codec selection can resample or downmix when the original configuration is unavailable. The app's native audio path should drive explicit per-export packet sources alongside a composable video conversion. The playback element's clock stays separate. [Decoder source](https://github.com/Vanilagy/mediabunny/blob/v1.65.1/src/media-sink.ts#L2313-L2463) · [Encoder source](https://github.com/Vanilagy/mediabunny/blob/v1.65.1/src/media-source.ts#L2407-L2500) · [Conversion source](https://github.com/Vanilagy/mediabunny/blob/v1.65.1/src/conversion.ts)

The source patch adds optional `EncodedPacket.sideData.audioPriming` in seconds on the first encoded packet and signed `audioDiscardPadding` in seconds. Packet timestamps and durations still describe coded data. The first coded timestamp is the first audible timestamp minus encoder priming. The final packet's positive discard removes tail samples. WebM input returns per-block signed discard and subtracts the precise `CodecDelay` from packet timestamps. Opus pre-skip comes from the codec header and must apply once to the correct decode origin. MP4 input exposes the intrinsic finite edit through `InputAudioTrack.getPresentationRange()`. The range may start after an empty edit, and its start may skip more than one coded AAC packet. The native converter owns raw PCM and coded-frame accounting. The JS bridge must apply the container bounds and decoder-specific origin once. [Matroska timing](https://www.rfc-editor.org/rfc/rfc9559.html#section-11) · [Apple AAC edit lists and roll groups](https://developer.apple.com/documentation/quicktime-file-format/using_track_structures_to_represent_encode_delay_explictly)

## Independent round-trip

The comparison generated 9,601 stereo PCM frames with distinct 347 Hz and 911 Hz tones and markers near both edges. It kept each codec's encoded packet bytes fixed while varying container metadata. For the 44.1 kHz AAC case, 1,088 silent frames were prepended to FFmpeg's independently measured 1,024-frame priming to exercise the 2,112-frame lead shape observed in the separate AudioToolbox probe. That case uses FFmpeg AAC encoding. [AudioToolbox evidence](native-video.md)

| Container variant                                       | FFmpeg raw decoded frames | Chrome decoded frames |
| ------------------------------------------------------- | ------------------------: | --------------------: |
| WebM baseline, or shorter final `BlockDuration`         |                    10,248 |                10,224 |
| WebM final discard 647, 1 ms timestamp ticks            |                     9,601 |                 9,577 |
| WebM final discard 647, 10 µs timestamp ticks           |                     9,601 |                 9,601 |
| MP4 48 kHz AAC baseline                                 |                    10,240 |                10,240 |
| MP4 48 kHz AAC final duration shortened in `stts`       |                    10,240 |                 9,601 |
| MP4 48 kHz AAC exact edit, full coded `stts` and `mdhd` |                    10,240 |                 9,601 |
| MP4 44.1 kHz AAC exact edit, lead 2,112 and tail 575    |                    10,176 |                 9,601 |

At 1 ms, FFmpeg reported the first Opus packet at −0.007 s while its skip metadata still reported 312 samples. At 10 µs it reported −0.006500 s, exactly 312 samples at 48 kHz. Chrome's prior 24-frame deficit disappeared. With fine ticks, an actual 2.4-second VP9 file containing one key frame followed by delta frames preserved all 72 independently decoded frame hashes. Its two stereo Opus tracks each decoded to the reference 9,601 frames in FFmpeg. One track started 17,353 samples after the other. The 10 µs scale quantizes timestamp positions by at most 5 µs and reduces the maximum signed 16-bit block offset to 327.67 ms. The existing muxer opens a new cluster when an offset would overflow. The test covers that rollover across delta frames.

The exact delay also applies when looking up packets. The first patch exposed the FFmpeg 1 ms reference packet's true timestamp of −6.5 ms but still added a rounded 7 ms delay when searching. A lookup at 14.25 ms therefore returned the future packet at 14.5 ms. The corrected lookup adds the exact delay before converting to ticks. The verifier checks both ordinary and key-packet lookups just before, at, and just after the boundary.

The MP4 patch retains coded durations, existing AAC roll groups, and a separate edit-list presentation duration. FFmpeg's raw AAC decoder can return a full padded final frame even when the container has the intended duration. The verifier compares its presented-length PCM prefix byte-for-byte with the independent reference and checks Chrome's exact count. For a delayed MP4 track, ffprobe's aggregate duration can omit the empty edit. The verifier reads the `elst` entries directly and reopens a synthetic 400-second offset, which exercises version-1 `mvhd`, `tkhd`, and `elst` at a 14,112,000 movie timescale. That scale represents the tested audio sample rates and the existing 57,600-tick movie timing exactly. Media track timescales remain separate. The new format options are opt-in. With the options and packet side data omitted, the same Opus and AAC packets produce bytes identical to the upstream default writers. [FFmpeg Matroska discard implementation](https://ffmpeg.org/doxygen/8.1/matroskaenc_8c_source.html#l2894) · [Apple AAC timing example](https://developer.apple.com/jp/documentation/quicktime-file-format/example_representing_encoder_delay_explicitly)

## Reproduction

`node scripts/vendor-mediabunny.mjs` applies the tracked source patch to the pinned npm package and regenerates the browser bundle. `node scripts/verify-audio-timing.mjs /path/to/ffmpeg/bin` generates and checks the fixtures using FFmpeg, ffprobe and headless Chrome. The optional second argument selects an independently built bundle. Outputs are in `.workspace/audio-timing-verification`.

The local verification used Windows, Chrome and FFmpeg/ffprobe 8.1.2 Essentials from Gyan Doshi, a GPLv3 standalone Windows build linked by the FFmpeg project. Those executables were extracted only into the ignored workspace. They are verification tools. The fixture comparison verifies container metadata and playback through independent decoders. It does not establish native macOS converter integration. [FFmpeg download sources](https://www.ffmpeg.org/download.html) · [Windows build provenance and license](https://www.gyan.dev/ffmpeg/builds/#about-these-builds)

## Declared Matroska duration candidate

This isolated candidate addresses a public packet-reader defect, separately from
the unresolved native source-load media error 3. MediaBunny 1.65.1 reads an
explicit `BlockDuration`, then replaces it with the next same-track presentation
timestamp distance while resolving a cluster. A 20 ms Opus packet followed by a
200 ms hole is consequently reported as 220 ms. Laced blocks also acquire wrong
member timestamps and durations from the inflated block duration. RFC 9559
defines `BlockDuration` as the block's duration; next-timestamp inference is the
default when the duration and track default are absent. The recorded explicit
value must therefore survive inference. [Definition and default](https://www.rfc-editor.org/rfc/rfc9559.html#section-5.1.3.5.3)
· [Pinned reader source](https://github.com/Vanilagy/mediabunny/blob/v1.65.1/src/matroska/matroska-demuxer.ts#L755-L770)

`scripts/mediabunny/matroska-duration.patch` applies after the existing audio
timing and video diagnostic patches to the pinned 1.65.1 npm source. It records
whether a `BlockDuration` was present, preserves that duration (including zero)
when resolving the cluster, and prevents lacing's default-duration fallback
from replacing explicit zero. A track's `DefaultDuration` supplies each frame's
duration before considering the next timestamp, including every member of a
SimpleBlock lace. Next-timestamp inference applies only when both declarations
are absent. RFC 9559 defines the track default in nanoseconds per frame; a
BlockGroup on a track with this default must additionally carry explicit
`BlockDuration`. The default-duration regressions therefore use SimpleBlocks,
while the explicit-override controls use BlockGroups.
[Per-frame default](https://www.rfc-editor.org/rfc/rfc9559.html#section-5.1.4.1.13).
The existing no-default inference, final block fallback, timestamp scaling,
codec delay, discard metadata, and
reference/key classification paths remain in place. The source modification
retains MediaBunny's MPL-2.0 terms and notices; no new library or outside
implementation is introduced. The existing vendor command regenerates the
tracked browser bundle from this three-patch series.

`node --test tests/audio-track.test.js tests/audio-timing.test.js tests/audio-config.test.js`
passed all 25 checks on Windows / Node 24.9.0. Before regenerating the bundle,
the explicit single-packet, laced-packet and zero-duration regressions actually
failed (7/10 checks passed in `audio-track.test.js`). The missing-duration and
final-block controls already passed. The first explicit-only patch still failed
the two new nonterminal DefaultDuration controls (single and laced blocks);
those checks passed after applying the full declaration precedence. Controls
also retain the existing no-default lace inference and explicit nonzero
override of a different track default. After regeneration, all fourteen packet/audio
track checks pass, including the existing real Opus PCM, lace discard and AAC
edit tests. Evidence is retained in
`.workspace/matroska-duration-{before,after}.log` and
`.workspace/matroska-default-duration-{before,after}.log`. These tests exercise the real
JavaScript `Input`/`EncodedPacketSink` API with generated EBML and existing Opus
packets; they do not exercise native WebKit playback. In particular, this
candidate is not evidence that native media error 3 is repaired.

The existing independent verifier also completed successfully:
`node scripts/verify-audio-timing.mjs /path/to/ffmpeg/bin`, using FFmpeg 8.1.2
and actual Chrome 157.0.8103.38. Chrome returned 9,601 presented frames for
Opus 48 kHz, AAC 48 kHz and AAC 44.1 kHz; the corresponding independent raw
FFmpeg counts were 9,601 / 10,240 / 10,176, retaining the existing coded-versus-
presented AAC checks. The comparison intentionally loads the upstream and
patched libraries, which emits MediaBunny's duplicate-load warning. Its original
log is `.workspace/matroska-duration-independent.log`; the successful rerun
after correcting DefaultDuration precedence is
`.workspace/matroska-default-duration-independent.log`.

A separate read-only comparison reopened the retained 59,365-byte source and
the discarded RAP-only two-cluster derivative that exposed this finding. With
the new reader, all 28 video, 137 mono and 89 stereo packets match the original
in compressed bytes, type, timestamp, duration and side data. In particular,
the pre-gap packet returns 20 ms, versus the baseline reader's 220 ms. Video
key/delta classification is unchanged. Patch apply/reverse restored the exact
pre-patch source bytes, and a second vendor build produced identical bundle
bytes. These checks are recorded in
`.workspace/matroska-duration-validation.json`. The running three-arm native
container experiment remains untouched and uses its original reader.

## Browser syntax target regression

At `d397439`, Linux completed the photo workflows and decoded video previews, then failed the video export with `Unexpected identifier 'u'`. The regenerated media bundle retained TypeScript source `using` declarations because its new build script omitted a target. The pinned upstream MediaBunny build explicitly targets ES2021. The local script now uses that same target, which lowers resource disposal syntax for the supported WebKit engines. [Upstream build configuration](https://github.com/Vanilagy/mediabunny/blob/v1.65.1/scripts/bundle.ts#L14-L31)

The independent FFmpeg/Chrome timing verifier passed again after regeneration. An isolated archive of `d397439` plus the regenerated bundle was built on WSL Ubuntu 24.04 and passed the strict native video workflow with the required GStreamer VP9 parser available. Actual previews, a rotated 64×96 saved PNG, original bytes and edited VP9/Opus audio tones passed. The first local attempt lacked that parser and failed its explicit encoding capability check after the syntax error was gone; the provisioned run changed that prerequisite, not the assertion. Logs are `.workspace/media-es2021-oracle.log`, `.workspace/media-es2021-linux.log` and `.workspace/media-es2021-linux-complete.log`.

## Short multitrack AAC verification

The retained Intel and ARM MP4s from `8f9f113` contain the same audio timing structure. The 48 kHz mono track has 12 coded packets of 1,024 samples, 2,112 priming samples, 9,601 presented samples and 575 trailing samples. The stereo track has nine coded packets, the same priming, a 3,129-sample empty edit, 6,472 presented samples and 632 trailing samples. Its media header duration is 9,216 samples. Its movie-track duration includes the delay and ends at 9,601 samples. [Intel job](https://github.com/stvlynn/OpenLR/actions/runs/42169194351) · [AAC edit-list contract](https://developer.apple.com/jp/documentation/quicktime-file-format/example_representing_encoder_delay_explicitly)

FFmpeg 9.0.1 and 9.0.2 both decoded 6,087 stereo samples with their edit processing enabled. The MOV demuxer clamps the stream duration to 9,216 coded samples, then compares the last packet's delayed movie timestamp of 9,209 against that duration. It retains seven samples of the last packet and reports 1,017 discarded samples. The native smoke now decodes AAC with FFmpeg's edit processing disabled, checks the full PCM count against the coded sample table and media header, and applies the exact raw edit to independently decoded PCM. Both retained files yield all 12,288 mono and 9,216 stereo coded samples in FFmpeg 8.1.2 with that option. Both edited edges match the generated source at zero lag for every channel. [FFmpeg duration clamp](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavformat/mov.c#L4357-L4359) · [FFmpeg final-packet discard](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavformat/mov.c#L10872-L10887)

Chrome 151 on the Intel runner returned 10,176 mono samples, the full coded count after priming. Chrome 156 on ARM returned 9,601, and replaying both exact files in Windows Chrome 156 independently returned 9,601. Chromium added a fallback to trim final AAC output using the container duration for files that retain full packet durations. The smoke retains its exact Chrome count assertion and accepts a dedicated executable through `OPENLR_AUDIO_ORACLE_CHROME` so CI can use the same Chrome for Testing build on both architectures. The retained-file replay log is `.workspace/native-audio-8f-compare.log`. [Chromium AAC trim fix](https://chromium.googlesource.com/chromium/src/media/+/23be7f6277b4b797eae0111b5dd0b1100fe53dea) · [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/)
