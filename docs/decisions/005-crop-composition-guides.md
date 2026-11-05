# 005: View-only crop composition guides on the existing surface

## Status

Accepted, 2026-11-05.

## Context

The existing crop tool has shared pointer/agent draft geometry but only fixed CSS thirds. Nine composition choices require curves, physical diagonals and ratio references. Drawing guides into rendered photo pixels would contaminate previews and exports. Storing them as edits would also pollute undo, presets and sidecars.

## Decision

Keep `{type,orientation}` on the current crop view surface, with a session default of thirds. Expose `crop-guide` through the central command schema and dispatcher used by UI and CLI; report it in full and summary state. Use one pointer-transparent SVG child inside the existing crop frame for every guide, replacing CSS thirds. Generate geometry independently in crop-frame CSS pixels. Recompute on draft changes and resize. Only the existing crop commit writes the rectangle to the photo recipe.

## Consequences

No original, export or edit-state pipeline changes. Settings last for the window session and are independent of photo rotation and crop history. Golden spiral uses a true, uniformly fitted logarithmic curve; this is an explicit OpenLR rule, not pixel parity with another editor. Commands can prepare the guide while the tool is closed. A future persistent preference would need a separate preferences contract rather than adding the setting to photo edits.

## Alternatives considered

Extending CSS gradients is cheap for grid divisions but would create special rendering paths for curves and labels. Canvas2D can render all forms but introduces another raster/DPI/redraw surface. The [measured small comparison](../../research/crop-guides.md) found all three inexpensive for thirds; SVG's completeness within the existing DOM outweighs its small measured mutation overhead. A third-party crop framework would duplicate the working shared draft/dispatcher logic and add provenance and integration costs.

## References

[Product and CLI behavior](../crop-guides.md), [coordinate ownership](../optics-geometry.md), [source research and verification](../../research/crop-guides.md).
