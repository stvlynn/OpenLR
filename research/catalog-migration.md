# Catalog migration evidence and validation boundaries

Reviewed 2026-11-05. No private library was scanned, no Adobe catalog fixture was taken from an installed application, and no migration asset was uploaded to Adobe or Apple services. Tests create their own SQLite capability schema and PNG resources in isolated folders.

## Product/source evidence

Adobe's [Classic migration guide](https://helpx.adobe.com/lightroom/desktop/migrate-photos/migrate-to-lightroom-cc.html) distinguishes database references/settings from full originals and explains collection-to-album migration plus exclusions. Its [migration errors](https://helpx.adobe.com/fi/lightroom/desktop/kb/migration-errors.html) explains closing Classic, missing originals and version prerequisites for Adobe's own migrator. Those prerequisites do not establish OpenLR compatibility, and OpenLR does not adopt Adobe's implicit cloud upload behavior.

The installed Lightroom menu identifiers `ag.file.import.migrateLrCat` / `migrateApplePhotos` motivated independent local migration entries. They establish available product actions, not schema or executed migration evidence. No proprietary migrator was executed or copied.

Public schema references were inspected, not imported as application code:

- [camerahacks/lightroom-database](https://github.com/camerahacks/lightroom-database/blob/master/README.md) describes image/file/folder/root and keyword relationships, develop text and XMP storage. Its documentation is unofficial and does not certify Adobe release support. No code or prose was copied.
- [shengwu/lightroom-hacking](https://github.com/shengwu/lightroom-hacking/blob/master/README.md), MIT in its README, records a real Lightroom 5 SQLite inspection, pick values `-1/0/1`, and scalar develop settings in Lua-table text. OpenLR only uses the observed relationship facts; it never executes or writes those catalog scripts. Its legacy processing values are not reinterpreted as modern exposure fields.
- [JeremyProffittOrg/lrcat-go schema.go](https://github.com/JeremyProffittOrg/lrcat-go/blob/main/schema.go), [collection.go](https://github.com/JeremyProffittOrg/lrcat-go/blob/main/collection.go) and [xmp.go](https://github.com/JeremyProffittOrg/lrcat-go/blob/main/xmp.go) document contemporary table relationships, collection kind identifiers and a four-byte big-endian uncompressed-length header followed by zlib XMP. Its chosen schema variable is `1500000`. No root license file was found in the inspected listing; **no code or fixture is copied from this repository**. OpenLR's SQL adapter/fixture and decompression logic are independently written. The declared number is evidence about that project's schema, not a verified Adobe catalog release.

Compatibility is therefore capability-based. Core tables/columns are required before querying; optional supported relationships are read separately, unknown data stays unmapped, and the reported DBVersion is preserved. The synthetic fixture uses `1500000` and also tests an unknown future string to prove that no unverified release claim is encoded. A genuine authorized Adobe-produced catalog would be required for further real-world compatibility validation.

## Apple export boundary

Apple's [Photos export guide](https://support.apple.com/en-in/guide/photos/-pht6e157c5f/mac) provides the standard original-resource and IPTC-XMP export path used here. [PhotoKit resource writing](https://developer.apple.com/documentation/photos/phassetresourcemanager/writedata%28for%3Atofile%3Aoptions%3Acompletionhandler%3A%29) would be a separate native, authorized macOS integration. This Windows workspace has no verified PhotoKit runtime; OpenLR implements standard exported resources instead and rejects Photos Library package traversal.

Adobe's [Apple Photos migration guide](https://helpx.adobe.com/lightroom/desktop/migrate-photos/migrate-apple-photos-library.html) and [error guide](https://helpx.adobe.com/lightroom/desktop/kb/apple-photos-migration-errors.html) show that original availability, library access and special assets require explicit handling. OpenLR makes no claim to reproduce that proprietary migrator: standard export cannot supply Photos edits/favorites/face data/original album relationships or iCloud-only bytes. The tested Apple fixture is a generated PNG plus independently authored standards-based XMP in an explicit export directory, not a real Photos library.

## Engine and implementation

Context7 `/sql-js/sql.js` was queried for offline `initSqlJs`, `locateFile`, `Database(Uint8Array)` and prepared-statement lifetime. The implementation pins [sql.js v1.15.2](https://github.com/sql-js/sql.js/tree/v1.15.2), retaining its MIT license/AUTHORS. Its [Makefile](https://github.com/sql-js/sql.js/blob/v1.15.2/Makefile) identifies SQLite amalgamation `3540000` and contributed `extension-functions.c`; engine queries confirmed SQLite **3.54.0**, source ID `2026-10-09 15:46:58 be8d059e9a49089ab2dce5ed26dd87aaf598fdc5fbe0b107c0dd758464bcd5e3`. SQLite's [public-domain statement](https://sqlite.org/copyright.html) applies to the core; Emscripten notices and contributed-extension credits accompany the package. No SQL engine or catalog parser is downloaded at runtime.

The selected database is copied into WASM memory with `query_only=ON` and `trusted_schema=OFF`. Only fixed table/column queries are issued; catalog data never becomes SQL, JavaScript or Lua code. Native filesystem authorization comes from a separate user-selected folder root. Catalog absolute paths remain report/provenance data. Relative traversal, unapproved roots and nonregular/missing resources fail; no best-filename or first-file guessing is used. Resampling and existing XMP interpretation are shared with the normal image pipeline rather than a competing migration renderer.

## Observed checks

The browser E2E and actual Windows/WebView2 native smoke both passed using only generated fixtures. They verify root mapping, exact native stream/original export, immutable source bytes, incomplete/missing reports, retry, metadata, static collections, virtual copies and Apple standard export XMP. The browser E2E additionally verifies explicit sync to an in-memory test WebDAV backend: one original per shared virtual-copy asset, no native paths in portable manifests, remote-device database originals, and local edit updates retaining the original device's authorization. No Internet library publication is performed.

Artifacts `.workspace/native-final/migration-report.json` and `migration-synthetic.png` distinguish the evidence explicitly: native reference protocol tested, genuine Classic catalog not tested, private Photos Library not read, PhotoKit not tested. These limits are also stated in the user documentation and must be preserved in release notes.
