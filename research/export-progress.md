# Export progress and cancellation research

Date: 2026-11-05. This record informs OpenLR's own contract; it does not assert Adobe implementation parity.

## Evidence and scope

- The existing [Lightroom record](lightroom.md) has REA resource evidence L1/L2 for export and previous-export entry points. The later Windows runtime observation opened a single-photo export preview and cancelled the **dialog before writing**. It did not observe an active export, progress percentage, cancellation latency, partial-file policy or background-job lifetime. Those behaviors remain unknown for installed Lightroom 9.4; no new Adobe code, private photograph, screenshot or asset is imported here.
- Context7 `/cloudflare/workers-sdk` was queried for instance description/termination. The returned implementation was checked against GitHub revision `c579d500d0c5732393f2e85f0cdd085167aee32e`, retrieved through the GitHub API on the date above. The primary [describe implementation](https://github.com/cloudflare/workers-sdk/blob/c579d500d0c5732393f2e85f0cdd085167aee32e/packages/wrangler/src/workflows/commands/instances/describe.ts) returns structured status and explicitly includes the resolved instance ID in JSON, without display truncation. The [terminate implementation](https://github.com/cloudflare/workers-sdk/blob/c579d500d0c5732393f2e85f0cdd085167aee32e/packages/wrangler/src/workflows/commands/instances/terminate.ts) is a separate ID-addressed action. Both distinguish machine-readable output from terminal presentation. These are source observations, not an executed Cloudflare workflow. OpenLR borrows the separation of lifecycle identity, status and explicit cancellation, not Cloudflare's distributed persistence/retry service.
- Cloudflare's [documented workflow CLI](https://developers.cloudflare.com/workflows/reference/wrangler-commands/) exposes describe, list, pause, resume and terminate independently of triggering a workflow. This supports discoverable control commands for long-running work; it does not require OpenLR to add every distributed-workflow feature.
- The [DOM Standard's abort mechanism](https://dom.spec.whatwg.org/#aborting-ongoing-activities) carries an abort reason and notifies cooperating APIs. [`throwIfAborted`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/throwIfAborted) provides explicit checkpoints. A signal does not preempt arbitrary synchronous JavaScript/WASM. OpenLR therefore must distinguish cancellation requested from cancellation completed and check the signal at safe processing/transfer boundaries.

No external implementation is copied and no new dependency is needed.

## Existing OpenLR behavior

At `97ca4c2`, `app.run` serializes ordinary commands and `serveNative` waits for one dispatch reply before polling the next request. The batch holds that command until all files finish. Adding a cancel command to the same queue would make cancellation wait behind the work it is supposed to stop. Merely allowing a concurrent renderer dispatch is also insufficient if the native bridge itself still waits before receiving controls.

The batch already snapshots recipes and writes files sequentially. Native writes have a temporary-file lifecycle and a concrete `FinishExport` publication point. This is the appropriate boundary for completed-file counts: preparation or transferred bytes do not imply a saved file. Existing settings completion rules must survive cancellation.

## Scheduling ablation

Executed with Node 24.9 on Windows. This deterministic, generated control-flow experiment holds a job at a promise barrier, then submits a normal edit and control requests before releasing it. There are no timers, images, disk writes or desktop IPC in this experiment; it compares scheduling semantics, not native latency or application throughput. Production browser/native tests must separately verify the chosen mechanism.

| Policy | Status available while held | Cancellation observed while held | Ordinary edit ran during export | Simulated saved items after release |
| --- | --- | --- | --- | --- |
| All commands serialized | No | No | No | 3 |
| All commands concurrent | Yes | Yes | Yes | 0 |
| Only controls bypass the normal queue | Yes | Yes | No | 0 |

Reproduce with `node --input-type=module`:

```js
const results = []
for (const strategy of ['serialized', 'concurrent', 'control-lane']) {
  let queue = Promise.resolve(), release, startedResolve
  let active = false, edited = false, cancelled = false, observed = false, saved = 0
  const gate = new Promise(resolve => release = resolve)
  const started = new Promise(resolve => startedResolve = resolve)
  const submit = (kind, action) => {
    if (strategy === 'concurrent' || strategy === 'control-lane' && kind === 'control')
      return Promise.resolve().then(action)
    const result = queue.then(action)
    queue = result.catch(() => {})
    return result
  }
  const job = submit('normal', async () => {
    active = true
    startedResolve()
    await gate
    if (!cancelled) saved = 3
    active = false
  })
  await started
  const edit = submit('normal', () => { edited = true })
  const cancel = submit('control', () => { cancelled = true })
  const status = submit('control', () => { observed = true; return active })
  await Promise.resolve()
  await Promise.resolve()
  const during = {
    statusAvailable: observed,
    cancelObserved: cancelled,
    editRanWhileExportActive: edited && active
  }
  release()
  await Promise.all([job, edit, cancel, status])
  results.push({ strategy, during, saved })
}
console.log(JSON.stringify(results, null, 2))
```

## Recommended OpenLR contract

1. Keep ordinary edits/imports/selection changes serialized. Route only `export-status` and `export-cancel` through a narrow native control lane to the same central dispatcher. A separate Go broker queue and poll method prevent a pending normal mutation from starving these controls; neither bypasses argument validation or directly mutates photo state.
2. Give the current batch a session-scoped ID and expose a copied status snapshot. Cancellation names that ID, so a delayed command cannot cancel a later run. The identity is operational correlation, not a new checksum or approval gate. Keep terminal state available for inspection after the original CLI call times out. Do not imply persistence across process restart unless it is implemented.
3. Report stage, current item, completed count, total, current-item byte progress and actually completed files. Distinguish bytes transferred from a file committed. Avoid an invented total percentage while decode/encode work remains unmeasured. Status can use the existing `--capture` observer to return a real current window image with its data.
4. Cancellation sets an abort request and returns its current state promptly. Cleanup then determines the terminal result. Check before/after preparation, between bounded write chunks, and before publication. A successfully published file counts even if cancellation arrived during publication; stop before the next item. Never label completed output as absent or delete it to manufacture an all-or-nothing result.
5. Leave previous export settings unchanged on cancelled/partial output. Preserve completed files, discard the current native temporary transfer, and report cleanup failure independently from the primary outcome. Browser streams keep their existing non-exclusive-path limitation; cancellation must not delete an external file.
6. Do not equate HTTP observation timeout/disconnect with cancellation. The caller may reconnect and query status, then explicitly cancel the known ID. GUI and CLI use the same controller and state. A system chooser or a synchronous codec may not be immediately interruptible; cancellation remains pending until execution reaches a checkpoint.

## Verification required

- Hold preparation and transfer deterministically; prove status and cancellation resolve while the ordinary job is pending and a queued edit stays queued.
- Confirm actual native control requests traverse Go/IPC while the normal export request is still live, including a real `--capture` PNG.
- Cancel before output, during a middle chunk, between files and while final publication completes. Check exact completed files, current temporary cleanup, terminal status, unchanged settings and unchanged originals.
- Reject an old ID once a later batch is active. Repeating cancellation for the same terminal job must not affect a new job.
- Preserve primary read/write failure when cancellation or cleanup also occurs. A cancellation request must not turn an unrelated disk failure into apparent success.
- Validate whole-suite behavior: a dedicated control lane must not make normal commands concurrent or change existing single-photo export/capture contracts.
