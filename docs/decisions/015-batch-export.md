# 015 — Sequential selection export through shared preparation

Status: Accepted

## Context

Selection supports group organization but export previously handled only the active asset. Looping over selection changes would mutate the editor source cache and video playhead. Aggregating exported Blobs or base64 strings scales memory with the entire selection. Existing ZIP packaging is a per-original archive, not a streaming batch writer.

## Decision

Extract one photo preparation owner used by preview, single export and group export. Capture records/options in display order, then prepare and write each item with an owned source. `export-selection` owns this workflow for GUI and CLI. Destination adapters return actually completed files; native writes reuse bounded chunks and the temporary-file lifecycle. Commit remembered media settings atomically after full completion.

Use numbered collision names and no-overwrite native publication. Keep single-export commands unchanged. Browser folder selection starts in the user gesture and retains its documented filesystem API limitations.

## Alternatives and consequences

The 96 MiB transport experiment measured about 472 MiB additional RSS for whole-group JSON/base64, 192 MiB for existing `zipSync`, and 53 MiB sequentially. This is transport evidence, not an image-codec memory guarantee. A future streaming ZIP64 adapter could serve portable archives, but is unnecessary for ordinary folder export and is not supplied by the current browser ZIP writer.

One active output can still be large. Errors preserve completed files and report partial completion without rollback or retry. Native paths and browser handles remain adapter responsibilities. Live cancellation/progress is subsequently provided by [ADR 016](016-export-control-lane.md). See [the contract](../batch-export.md) and [primary-source research](../../research/batch-export.md).
