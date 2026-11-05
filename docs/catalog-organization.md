# Photo organization and versions

The [research record](../research/catalog-organization.md) separates Lightroom documentation and static resource observations from OpenLR's own implementation. All operations below use `app.run`, also exposed by the [agent CLI](agent-cli.md).

## Selection and batch actions

Click a photo to make it the single selection and active editor image. Ctrl/Command-click toggles it in the selection. Shift-click selects the visible range from the anchor; Ctrl/Command-Shift extends that range. Select all and Ctrl/Command-A select the current filtered view. Clear selection empties the selection. Filtering and changing scopes prevent hidden photographs from staying selected.

The outlined active photo supplies the editor, preview, export, copy source, and versions. Star rating, flag, keywords, album membership, Delete/Restore, and Paste edits apply to the selected group. A slider change changes only the active photo. Batch writes finish one photo at a time; a failure reports the completed count and stops, rather than pretending the whole group was updated.

Copy edits takes an independent snapshot of the active recipe, including its process version. Paste edits replaces selected photos' recipes and creates a per-photo session undo entry. Ctrl/Command-C and Ctrl/Command-V invoke these actions outside text fields. CLI `copy-edits` optionally accepts `keys` for selective copying. An absent copied key resets that key on the target; other target keys, including the process version unless explicitly selected, are preserved. Clipboard contents and undo history last only for the current GUI session.

## Undo and redo

Ctrl/Command-Z and Ctrl/Command-Shift-Z use the shared `history-undo` and `history-redo` commands. In Grid, they choose the most recent applicable entry between library organization history and the active photo's edit history. Pasting settings in Grid can therefore be undone without changing an earlier rating. Detail and Local retain active-photo edit history. A multi-photo paste still creates per-photo entries: select each photo to undo its pasted recipe. Changing selection never makes a shortcut undo another photo's edit.

The explicit `undo`/`redo` commands and photo-edit controls remain scoped to the active photo. `library-undo`/`library-redo` remain explicitly scoped to library organization. The two histories keep their existing independent redo branches; contextual commands choose their newest applicable entry rather than merging or duplicating records. Successful replay receives a new session order, so alternating photo and library undo operations redo in reverse replay order. A failed replay does not move its history entry to the opposite stack. History is cleared on library/local source changes and is not persisted across restart.

## Albums

Albums are lists of imported-library photo IDs, and one photo can belong to multiple albums. Selecting an album limits the view. Membership adds the chosen album to the entire selection unless all selected photos already belong to it; then it removes them. Rename preserves the album ID and memberships. Delete album confirms that photos will stay in the library and other albums; the album record and imported-photo membership changes commit in one catalog transaction.

Albums belong to the imported library. Local folders retain their own metadata and edits in sidecars, so album navigation and membership are disabled there. Import a local photo into Library to organize that catalog copy in albums.

Choose **Smart album from current filters** in Create album, or run `album --name 'Unedited' --smart true`, to save the current search, minimum rating, flag and edit-status criteria as a live rule. Its members update when matching photo metadata or edits change; they are not manual memberships. The saved criteria persist through restart and use the same matching rules as the ordinary filtered view. In particular, an absent processing version, explicit Original version 1, and Linear version 2 all remain Unedited when the recipe is otherwise neutral. An actual adjustment makes the photo Edited. Rename and delete work for smart albums; their saved criteria currently cannot be edited through the GUI or CLI.

## Named versions

Open Versions in the detail editor and choose Save version. A version stores a name, ID, timestamp, and independent copy of the complete edit recipe on the active photo. Restore applies that recipe to the same photo and can be undone during the session. Rename and Delete version change the saved snapshot record; deleting a version leaves the current edits unchanged.

Versions persist with imported catalog records or local sidecars and survive restart. Subsequent edits, copied settings, and resets do not mutate an existing version. This implementation provides named snapshots rather than automatic session versions. Saved snapshots also travel with explicit library sync.

## Filtering and ordering

The current scope, text search, minimum star rating, flag, and edited status combine to determine visible photos. Search matches filenames and keywords. Edited status checks whether the recipe has a non-default stored value, ignoring `processVersion` metadata. Sort by added time, numeric-aware filename, or star rating, with ascending or descending direction. These view settings and selection are session state; photo metadata, recipes, named versions, albums, and memberships are persisted.

Named versions and full copied recipes preserve an explicit process version or its absence. Saved adjustment presets retain an explicit version when present; existing and built-in presets without one remain legacy recipes and are not rewritten merely by loading them. OpenLR XMP recipes preserve the version, depth raster and provenance, and lens-blur settings; importing validates the version, normalized raster, and blur settings with the same domain validators used by editing. An absent version means legacy processing; unsupported versions are rejected.

```powershell
node cli/openlr.mjs schema select-many
node cli/openlr.mjs select-all
node cli/openlr.mjs rate --value 4
node cli/openlr.mjs filter --rating 3 --flag pick
node cli/openlr.mjs sort --order name --direction asc
node cli/openlr.mjs version-save --name 'First edit'
node cli/openlr.mjs copy-edits
node cli/openlr.mjs paste-edits
```

`state` returns `selected` (active ID), `selection` (group IDs), `filters`, `sortDirection`, clipboard metadata, and each visible photo's saved versions. Read version and album IDs from it before applying ID-based commands. The CLI reads its schema from the same command catalog as the GUI agent.

`tests/organization.test.js` verifies real browser UI selection, batch metadata, album rename/delete, version restore, copied settings and undo, filters/sorting, restart persistence, and original-byte preservation. Native local-folder and sidecar checks belong to the native integration suite; browser testing alone does not establish native behavior.

`node --test tests/process-version-transport.test.js` checks neutral filtering, independent copied/saved recipes, real browser XMP round trips with depth settings, and IndexedDB preset reloads while preserving legacy records.

`node --test tests/smart-albums.test.js` checks shared rating/flag/edit-status matching and actual browser GUI creation/reload of smart albums, including neutral version 1/version 2 recipes, edited version 2 recipes, live membership changes, and counts through the CLI's shared dispatch path. This browser check does not establish native CLI transport behavior.

`node --test tests/history-workflow.test.js` checks actual Grid keyboard routing, interleaved photo/library undo and redo, active-photo isolation, explicit history commands, Detail scope, failed-command handling, batch per-photo behavior and unchanged original bytes. `scripts/native-smoke.mjs` repeats the shared contextual commands and smart-album membership in the real desktop application.
