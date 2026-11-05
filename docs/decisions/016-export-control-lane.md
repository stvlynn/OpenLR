# 016 — A control lane for live export observation and cancellation

Status: Accepted

## Context

The batch dispatcher and native request receiver both awaited the complete export. Putting status/cancel in that same queue cannot interrupt it. Running all commands concurrently would break the existing edit and source-state ordering contract.

## Decision

Keep ordinary commands serialized. Route only `export-status` and `export-cancel` through a separate native receive channel and immediate branch of the same central dispatcher. Both paths still validate the shared schema. A session-local export lifecycle owns its ID, progress, completed-file list and abort signal. The GUI uses those same controls. CLI `watch --command export-status` reuses change notifications and actual workspace capture.

Cancellation is cooperative, checked between phases and 512 KiB transfers before publication. Successful publication counts even when cancellation arrives during the commit. Cleanup completes before terminal cancellation is reported; errors retain completed files and the primary failure. An observation timeout/disconnect never means cancellation. The latest terminal result remains queryable for the GUI session.

## Alternatives and consequences

A deterministic scheduling ablation compared one queue, general concurrency and dedicated controls. Only dedicated controls provided live status/cancel while keeping ordinary edits queued. It does not prove native latency; browser barriers and actual native chunk transfers verify the production path. See [research](../../research/export-progress.md).

This is an export lifecycle, not a generic background-job framework. Synchronous codecs/rendering cannot be preempted, native chooser cancellation still belongs to the OS dialog, and records do not survive application exit. Progress distinguishes bytes transferred from files committed and does not fabricate decode/encode percentages. The contract is in [batch export](../batch-export.md).
