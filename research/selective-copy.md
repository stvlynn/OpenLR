# Selective copy: evidence and UI decision

Reviewed 2026-11-05. This record distinguishes the existing OpenLR contract, a browser experiment, and a proposed presentation. Product behavior belongs in [catalog organization](../docs/catalog-organization.md). Lightroom observations belong in the [runtime research record](lightroom.md); they do not establish new OpenLR requirements.

## Existing contract and observed gap

At `aebff7e`, `web/organization-ui.js` wires **Copy edits** directly to `copy-edits` without arguments. There is no key chooser in that feature. The same dispatcher already accepts `copy-edits { keys: [...] }` through `web/agent-protocol.js`, calls `Organization.copy` in `web/organization.js`, and uses the existing `paste-edits` batch/undo path. This is an interface gap in an implemented capability, not a need for a second paste engine.

Omitting `keys` snapshots the full recipe and later replaces the target recipe. An explicit array copies only those top-level owners. If a selected key is absent from the source, paste deletes it on the target, resetting that setting. Unselected keys remain unchanged. This includes `processVersion`: selective exposure copying preserves the target version; explicitly selecting an absent source version removes the target field, restoring legacy interpretation. The clipboard is an independent snapshot. Empty arrays and arbitrary string keys are currently accepted by the domain; a graphical chooser need not expose empty confirmation or invent a second validator.

## Controlled baseline experiment

Executed `node .workspace/selective-copy-ablation.mjs` in Windows, Node v24.9.0, Chrome 156.0.8078.80, headless. All JavaScript module responses were pinned to `git show aebff7e:web/<module>` to isolate concurrent implementation work. The browser used two generated 80 × 60 PNGs in an isolated browser context and the real browser app/IndexedDB, dispatcher and Copy/Paste buttons. No personal photograph or Adobe asset was used. Local diagnostic JSON is `.workspace/selective-copy-ablation.json` and is intentionally untracked.

Source: Exposure 1; crop `(0.1, 0.1, 0.8, 0.8)`; absent Contrast and processing version. Target: Exposure -1; Contrast 10; crop `(0.2, 0.2, 0.5, 0.5)`; processVersion 2.

| Intervention                                                    | Exposure after paste | Target crop        | Contrast | Processing version |
| --------------------------------------------------------------- | -------------------- | ------------------ | -------- | ------------------ |
| Existing GUI Copy, GUI Paste                                    | 1                    | Replaced by source | Removed  | Removed            |
| Undo, then dispatcher Copy with `keys: ['Exposure']`, GUI Paste | 1                    | Preserved          | 10       | 2                  |
| Copy absent `Contrast`, dispatcher Paste                        | 1                    | Preserved          | Removed  | 2                  |

Assertions passed, including exact undo restoration and zero browser page errors. The selective path uses the browser dispatcher API also exposed to the CLI; this experiment did not launch the native CLI. It validates recipe state and existing persistence execution, not rendered pixel equivalence or native dialog layout. The full-copy result is correct for its documented contract; it demonstrates why users need a way to choose settings without replacing composition.

## Presentation recommendation

Keep immediate **Copy edits** and its shortcut. Add a **Choose edits…** action using a native modal dialog with labeled checkboxes and explicit Copy/Cancel. Build the options from the existing control owners, return selected top-level keys, and call the central dispatcher once only after confirmation. Cancel/Escape must leave the clipboard and recipes untouched. Bind confirmation to the source photo captured at opening; a background selection change must not silently copy a different photo. Reuse the existing paste, selection, storage and undo implementations.

A grouping proposal covering the currently implemented recipe owners follows. The implementation may adjust display labels, but must preserve the mapping and avoid advertising unsupported nested independence.

