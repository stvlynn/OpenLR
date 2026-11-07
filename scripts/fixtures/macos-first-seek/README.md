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

The original `experiment/macos-first-seek` branch is based on `df741d6` and
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
28 minutes for each arm's cohort. The resource continuation uses
`cohort-resources-package-off`, `cohort-resources-package-on`,
`cohort-resources-evidence-off` and `cohort-resources-evidence-on`; evidence includes build identity, the source,
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

The subsequent observation defaulted to OFF-only, retaining the exact source, full
assertions and 24-host schedule while seeking a further natural rare failure
with failure-only metadata. It is additional observation, not a retry that
replaces the failed ON result. No ON repetition, forced fault, inserted wait,
SDK or debugger is required by this schedule. Diagnostic trace traffic and
separate runner environments limit comparisons between the prior OFF and ON
outcomes; no timing benefit or first-seek fix is established. The actual build
revision is recorded automatically so the owner-preservation follow-up is
distinguished from the earlier observation.

## Resource and power continuation

`experiment/macos-cohort-resources` starts from exact revision `56c3f13`,
without application, Go, codec or playback changes. That preceding OFF cohort
passed 16 trials, then trial 16 passed frames and WebM but timed out in MP4;
trial 17 timed out during startup and stopped at the oracle cleanup gate.
Its owned browser parent positively exited by SIGKILL, while BrowserServer
cleanup remained unconfirmed. The earlier ON cohort had the same order of
failures one trial sooner. Summing baseline trial durations, the first
MP4-stall hosts started at 599.37 s (ON) and 596.22 s (OFF). This roughly
ten-minute alignment motivates observation; it proves no resource leak,
power transition or codec cause. The ten fresh-host encoder microprobes
passed separately and did not reproduce the full application's accumulated
workload.

The existing shared driver now opts into `OPENLR_COHORT_RESOURCES=1` only in
this workflow. Before and after each trial it writes
`cohort-resources.jsonl`, with wall/monotonic times and cleanup flags. Nine
read-only diagnostic commands run in parallel within each snapshot; complete
snapshots serialize, and the file closes only after active work finishes:

- `ps -ww -axo pid,ppid,uid,rss,vsz,state,comm`: only the current owned driver
  tree, basenames and aggregate counters are retained. The full process list,
  UID values, unrelated command names, arguments, environment and paths are
  not written. System and same-UID process counts are separate. Named service
  aggregates cover OpenLR, Chrome (including `chrome_crashpad_handler`),
  WebKit, VideoToolbox and media services without claiming ownership.
- `vm_stat` and `sysctl hw.memsize vm.swapusage kern.num_files kern.maxfiles
kern.maxproc kern.maxprocperuid`: native output and units remain visible.
  Compare same-UID counts with per-user limits, not total system counts.
  A constant read-only shell also records inherited effective soft/hard
  process limits using `ulimit -S -u` and `ulimit -H -u`; no limit is changed.
- `pmset -g custom`, `assertions`, `systemstate`, `stats`, and
  `powerstate IODisplayWrangler`: configuration, assertions, system state,
  sleep/wake counts and the selected display driver's raw state are retained.
  These are [documented getters](https://github.com/apple-oss-distributions/PowerManagement/blob/main/pmset/pmset.1),
  not sleep prevention or wake requests. `control.active` describes export
  batch progress and is not evidence of foreground or power state.

Each diagnostic subprocess has a five-second timeout and bounded output;
timeout termination applies only to that diagnostic child. Tool failures,
unsupported getters and truncated output remain explicit. The sampled tree
can omit reparented or launchd-owned helpers; service counts are aggregates,
not permission to signal those processes. RSS sums double-count shared pages,
boundary snapshots omit peaks, and process counts do not measure every
thread, encoder session or private framework resource. Missing or unchanged
counters cannot exclude unmeasured resource exhaustion.

There is no `caffeinate`, power-setting change, synthetic wait, application
trace, forced fault, debugger or extra recovery. The required boundary I/O
does add inter-trial overhead: `observationMs` measures each full awaited
snapshot separately from the unchanged trial-duration measurement, and
`cohortElapsedMs` includes observer time. Raw collection/tool timings are
also retained. This overhead may shift a time-sensitive recurrence and must
be included when comparing cohort age with the earlier approximately 600 s
alignment. All 24 source/output assertions, actual cleanup gates and stop-on-
unconfirmed-cleanup behavior remain. Push defaults to OFF-only. The source
fixture and product baseline are unchanged; actual observation revision is
recorded from `GITHUB_SHA`. This experiment is observation, not a repair or a
replacement for the retained failed runs.

### Getter availability and process-name limits

The `c204bda` native artifact from run `42400992680` retained an exit-zero
`pmset -g powerstate IODisplayWrangler` receipt whose stdout instead said
`Internal failure: Failed to get power state information` in every snapshot.
The original `observed` summary represented process exit status and did not
validate this getter's content. The display-driver state is unavailable in
those records. The bounded follow-up recognizes that exact failure form,
marks its receipt `semanticStatus: unavailable`, and marks the snapshot
`partial`, preserving the original exit code and complete raw output. Other
successful counters do not make this getter valid; system capabilities and
sleep counts are separate evidence. The historical artifact is unchanged.

Apple's `adv_cmds` source at
[`6bed8737a34dbb54782a18f47dccf933a9967a12`](https://github.com/apple-oss-distributions/adv_cmds/tree/6bed8737a34dbb54782a18f47dccf933a9967a12/ps)
documents repeated `-w` as unlimited width. Its
[`ps.c`](https://github.com/apple-oss-distributions/adv_cmds/blob/6bed8737a34dbb54782a18f47dccf933a9967a12/ps/ps.c)
also sets unlimited width for non-TTY stdout.
[`keyword.c`](https://github.com/apple-oss-distributions/adv_cmds/blob/6bed8737a34dbb54782a18f47dccf933a9967a12/ps/keyword.c)
maps `comm` to `just_command`, which calls `p_command_and_or_args` with
arguments disabled;
[`print.c`](https://github.com/apple-oss-distributions/adv_cmds/blob/6bed8737a34dbb54782a18f47dccf933a9967a12/ps/print.c)
prints the
final field in full when width is unlimited. Keeping `comm` last and adding
explicit `-ww` is defensive. This source already predicts unlimited output
for the prior piped invocation, so width truncation is not an established
explanation for its zero Chrome/WebKit/VideoToolbox aggregate counts. The
source is not an identity match to the installed macOS binary. Its process
lookup can also fall back to a parenthesized accounting name; boundary
sampling, lookup and name classification retain limits. Those zero counts
do not establish service absence, ownership, or successful reaping.

The follow-up has an exact-output regression test and a controlled long-path
process-name test. It makes no product change and launches no new native
cohort; the completed native run retains its own result and observation
limits.
