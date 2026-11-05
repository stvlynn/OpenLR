# Photo organization and versions

The [research record](../research/catalog-organization.md) separates Lightroom documentation and static resource observations from OpenLR's own implementation. All operations below use `app.run`, also exposed by the [agent CLI](agent-cli.md).

## Selection and batch actions

Click a photo to make it the single selection and active editor image. Ctrl/Command-click toggles it in the selection. Shift-click selects the visible range from the anchor; Ctrl/Command-Shift extends that range. Select all and Ctrl/Command-A select the current filtered view. Clear selection empties the selection. Filtering and changing scopes prevent hidden photographs from staying selected.

The outlined active photo supplies the editor, preview, single-photo CLI export, copy source, and versions. GUI Export and Export again process the selected group when more than one photo is selected; see [batch export](batch-export.md). Star rating, flag, keywords, album membership, Delete/Restore, and Paste edits apply to the selected group. A slider change changes only the active photo. Batch writes finish one photo at a time; a failure reports the completed count and stops, rather than pretending the whole group was updated.

Copy edits takes an independent snapshot of the active recipe, including its process version. Paste edits replaces selected photos' recipes and creates a per-photo session undo entry. Ctrl/Command-C and Ctrl/Command-V invoke these actions outside text fields. CLI `copy-edits` optionally accepts `keys` for selective copying. An absent copied key resets that key on the target; other target keys, including the process version unless explicitly selected, are preserved. Clipboard contents and undo history last only for the current GUI session.

**Choose edits…** opens a grouped checkbox dialog for selective copying through the same command. All categories are checked initially, and choices remain for the current session. All and None change the checked categories; Copy is disabled when none are checked. Cancel and Escape leave the existing clipboard unchanged. The ordinary Copy edits button and keyboard shortcut continue to copy the complete recipe. The chooser guards the photo that was active when opened: changing the active photo before confirmation rejects the copy visibly, without changing the clipboard. Confirmation snapshots that photo's current recipe, so edits made to the same photo while the chooser is open are included.

Categories cover Light, Color, Curve, Color grading, Color mixer, Effects, Detail, Point color, Crop and rotation, Optics and geometry, Masks/repairs/lens blur, Content-aware removal, Red-eye correction, Video trim and Processing version. Optics and local tools each copy their complete stored owner, including perspective and depth respectively. Selecting all categories copies these supported keys; complete Copy edits additionally preserves any other stored recipe fields. Ratings, flags, keywords, albums and saved versions are not edit keys.

Curve includes the original three sliders and the complete `toneCurves` owner for RGB and channel point curves. Neutral identity knots remain editable but do not alone mark a photo Edited; named versions, presets and full copied recipes preserve them. See [point curves](tone-curves.md).

CLI `copy-edits` optionally accepts `photoId` for the same active-photo guard; omitting it retains execution-time selection behavior. It is not an alternate copy source. Selection choices do not alter the source photo, and Paste retains the existing per-photo undo and original-preservation rules. Supported category boundaries and the full-versus-selective browser experiment are recorded in [selective-copy research](../research/selective-copy.md).

Color grading copies its complete `colorGrading` owner. Dormant hue, balance and blending choices without tint or luminance do not mark a photo Edited. See [color grading](color-grading.md).

## Undo and redo

Ctrl/Command-Z and Ctrl/Command-Shift-Z use the shared `history-undo` and `history-redo` commands. In Grid, they choose the most recent applicable entry between library organization history and the active photo's edit history. Pasting settings in Grid can therefore be undone without changing an earlier rating. Detail and Local retain active-photo edit history. A multi-photo paste still creates per-photo entries: select each photo to undo its pasted recipe. Changing selection never makes a shortcut undo another photo's edit.

The explicit `undo`/`redo` commands and photo-edit controls remain scoped to the active photo. `library-undo`/`library-redo` remain explicitly scoped to library organization. The two histories keep their existing independent redo branches; contextual commands choose their newest applicable entry rather than merging or duplicating records. Successful replay receives a new session order, so alternating photo and library undo operations redo in reverse replay order. A failed replay does not move its history entry to the opposite stack. History is cleared on library/local source changes and is not persisted across restart.

## Albums

Albums are lists of imported-library photo IDs, and one photo can belong to multiple albums. Selecting an album limits the view. Membership adds the chosen album to the entire selection unless all selected photos already belong to it; then it removes them. Rename preserves the album ID and memberships. Delete album confirms that photos will stay in the library and other albums; the album record and imported-photo membership changes commit in one catalog transaction.

Albums belong to the imported library. Local folders retain their own metadata and edits in sidecars, so album navigation and membership are disabled there. Import a local photo into Library to organize that catalog copy in albums.

Choose **Smart album from current filters** in Create album, or run `album --name 'Unedited' --smart true`, to save the current search, minimum rating, flag and edit-status criteria as a live rule. Its members update when matching photo metadata or edits change; they are not manual memberships. The saved criteria persist through restart and use the same matching rules as the ordinary filtered view. In particular, an absent processing version, explicit Original version 1, and Linear version 2 all remain Unedited when the recipe is otherwise neutral. An actual adjustment makes the photo Edited. Choose **Edit rules** on a selected smart album to review and replace its saved search, minimum rating, flag and edit-status criteria. Cancel leaves the saved rule unchanged. CLI `album-rule` accepts the same complete four-field rule. Editing preserves the album ID, name and other metadata; it does not modify photo recipes, original bytes or manual memberships. Current temporary search/filters remain unchanged and continue to intersect with the saved album rule. Selection is reconciled when a photo no longer matches. Rules persist through restart, and library/contextual Grid undo and redo restore the previous rule. Saving an identical rule creates no write or history entry. Ordinary albums and local-folder mode reject this operation. Storage failure leaves both the displayed and stored album unchanged.

