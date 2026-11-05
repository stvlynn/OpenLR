# Independent point curves after the existing curve stage

## Status

Accepted, 2026-11-05.

## Context

The three existing fixed curve sliders cannot represent arbitrary control-point positions or independent RGB channels. Installed-resource inspection establishes point/channel curve concepts but not Adobe's interpolation. Existing saved recipes must retain their look, including the old quarter-stop arithmetic and byte rounding. Linear processing must retain signed and HDR variation.

## Decision

Use a separate `toneCurves` recipe owner and one domain module for strict validation, updates and shape-preserving PCHIP evaluation. Apply the old curve unchanged, then the RGB master, then the individual channel, before the existing mixer. Both graph and rendering consume the same compiled rule. Byte rendering uses channel lookups; Linear rendering composes in continuous signed encoded sRGB without intermediate clipping.

Keep x endpoints fixed while allowing y movement. Outside [0,1], use unit-slope endpoint-offset tails. Retain additional identity knots so an added point remains selectable; ignore them when determining whether the photo has an actual curve effect. Reset removes the selected channel's default two endpoints. Preserve existing persistence/history paths and expose explicit channel replacement through the shared dispatcher. Transient graph/photo preview performs no storage write; a completed drag commits once with captured source and previous-channel guards.

## Consequences

Old recipes remain unchanged. New curves travel through copy, presets, versions, XMP, sidecars and sync with shared validation. An explicit channel operation preserves concurrent unrelated edits. The HDR tail remains continuous and unbounded, but its derivative need not match the interior derivative at black/white. The point curve is not an Adobe-compatible calibration or a luminance-only curve. Standard Adobe curve tags remain outside this change.

## Alternatives considered

- Replacing the old slider interpolation would change existing photographs and fails the compatibility requirement.
- Linear interpolation passed knot, bound and locality checks but retained slope corners; the reproducible ablation favored PCHIP's continuous interior derivative without segment overshoot.
- Unconstrained splines can overshoot; there is no demonstrated need for that behavior in this editor.
- Identity tails are discontinuous when endpoint output moves; constant tails clip exterior variation; polynomial extrapolation can reverse or diverge. Unit-slope offset tails retain variation without those behaviors.
- Removing every neutral curve would erase a newly added identity knot before the user could move it. Keep those editing handles and assess their actual effect instead.
- A separate curve export, paste or persistence engine would duplicate existing responsibilities and is unnecessary.

## References

- [Research, primary sources and numerical ablation](../../research/point-tone-curves.md)
- [Product and CLI contract](../tone-curves.md)
- [Linear working-frame stage order](../linear-working-frames.md)
