# Controlled initial native decode recovery

This diagnostic runs two direct Go/WKWebView hosts on macOS. It injects a single
media error 3 after the second `multitrack.webm` player emits real, trusted
metadata with nonzero dimensions. The first player belongs to import poster
preparation; the second is the fresh trim player. The fault is synthetic. Native
metadata, cleanup, the candidate's fresh player and written image/audio outputs
are real when the native workflow runs.

From a full-history checkout with Node 24, stock Go 1.27.3, FFmpeg and Chrome:

```sh
node scripts/native-initial-decode-comparison.mjs build/initial-decode-recovery
```

`OPENLR_AUDIO_ORACLE_CHROME` selects the independent Chrome executable. The
workflow pins Chrome for Testing 157.0.8103.38 on `macos-15` ARM. An optional
`--ffmpeg-bin=directory` selects FFmpeg/ffprobe. `--prepare-only` materializes the
diagnostic source without building or running a host, including on other OSes.

The builder extracts only tracked source from `a8c07ee` into an owned, ignored
`.workspace/initial-decode-source-*` directory. Both executables include that
revision's independent MediaBunny duration repair. It builds the same source
twice, substituting only `web/video.js`: baseline `ba16d3c` and candidate
`197e89b`. It appends this directory's `preload.js` to the temporary `main.go`
`PageOptions.PreloadScript`. No production source or hook is changed. The direct
stock build uses `CGO_ENABLED=0`, `-mod=vendor`, `-tags mygo_noinspector` and the
existing MyGo production flag. `-buildvcs=false` prevents these temporary copies
from inheriting the enclosing checkout's unrelated revision stamp; the manifest
records their explicit source revisions and retained instrumentation. These
executables do not prove ordinary package
installation or platform dialogs.

The artifact retains project and dependency license texts beside the direct test
executables, using the common revision's original `LICENSE`,
`THIRD_PARTY_NOTICES.md` and `resources/licenses/` files.

The retained 59,365-byte input comes directly from the pinned `9004d23` Git
object `scripts/fixtures/short-audio-layout/failed-multitrack.webm`; its provenance
is in that revision's fixture README. No reticking, remuxing or new generation
occurs. `OPENLR_AUDIO_ORIGINAL_BEFORE_TRIM=0` omits the added diagnostic pre-trim
original read. All post-trim original-byte checks remain unconditional.

The temporary source reuses `9004d23`'s strict audio smoke, trial runner, audio
outcome reader and owned oracle unchanged. Its workspace helper retains the
existing host lifecycle and adds a wrapper that copies fixed generated output
filenames before cleanup. After the unchanged smoke succeeds, while the host is
alive, that wrapper calls the shared CLI `preview` command. FFmpeg reads its PNG
and the first frame of the written multitrack WebM: the final AAC preview must
be blue (`#4c7cba` source), and the recovered multitrack export must be red
(`#99352b` source). This adds no action before the controlled trim failure and no
second export or browser verification pipeline.

The baseline must return nonzero with exactly one injection, no export success
or retry, and confirmed failed-player, host and oracle cleanup. The candidate
must return zero, use the same original `File` in one fresh player, report
exactly one `playback-load-retry`, and complete all three unchanged strict audio
checks: multitrack WebM, multitrack MP4/AAC, and 44.1 kHz AAC input/output. It must
also pass the generated-image checks, original bytes and cleanup receipts. A
missing injection is a failure, even if ordinary playback succeeds. A failed
ownership receipt prevents another host from starting.

The preload emits bounded numeric/boolean markers through the existing
`Desktop.VideoImportDiagnostic` bridge. It emits no path, filename, URL or file
bytes. Its recovery `loadeddata` observer uses capture phase before the awaited
application listener resumes source preparation and initiates a seek; a later
observer can otherwise sample the seek's reduced readiness instead of initial
frame readiness. Error injection stays after the loader's metadata observer,
so the loader has actually admitted that native metadata.

The output directory retains both executables, source overlays, instrumented
main/preload, provenance manifest, trial logs/report, generated sources,
original exports, edited video files and the final preview PNG. The ordinary
smoke also retains its existing failure artifacts. The workflow uploads these
with `if: always()`. Scratch source is retained under the ignored owned prefix
for diagnosis and is never included as project source.

Local verification on Windows used Node 24.9.0 and Chrome 157.0.8103.38. The
exact preload produced the expected baseline failure and candidate recovery
with real metadata, decoded stage pixels and byte-identical original export.
Outcome and temporary-main checks passed too. An instrumented common source
cross-compiled to Darwin/ARM64 with stock Go 1.27.3; this is compile evidence.
Native execution of this two-host workflow remains pending.

```sh
node --test scripts/fixtures/initial-decode-recovery/preload.test.mjs
```

This explicitly invoked diagnostic test needs the pinned historical Git objects,
so it lives with the fixture rather than adding a history requirement to the
ordinary shallow-checkout `npm test` suite.

The independent read-timing cohort at `9004d23` had 23/24 strict passes, with one
original-workflow failure before export and all host/oracle cleanup receipts.
Its finite 11/12 original-workflow and 12/12 added-read results do not establish
a timing benefit. This two-host fault experiment proves only its controlled
admission and recovery policy when it passes; it cannot identify a native codec
root cause or prove spontaneous failures eliminated.
