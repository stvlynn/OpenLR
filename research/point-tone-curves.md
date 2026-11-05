# Point and channel tone curves

Research date: 2026-11-05. This is an implementation proposal, not a claim of shipped functionality or Adobe algorithm equivalence. Existing processing rules are owned by [linear working frames](../docs/linear-working-frames.md).

## Evidence and current gap

The retained REA R3 record in the [Lightroom ledger](lightroom.md) locates `AGCAMERARAWCONTROLLER.LUA` within `Develop.lrmodule` at offset 29348464, length 119224. This audit re-read that record and ran `research/menu-bytecode.mjs` over the identified range of the installed file. The bytecode inspection found `_toneCurveChannelSelection` in prototype 0 at pc361 / offset 29349944, `AgDevelop_editPointCurve` in prototype 0.27 pc73 / offset 29383899, and `PointCurve` in prototype 0.144 pc3 / offset 29429815. The associated local L1 string inspection reported BluePointCurve at line467, GreenPointCurve508, PointCurve538, RedPointCurve549, and SpectrumPointCurve/NewPoint1119. These are bounded static resource/bytecode names supporting channel selection and point-curve concepts. They do not establish runtime interactions, interpolation, color space, HDR behavior, or licensing permission to reuse implementation. No Adobe code/assets were copied.

OpenLR `web/color.js` currently implements only three quarter-stop sliders (`Curve shadows`, `Curve midtones`, `Curve lights`) with piecewise linear interpolation. `web/render.js` uses that shared curve after global tone and before HSL/point-color. Legacy rendering uses a 256-entry byte lookup; Linear processing evaluates continuously in encoded sRGB and preserves input unchanged outside linear [0,1]. The legacy stop construction uses 64/128/192 with a 255 endpoint; preserve this exact arithmetic for existing recipes rather than normalizing it as an incidental cleanup. New point/channel curves must compose after this existing stage. The legacy early-return condition also needs to recognize a nonidentity point curve.

## Primary references

