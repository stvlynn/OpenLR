# Photo organization and versions

The [research record](../research/catalog-organization.md) separates Lightroom documentation and static resource observations from OpenLR's own implementation. All operations below use `app.run`, also exposed by the [agent CLI](agent-cli.md).

## Selection and batch actions

Click a photo to make it the single selection and active editor image. Ctrl/Command-click toggles it in the selection. Shift-click selects the visible range from the anchor; Ctrl/Command-Shift extends that range. Select all and Ctrl/Command-A select the current filtered view. Clear selection empties the selection. Filtering and changing scopes prevent hidden photographs from staying selected.

The outlined active photo supplies the editor, preview, export, copy source, and versions. Star rating, flag, keywords, album membership, Delete/Restore, and Paste edits apply to the selected group. A slider change changes only the active photo. Batch writes finish one photo at a time; a failure reports the completed count and stops, rather than pretending the whole group was updated.

Copy edits takes an independent snapshot of the active recipe. Paste edits replaces selected photos' recipes and creates a per-photo session undo entry. Ctrl/Command-C and Ctrl/Command-V invoke these actions outside text fields. CLI `copy-edits` optionally accepts `keys` for selective copying. An absent copied key resets that key on the target; other target keys are preserved. Clipboard contents and undo history last only for the current GUI session.

## Albums

Albums are lists of imported-library photo IDs, and one photo can belong to multiple albums. Selecting an album limits the view. Membership adds the chosen album to the entire selection unless all selected photos already belong to it; then it removes them. Rename preserves the album ID and memberships. Delete album confirms that photos will stay in the library and other albums; the album record and imported-photo membership changes commit in one catalog transaction.

Albums belong to the imported library. Local folders retain their own metadata and edits in sidecars, so album navigation and membership are disabled there. Import a local photo into Library to organize that catalog copy in albums.

## Named versions

Open Versions in the detail editor and choose Save version. A version stores a name, ID, timestamp, and independent copy of the complete edit recipe on the active photo. Restore applies that recipe to the same photo and can be undone during the session. Rename and Delete version change the saved snapshot record; deleting a version leaves the current edits unchanged.

Versions persist with imported catalog records or local sidecars and survive restart. Subsequent edits, copied settings, and resets do not mutate an existing version. This implementation provides named snapshots; it does not create automatic session versions or synchronize versions through a cloud service.

## Filtering and ordering

The current scope, text search, minimum star rating, flag, and edited status combine to determine visible photos. Search matches filenames and keywords. Edited status checks whether the recipe has a non-default stored value. Sort by added time, numeric-aware filename, or star rating, with ascending or descending direction. These view settings and selection are session state; photo metadata, recipes, named versions, albums, and memberships are persisted.

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
