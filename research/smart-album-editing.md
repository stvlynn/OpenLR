# Editing saved smart-album criteria

Reviewed 2026-11-05. This is evidence and an OpenLR design comparison, not a claim that the installed Adobe implementation has been reproduced.

## Evidence boundary

The existing [catalog investigation](catalog-organization.md) records REA Evidence `ev_b95ac8eed4d87f5fc5c661b7f17cc4e7542aa25688ca56288715da4b3ade96fc` for the installed Lightroom 9.4 PE resource inventory, including an organization controller. It also records static album/version labels and their limits. Neither that inventory nor the previously recorded single-photo runtime interactions establish smart-album rule editing, persistence or undo behavior in the installed build. No new native execution was performed for this focused investigation; matching existing evidence was reused. No Adobe payload, asset, catalog or private photograph is imported.

Adobe's primary [Lightroom desktop organization guide](https://helpx.adobe.com/lightroom/desktop/organize-photos/organize-photos.html), marked updated April 16, 2026 and retrieved on the review date, documents creating smart albums from filtered results or the Albums panel, specifying rules, editing an existing smart album, and membership updating as photo information changes. It separately describes ordinary view filtering. This is current product documentation, not measured runtime behavior of installed 9.4. The richer criteria and folder controls on that page are not automatically implemented or required by this four-field increment.

Context7 resolved `/darktable-org/darktable`; a focused collection/filter query returned `list_images` and the separate lighttable undo context. The primary [Darktable MCP documentation](https://github.com/darktable-org/darktable/blob/master/src/mcp/README.md) was independently fetched and checked: its catalog list operation exposes explicit optional filters, while rating/history mutation has distinct operations. It does not define a saved-album replacement API or prescribe OpenLR's dialog behavior. That distinction supports keeping catalog queries separate from stored-rule mutation, but the update contract below is an OpenLR decision. No upstream implementation is copied.

## Existing OpenLR responsibility

At `67fedc9`, saved smart albums have `{text,rating,flag,edited}` rules. `smartMatch` delegates rating/flag/edited matching to `matchesCatalogFilters`; neutral processing-version metadata is already excluded from the Edited predicate. Saving a rule is currently possible, but its criteria cannot subsequently be edited through GUI or CLI. The normal view combines scope, search and session filters. The missing operation should reuse those owners rather than introduce another rule evaluator.

## Replacement versus patch experiment

Executed using Node 24.9 and the actual `web/stacks.js` matcher. These are generated metadata records, not photographs or a GUI test. The intended operation changes an old camera/pick/three-star/unedited rule into all edited photos. A partial update containing only the changed edit-status field intentionally retains the old restrictions; it therefore cannot express the intended broadening without also explicitly clearing the other fields. A fully specified patch and full replacement have identical membership. The experiment does not claim that patch semantics are universally wrong.

| Rule operation | Matching IDs |
| --- | --- |
| Existing saved rule | `old` |
| Explicit full replacement | `new`, `both` |
| Patch only `edited:yes` | `both` |
| Patch specifying all four desired fields | `new`, `both` |
| Replacement plus unchanged current search `camera` | `both` |

Reproduce from the repository root:

```js
import { smartMatch } from './web/stacks.js'
const photos = [
  {id:'old',name:'camera.png',rating:4,flag:'pick',edit:{}},
  {id:'new',name:'landscape.png',rating:0,flag:'',edit:{Exposure:.5}},
  {id:'both',name:'camera-edited.png',rating:5,flag:'pick',edit:{Exposure:.5}}
]
const saved = {text:'camera',rating:3,flag:'pick',edited:'no'}
const desired = {text:'',rating:0,flag:'any',edited:'yes'}
const match = rule => photos.filter(photo => smartMatch(photo, rule)).map(photo => photo.id)
console.log({
  before: match(saved),
  explicitReplacement: match(desired),
  partialEditOnly: match({...saved,edited:'yes'}),
  fullySpecifiedPatch: match({...saved,...desired}),
  viewIntersection: photos.filter(photo => smartMatch(photo, desired)
    && photo.name.includes('camera')).map(photo => photo.id)
})
```

## Recommended contract and verification

Use a distinct full-rule replacement operation addressed by album ID, with all four fields represented explicitly. This matches a dialog populated from the saved rule and makes clearing a criterion unambiguous. A single validated catalog update should preserve album identity, name, unrelated album fields and all photo membership/edit/original records. Cancellation leaves storage unchanged. Reject editing a manual album as a smart rule, invalid values and unavailable IDs; do not silently convert album types.

Keep current search and transient filters unchanged. The visible result remains their intersection with the updated saved rule, so the current view can be narrower than the album's overall membership. Resetting filters would make an unrelated session-state mutation, and would behave differently from ordinary album navigation. Test this explicitly rather than attributing the choice to Adobe.

Reuse existing library history for rule replacement where album changes are already recorded; do not create independent undo stacks or duplicate photo snapshots. Verify GUI/CLI parity, reopening a populated dialog, cancel, invalid requests, undo/redo, persistence through reload, changing membership after later photo edits, current-filter preservation, and byte-identical originals. Native CLI with actual state/capture is separate evidence from browser tests. Multi-rule Boolean trees, additional metadata fields, folders and exact Adobe UI equivalence remain outside this measured experiment.
