# Remember settings after export completion

## Status

Accepted.

## Context

The existing GUI remembered a single options record after Save, while the CLI only returned bytes and Ctrl/Command-E read that record privately. Making reuse discoverable must preserve cancellation semantics and use the existing render pipeline. Source-media identity can change while an output adapter is saving.

## Decision

Export preparation returns resolved options and the captured photo/video slot with its bytes. Each output adapter acknowledges successful completion through the shared `export-settings` command. `export-previous` feeds the stored options into the existing export operation. Photo and video slots are stored together with one preference write, and explicit configuration uses the same command and export validator. No transaction registry, token or duplicate renderer is introduced.

## Consequences

GUI and CLI share validation and reuse behavior. Failed output does not change preferences. A caller that only requests bytes must explicitly acknowledge its own successful output. Output and preference storage cannot be one atomic transaction: a later storage failure is reported as a saved export whose settings could not be remembered. Browser downloads and stdout have the completion limits documented in the workflow contract.

## Alternatives considered

- Remember on encode: simpler, but cancellation and output-write failures replace the previous successful settings. The real-browser ablation measured both outcomes against completion-based remembering; all four assertions passed. See the research record and reproducible probe below.
- Keep GUI-only persistence: preserves existing Save behavior but leaves CLI exports and discoverable reuse inconsistent.
- Add pending-export identifiers and commit state: unnecessary for a local preference that can also be explicitly configured. Captured options provide the required source identity without another lifecycle to recover.
- Keep one global slot: a successful video export makes the next photo reuse incompatible. Independent slots preserve existing still-frame export support without guessing a conversion.

These are OpenLR decisions. Lightroom resource/menu observations establish an export-previous entry, not its internal persistence protocol.

## References

- [Workflow and completion contract](../export-settings.md)
- [Installed application evidence and source audit](../../research/catalog-organization.md)
- [Darktable agent export documentation](https://github.com/darktable-org/darktable/blob/master/src/mcp/README.md), consulted through Context7; no implementation copied.