## Named versions

Open Versions in the detail editor and choose Save version. A version stores a name, ID, timestamp, and independent copy of the complete edit recipe on the active photo. Restore applies that recipe to the same photo and can be undone during the session. Rename and Delete version change the saved snapshot record; deleting a version leaves the current edits unchanged.

Versions persist with imported catalog records or local sidecars and survive restart. Subsequent edits, copied settings, and resets do not mutate an existing version. This implementation provides named snapshots rather than automatic session versions. Saved snapshots also travel with explicit library sync.

## Filtering and ordering

The current scope, text search, minimum star rating, flag, and edited status combine to determine visible photos. Search matches filenames, keywords, camera make/model and lens metadata. Edited status checks whether the recipe has a non-default stored value, ignoring `processVersion` metadata. Sort by added time, numeric-aware filename, or star rating, with ascending or descending direction. These view settings and selection are session state; photo metadata, recipes, named versions, albums, and memberships are persisted.

Named versions and full copied recipes preserve an explicit process version or its absence. Saved adjustment presets retain an explicit version when present; existing and built-in presets without one remain legacy recipes and are not rewritten merely by loading them. OpenLR XMP recipes preserve the version, depth raster and provenance, and lens-blur settings; importing validates the version, normalized raster, and blur settings with the same domain validators used by editing. An absent version means legacy processing; unsupported versions are rejected.

```powershell
node cli/openlr.mjs schema select-many
node cli/openlr.mjs select-all
node cli/openlr.mjs rate --value 4
node cli/openlr.mjs filter --rating 3 --flag pick
node cli/openlr.mjs sort --order name --direction asc
node cli/openlr.mjs album-rule --id ALBUM_ID --rule '{"text":"sunrise","rating":3,"flag":"pick","edited":"any"}'
node cli/openlr.mjs version-save --name 'First edit'
node cli/openlr.mjs copy-edits
node cli/openlr.mjs paste-edits
```

`state` returns `selected` (active ID), `selection` (group IDs), `filters`, `sortDirection`, clipboard metadata, and each visible photo's saved versions. Read version and album IDs from it before applying ID-based commands. The CLI reads its schema from the same command catalog as the GUI agent.

`tests/organization.test.js` verifies real browser UI selection, batch metadata, album rename/delete, version restore, copied settings and undo, filters/sorting, restart persistence, and original-byte preservation. Native local-folder and sidecar checks belong to the native integration suite; browser testing alone does not establish native behavior.

`node --test tests/process-version-transport.test.js` checks neutral filtering, independent copied/saved recipes, real browser XMP round trips with depth settings, and IndexedDB preset reloads while preserving legacy records.

`node --test tests/smart-albums.test.js` checks shared rating/flag/edit-status matching and actual browser GUI creation/reload of smart albums, including neutral version 1/version 2 recipes, edited version 2 recipes, live membership changes, and counts through the CLI's shared dispatch path. This browser check does not establish native CLI transport behavior.

`node --test tests/history-workflow.test.js` checks actual Grid keyboard routing, interleaved photo/library undo and redo, active-photo isolation, explicit history commands, Detail scope, failed-command handling, batch per-photo behavior and unchanged original bytes. `scripts/native-smoke.mjs` repeats the shared contextual commands and smart-album membership in the real desktop application.

`tests/smart-album-editing.test.js` verifies the actual dialog, cancellation, non-default session filters, live membership, selection boundaries, restart and original bytes. It injects an IndexedDB write failure to verify memory/storage/history consistency, and checks complete validation, no-op history and undo/redo. Native smoke repeats rule replacement, membership, history and actual CLI workspace capture. Primary-source evidence and the replacement-versus-patch experiment are in [smart album editing research](../research/smart-album-editing.md).

## Pending confirmations

Permanent deletion operates on the selected deleted library photos. The existing GUI confirmation captures the complete selected ID set when opened. On confirmation, shared `purge` checks that current membership is identical before entering the existing deletion transaction. A changed active photo or added/removed selection rejects visibly without deleting any row or original. Reordering the same set is permitted. Cancel and Escape perform no deletion; opening the dialog again captures a fresh set.

CLI `purge` optionally accepts `expectedIds`, an array of photo IDs with set semantics. It is a selection guard, not a new target list: use `select-many` to select the intended deleted photos first. Omitting the guard preserves existing execution-time selection behavior. Local-folder records, live photos and empty selections remain ineligible. Original storage is released only when no surviving catalog photo references it; external original files are not deleted.

Album rename and delete dialogs capture their album ID when opened and submit it through the existing explicit-ID commands. A later `scope` command cannot redirect the dialog to a different album. If that original album no longer exists, the command reports the existing not-found error. These changes add no confirmation layer or alternate mutation path. Actual drift evidence and alternatives are in [confirmation targets](../research/confirmation-targets.md); `tests/confirmation-targets.test.js` covers real dialogs and persisted results.
