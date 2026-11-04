# Sync a library

Use **Sync** and enter an existing WebDAV folder on a server you control. The operation sends the imported library's originals, edit recipes, albums and presets to that folder. Authorized local photo folders keep their sidecars on disk and are outside this transfer. The app remembers the endpoint. Credentials live in memory during the request.

A new device can use the same folder to receive the library. The CLI accepts `sync --endpoint URL --username NAME`; set `OPENLR_DAV_PASSWORD` for a password or application token. HTTPS is required outside loopback. Use a separate folder for each library.

The remote holds one catalog manifest and immutable original assets. Changes on different fields can merge, including independent changes to stars and exposure. If both devices change the same value since their common baseline, the UI displays the affected records. Selecting local or remote resolves those conflicting fields. The manifest uses strong ETags with conditional PUT. Use a WebDAV server that enforces HTTP If-Match and If-None-Match for writes. Originals upload before the manifest, and downloaded edits and their local baseline commit in one IndexedDB transaction.

The development tests use a local DAV transport and two isolated libraries. No production provider account is part of automated validation. OpenLR sync has no connection to the Adobe account on the host. Adobe's own Lightroom catalog API requires a registered partner integration and explicit OAuth authorization. [Adobe customer authentication](https://developer.adobe.com/lightroom/lightroom-api-docs/getting-started/authenticate-customers/) · [WebDAV update semantics](https://www.rfc-editor.org/rfc/rfc4918#section-8.6) · [Joplin synchronization design](https://joplinapp.org/help/dev/spec/sync/)