Context7 resolved SciPy to `/scipy/scipy` and returned the primary [1-D interpolation tutorial](https://github.com/scipy/scipy/blob/main/doc/source/tutorial/interpolate/1D.rst). It distinguishes smooth splines that can oscillate from shape-preserving, once-differentiable interpolation. The [PCHIP API documentation](https://docs.scipy.org/doc/scipy/reference/generated/scipy.interpolate.PchipInterpolator.html) specifies strictly increasing x, local weighted-harmonic interior derivatives, zero derivatives at flat/sign-changing joins, and continuous first derivatives without segment overshoot. The pinned [SciPy v1.16.1 implementation](https://github.com/scipy/scipy/blob/v1.16.1/scipy/interpolate/_cubic.py) provides an inspectable endpoint reference. The mathematical reference is Fritsch and Butland, [1984 DOI](https://doi.org/10.1137/0905021).

The experiment below independently implements these documented equations. No SciPy code, dependency, license declaration or lockfile was imported. These references justify numerical properties; they do not dictate photo-editor product behavior.

## Deterministic numerical ablation

Executed `node research/point-curve-ablation.mjs` on Windows, Node v24.9.0. The independently authored [experiment script](point-curve-ablation.mjs) is tracked for repeatability; its output `.workspace/point-tone-curves-ablation.json` is an ignored local artifact. This is a numerical experiment, not a second production rendering engine. Two evaluators differ only in linear versus PCHIP interpolation; both use the same endpoint-offset tail policy described below.

Four fixtures cover monotone steep transitions, alternating extrema, a plateau with moved endpoints, and uneven x spacing. Their exact points are:

- Equally spaced x over [0,1], y = `[0, .02, .03, .85, 1]`.
- Equally spaced x over [0,1], y = `[0, .8, .1, .9, 1]`.
- Equally spaced x over [0,1], y = `[.15, .15, .4, .7, .8]`.
- `(0,0), (.01,.4), (.02,.41), (.9,.8), (1,1)`.

Each segment is sampled at 1001 positions. Identity is sampled at 40001 points from -1 through 3. Locality moves the center y of an eleven-point identity curve from .5 to .56 and measures change outside [.3,.7]. Interior slope jumps use left/right finite differences at distance 1e-7. Errors are measured in normalized encoded coordinates.

| Metric                                  | Piecewise linear |     PCHIP |
| --------------------------------------- | ---------------: | --------: |
| Maximum segment overshoot               |         2.78e-17 |  2.78e-17 |
| Maximum knot error                      |         2.78e-17 |         0 |
| Maximum identity error, including tails |         2.22e-16 |  2.22e-16 |
| Maximum estimated interior slope jump   |          39.0000 | 0.0005820 |
| Maximum change outside locality window  |                0 |         0 |

All overshoot, knot, identity and locality assertions passed at tolerance 1e-12. The finite-difference residual for PCHIP reflects rapidly varying derivatives near the tightly spaced fixture, not an analytic derivative discontinuity. Both candidates are bounded within each segment and interpolate knots; PCHIP additionally removes interior slope corners without introducing global influence. Select PCHIP for the new point curves. This is numerical evidence, not a perceptual image-quality study or performance benchmark. Deliberately nonmonotone user points remain nonmonotone; shape preservation does not mean forcing y to increase.

For reproducibility, set widths `h_i = x_(i+1)-x_i` and secants `d_i = (y_(i+1)-y_i)/h_i`. Interior derivative is zero if adjacent secants differ in sign or either is zero; otherwise use their weighted harmonic mean with weights `2*h_i+h_(i-1)` and `h_i+2*h_(i-1)`. The endpoint estimate is `((2*h0+h1)*d0-h0*d1)/(h0+h1)`, set to zero if its sign differs from d0; when neighboring secants disagree, limit magnitude to `3*abs(d0)`. Mirror for the right endpoint. Two points use the sole secant at both ends. Evaluate cubic Hermite basis per segment. Do not extrapolate the end polynomial outside its segment.

## Concrete recipe and composition recommendation

Use an independent domain owner for `toneCurves`, with channel names `rgb`, `red`, `green`, `blue` and arrays of `{x,y}`. Coordinates are finite numbers bounded to [0,1]; each channel has at least two points, first x exactly 0, last x exactly 1, and strictly increasing x. Endpoints can move vertically but cannot be deleted or moved horizontally. Intermediate y values may increase or decrease. Missing channels are identity; normalize identity channels away, and remove an empty/entirely identity owner so Edited filters remain meaningful. Validate at command and persisted recipe boundaries with one shared rule. Avoid arbitrary point-count limits; pointer spacing constraints are presentation concerns, not a replacement for strict domain ordering.

Compile once per recipe, not once per pixel. Evaluation order is existing three-slider curve, then RGB master, then the relevant color channel, then existing mixer. Composition order is explicit and noncommutative. The master acts independently on each RGB component; it is not a luminance-only operation. Alpha is unchanged. For legacy mode, retain the old byte curve stage and apply the new per-channel lookups after it; identity/absent new curves must preserve old outputs exactly. For Linear mode, encode signed sRGB once for the new master/channel composition and decode once afterward, with no byte lookup or intermediate clamp. Keep UI drawing and image rendering on the same compiled evaluator.

Shared copy/paste uses the single `toneCurves` key; all current snapshots, preset persistence, versions, sync and recipe serialization must preserve it through their existing pathways. Add the key to the existing Curve selective-copy group. Do not add another persistence or paste mechanism. Resetting only one curve channel must not change other channels or the legacy sliders.

## Signed/HDR endpoint policy

Editable endpoint y creates a choice that fixed identity endpoints did not require. Identity outside [0,1] becomes discontinuous if black is lifted or white lowered. Constant extension clips exterior variation. Extrapolating the cubic can grow or reverse unexpectedly, and endpoint-tangent extension can flatten all exterior values when the endpoint derivative is zero. Choose continuous unit-slope offset tails in encoded space:

- x below 0: `x + first.y`.
- x above 1: `x + last.y - 1`.
- x within [0,1]: PCHIP, including endpoint values.

Thus identity endpoints preserve exterior values exactly; moved endpoints shift exterior values while retaining unit slope and unbounded range. The policy is continuous but does not promise derivative continuity at the two exterior boundaries. It does not promise negative values remain negative after lifting black: crossing zero is an intentional tonal transformation, not clipping. Apply the same rule independently for master and channel curves. Old slider identity tails remain unchanged.

The experiment with endpoints .15/.8 returned -.35 for encoded input -.5 and 1.8 for encoded input 2 for both candidates. With epsilon 1e-9, the cross-boundary differences were 1.35e-9 at black and 1.95e-9 at white for PCHIP, consistent with continuity rather than an endpoint jump. These values are encoded-domain observations; a later render test must additionally exercise signed sRGB encode/decode and floating-point image samples.

## Implementation acceptance targets

Verify invalid/duplicate x rejection, endpoint protection, insert/move/delete/reset, channel switching, keyboard access, source/revision-safe drag commits, and undo/redo. Verify exact identity and absent-key legacy compatibility, knots/extrema/plateaus, master-before-channel order, alpha/source immutability, signed/HDR tails and a rendered per-channel color change. Exercise both processing versions, selective-copy reset, saved version/preset/reload, and real exported image samples. Browser tests alone cannot establish native WebView layout or platform support. No Adobe interpolation fidelity should be claimed from this record.

## Implementation decision

The [accepted decision](../docs/decisions/017-point-tone-curves.md) follows the interpolation and composition proposal with one deliberate normalization refinement: more than two identity knots remain stored and selectable, because removing them would erase newly added editing handles. Only the default two identity endpoints are removed on reset; the Edited filter tests actual curve effect. The renderer returns unchanged samples exactly for identity channels, including exterior identity tails evaluated as `x + (last.y - 1)` to avoid unnecessary cancellation. The implementation additionally uses segment-scaled tangents to keep valid very narrow intervals finite. Product behavior is owned by [tone curves](../docs/tone-curves.md); actual verification results belong in acceptance rather than this earlier numerical experiment.
