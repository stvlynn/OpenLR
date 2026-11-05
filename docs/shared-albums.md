# Shared albums and review

OpenLR includes a standalone **`openlr-share`** service and browser viewer under the repository's AGPL license. It does not connect to Adobe services. Publishing uses the existing selected library album and rendered edits; the remote page is a view/review gallery, not another catalog editor.

## Run the independent server

Build it with the same Go toolchain as the project:

```sh
go build -o build/openlr-share ./cmd/openlr-share
build/openlr-share -addr 127.0.0.1:8788 -data .workspace/review-data -session .workspace/review-session.json
```

On Windows use an `.exe` output name. The default bind address is loopback. `-data` owns persistent album metadata, JPEG previews, comments and likes. `-session` writes a private descriptor with the local server URL and administrator token. Alternatively set `OPENLR_SHARE_ADMIN_TOKEN` to a persistent administrator token; keep it stable across restarts when using an existing publisher configuration. The token is never printed by the service.

For a separately deployed server, run this same binary with persistent storage and a user-managed HTTPS reverse proxy. Configure the desktop with its reachable HTTP(S) base URL and administrator token. No public hosting or account is created automatically. The implementation does not require a commercial service or vendor SDK. The public viewer and server sources are in `internal/review/` and `cmd/openlr-share/`.

## Publish and review

In **Share & review album**, enter the server URL/token and connect, select a library album, then choose **Publish current album**. OpenLR renders its non-deleted photos as JPEG previews with a maximum edge of 1920 pixels using the current edits. It uploads previews and filenames; original files and edit recipes stay in the catalog. Video publication is rejected explicitly. The returned link opens an actual browser gallery.

```sh
node cli/openlr.mjs share-configure --endpoint http://127.0.0.1:8788 --token <admin-token>
node cli/openlr.mjs share-publish --album <album-id>
node cli/openlr.mjs share-reviews --album <album-id>
node cli/openlr.mjs share-revoke --album <album-id>
```

Album arguments default to the current GUI album scope. `share-publish` also accepts `--comments false` and `--likes false`. Native configuration is stored in the user's `OpenLR/sharing.json`; test overrides are `OPENLR_SHARE_FILE`, `OPENLR_SHARE_URL` and `OPENLR_SHARE_TOKEN`. Native state/readback omits the administrator token.

Review access requires the album's random secret link. Anyone possessing that link can view its previews and, when enabled, enter a display name, like photos and post comments. No administrator token is given to reviewers. Display names are not verified accounts, and likes use a browser-local identifier. There are no email invitations, contributor uploads, collaborative image editing, per-person roles, or Adobe identity integration in this implementation.

**Read comments & likes** returns server-persisted reviews to the current GUI; the CLI returns the same data. **Revoke album link** denies subsequent album-data and image requests using that link. Republish after revocation creates a new secret link. The viewer uses no third-party scripts or analytics and inserts review text as text rather than HTML.

The desktop groups feedback by photo filename and shows reviewer names, comment text, local timestamps and like counts. It does not display internal identifiers or raw protocol JSON. Empty reviews and revoked links have explicit states; feedback referring to a photo no longer listed by the server is shown under “Unavailable photo.” CLI review fields remain structured and unchanged. Review text is inserted as text in both interfaces, preserving line breaks without executing markup.

## Verified scope

`go test ./...` covers administrator authentication, album/image access checks, persisted comments/likes, omitted public token fields and revocation. The real acceptance test is:

```sh
node scripts/native-sharing-smoke.mjs <OpenLR executable> <openlr-share executable>
```

It starts only a loopback review server and isolated native workspace, generates a PNG, publishes the edited album through the native dispatcher, opens the real page in Chrome, posts a like and comment, reads them back through the GUI/CLI, and verifies unauthorized/revoked responses and unchanged source bytes. It passed on Windows/WebView2. Artifacts are `.workspace/native-final/shared-album-review.png` and `sharing-report.json`. This test did not publish to the Internet, upload private photos, invoke Adobe services or test an external deployment's TLS/proxy configuration.
