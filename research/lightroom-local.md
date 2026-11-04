# Lightroom Local evidence

Reviewed 2026-11-05 using Adobe's [Local access documentation](https://helpx.adobe.com/lightroom/desktop/add-import-and-capture-photos/access-photos.html) and [adding photos documentation](https://helpx.adobe.com/lightroom/desktop/add-import-and-capture-photos/add-photos.html). This is documentation evidence, not a runtime capture or copied implementation.

Adobe describes Local as direct access to local and connected-drive media without first importing or cloud syncing it. Its documented workflow includes browsing and favoriting folders, optional subfolder inclusion, and non-destructive edits that require export for other applications to see the rendered result. Adobe stores edit metadata internally for some formats and in accompanying XMP files for others. Importing/copying to cloud is a separate workflow.

OpenLR takes the direct-folder and non-destructive workflow requirements from the user's request. It uses its own directory authorization, lazy file adapter and JSON sidecars. It deliberately leaves original bytes untouched for every supported source type rather than embedding metadata inside originals. It does not claim Adobe XMP compatibility, cloud behavior, drive browsing beyond authorized roots, or parity with every Local folder-management feature. See [the implemented contract](../docs/local-folders.md).
