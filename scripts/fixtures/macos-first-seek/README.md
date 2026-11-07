# Retained first-seek observation fixture

`fixture.webm` is the exact 27,479-byte generated source downloaded from
OpenLR Actions run [42392485539](https://github.com/stvlynn/OpenLR/actions/runs/42392485539),
revision `df741d6`, artifact `release-video-evidence`, path
`release-video-trials/fixture.webm`. It was generated once by
`scripts/native-video-smoke.mjs` and `tests/fixtures/video.mjs`, using Chrome
157.0.8103.38, then reused across the fixed release cohort. The source contains
three generated color/tone segments encoded as VP9/Opus, with no personal
media or outside assets. It is OpenLR project material under AGPL-3.0-only.
This copy retains the original bytes without remuxing, decoding or encoding.

The ordinary release cohort completed 23 strict passes and one failure, at
zero-based trial 3. Its first `video-seek --time 0.35` returned `Media failed
to decode` at `native-video-smoke.mjs:209`, after import and before the
`frames-passed` marker. The host remained alive; host and graceful oracle
cleanup were confirmed. Application diagnostics were disabled, so that log
does not distinguish initial loading, an exhausted load retry, the initial
trim-start seek, frame preparation or the requested 0.35-second seek. This is
separate from the passing four-platform desktop matrix at the same revision.

The isolated `experiment/macos-first-seek` branch is based on `df741d6` and
reuses the existing release workflow, stock vendored build, fixed 24-host
driver, independent Chrome oracle and actual cleanup owners. Manual dispatch
selects diagnostics `off`, `on` or `both`; a self-path push defaults to `off`.
The matrix expands only the selected arm or arms, with fail-fast disabled.
Each selected arm builds once and runs 24 fresh hosts against these same
retained bytes. Before starting
any host, the workflow copies this source to the driver's usual
`build/release-video-trials/fixture.webm` and directly compares the copied
bytes. There is no hash gate and no replacement fixture generation. The main
branch's ordinary workflow remains unchanged.

The off arm sets `OPENLR_DIAGNOSTICS=0`; the on arm sets it to `1`, enabling
the existing import/playback trace. `OPENLR_AUDIO_DIAGNOSTICS=0` stays
unchanged in both. The trace can distinguish
`playback-load`, readiness/error events, `playback-load-retry`,
`playback-loaded`, `playback-opened`, the initial trim-start seek,
`source-frame`/`source-frame-read`, and the actual 0.35-second seek and stage
paint. Both arms include the failure-only structured `error.details.video`
fields from `81b2ffe` through the existing command error response. These fields
can identify the off arm's failed boundary without successful-path trace bridge
traffic. The workflow adds no playback policy changes, extra application
original-read, settling wait, fault injection, debugger or custom Go toolchain. Every existing
image, playback, saved-frame, audio, all-track export, original-byte and
cleanup assertion remains. A failed trial is retained; the shared driver
starts another host only after confirmed host/oracle cleanup and smoke
process closure.

The experimental branch's existing workflow self-path push trigger or manual
dispatch starts this observation. The budget remains 35 minutes per job and
28 minutes for each arm's cohort. Artifacts are `first-seek-package-off`,
`first-seek-package-on`, `first-seek-evidence-off` and
`first-seek-evidence-on`; evidence includes build identity, the source,
provenance, observation settings, the complete/partial report and every raw
trial log. Only artifacts for selected arms are produced. Observation metadata
records the diagnostic mode, the retained source's `df741d6` revision and the
actual application/workflow revision from `GITHUB_SHA`.
Diagnostics add bridge traffic and may change timing. A finite
passing cohort without recurrence would not identify the earlier failure
phase or establish a repair.

## Completed paired observation

Run [42396115647](https://github.com/stvlynn/OpenLR/actions/runs/42396115647)
completed the OFF arm with 24/24 strict passes and all host/oracle cleanup
confirmed, job `128473726352`, artifact `13584251655`. The original first-seek
failure did not recur. This finite result does not identify that failure's
phase or establish a repair.

The ON arm stopped after 17 trials: 15 strict passes and two failures, job
`128473726384`, artifact `13583503194`. Zero-based trial 15 timed out after
30 seconds in MP4 export with video worker 0 pending and audio worker 1 done.
Trial 16 reported `renderer-gone` during startup. Its owned oracle parent
positively exited by SIGKILL ten milliseconds after escalation, but
Playwright's BrowserServer cleanup operation did not settle within the
five-second forced-cleanup deadline. The receipts do not distinguish delayed
child stdio closure from pending temporary-directory cleanup and do not prove
that a helper survived. The gate correctly retained this unconfirmed lifecycle
and prevented another host from starting. These failures remain separate from
the earlier main first-seek error.

The next observation defaults to OFF-only, retaining the exact source, full
assertions and 24-host schedule while seeking a further natural rare failure
with failure-only metadata. It is additional observation, not a retry that
replaces the failed ON result. No ON repetition, forced fault, inserted wait,
SDK or debugger is required by this schedule. Diagnostic trace traffic and
separate runner environments limit comparisons between the prior OFF and ON
outcomes; no timing benefit or first-seek fix is established. The actual build
revision is recorded automatically so the owner-preservation follow-up is
distinguished from the earlier observation.