| Group                | Keys / existing owner                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Light                | `Exposure`, `Contrast`, `Highlights`, `Shadows`, `Whites`, `Blacks` from `controls.Light`                                            |
| Color                | `Temperature`, `Tint`, `Vibrance`, `Saturation` from `controls.Color`                                                                |
| Curve                | `Curve shadows`, `Curve midtones`, `Curve lights` from `controls.Curve`                                                              |
| Color mixer          | Existing 24 controls: Red, Orange, Yellow, Green, Aqua, Blue, Purple and Magenta × Hue, Saturation and Luminance; plus `pointColors` |
| Effects              | `Texture`, `Clarity`, `Vignette`, `Grain` from `controls.Effects`                                                                    |
| Detail               | `Sharpening`, `Noise reduction` from `controls.Detail`                                                                               |
| Crop and orientation | `crop`, `aspect`, `turn`, `flip`                                                                                                     |
| Optics               | `optics`, including correction and perspective settings as one owner                                                                 |
| Local adjustments    | `localTools`, including masks, repairs, depth and lens blur as one owner                                                             |
| Fill                 | `fills`                                                                                                                              |
| Red eye              | `redEyes`                                                                                                                            |
| Video trim           | `trim`                                                                                                                               |
| Processing           | `processVersion`                                                                                                                     |

Groups may have individual child checkboxes for separate top-level keys. `optics` and `localTools` are atomic with the current contract: showing separate mask/repair or lens/perspective toggles would falsely promise semantics the engine does not implement. Photo metadata, ratings, flags, albums and saved versions are outside the edit recipe. Enhancement creates derived assets rather than a selectable enhancement recipe key. A select-all action can enumerate supported keys; the existing full-copy action remains the way to replace the entire recipe, including any unlisted extension fields.

The measured alternatives are full recipe replacement and selective reuse of the existing dispatcher. A new paste engine has no demonstrated benefit and duplicates persistence/history responsibilities. A free-text JSON key field exposes implementation details already representable by labels. Neither is justified. Lightroom's observed All/Modified/Default/None menu is inspiration only: this bounded runtime observation did not establish how Modified or Default classify every setting. Do not invent those semantics or import Adobe group labels/assets as source material.

## Primary documentation

Context7 resolved `MDN Web Docs` to `/mdn/content`, then queried native dialog confirmation/cancel and checkbox state. Its primary [dialog documentation](https://github.com/mdn/content/blob/main/files/en-us/web/html/reference/elements/dialog/index.md) describes `showModal()`, form dialog submission, and the cancel/close lifecycle. The [requestClose documentation](https://github.com/mdn/content/blob/main/files/en-us/web/api/htmldialogelement/requestclose/index.md) includes reading checkbox `.checked`, clearing `returnValue` on opening, and handling cancellation. These facts support native accessible controls and explicit confirmation; they do not define OpenLR copying rules. Reusing a dialog requires resetting its return value so a prior successful confirmation cannot turn a later Escape into a copy.

No third-party code or prose was copied. The proposed implementation follows the existing [template boundaries](../docs/template-conventions.md): presentation delegates recipe rules to their owner, and all live interactions use the shared command queue. Required implementation verification: chooser cancellation and source changes, selective reset of absent keys, version preservation, independent clipboard snapshots, selected-group paste/undo, and narrow-screen/keyboard dialog access.

## Implemented boundary

`web/copy-options.js` derives the six adjustment groups from the existing controls and lists the remaining recipe owners. Point color has its own checkbox, separate from the color mixer proposal above. `web/copy-options-ui.js` owns only the modal interaction and dispatches selected keys with the captured source ID. All groups start checked; later choices last for the session. The dispatcher checks the optional source guard before replacing the clipboard, then uses the unchanged copy/paste domain. Confirmation captures the current recipe of that source, rather than a recipe snapshot taken when opening the chooser.

The actual 1024 × 768 Chrome dialog was inspected: its bounds were x=317–707, y=89.25–678.75, and scroll/client widths both 388 pixels. All categories and actions were visible without clipping or horizontal overflow. The screenshot contains a generated fixture and remains an untracked diagnostic. `tests/selective-copy.test.js` covers actual checkbox, button and Escape interactions, independent snapshots, selected absent-key reset, retained crop/version, batch per-photo undo, source drift and same-source edits before confirmation. Native smoke exercises the same guarded command with real CLI transport and a real PNG workspace capture; final environment-specific results belong in [acceptance](../docs/acceptance.md).
