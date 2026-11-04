# 001: MyGo desktop host with a dependency-free web frontend

Status: accepted for the initial desktop implementation, 2026-11-05.

OpenLR needs native Windows, macOS and Linux windows while sharing its photo workflow with a browser preview. The initial image processing implementation is JavaScript and Canvas. Moving processing into an unrelated native UI toolkit would duplicate that work.

Use MyGo v0.7.4, pinned in `go.mod`, with Go 1.27.3. Embed the original `web/` frontend directly; no bundler or JavaScript framework is required. `mygo.json` owns packaging metadata. The Go host owns native dialogs, filesystem writes and the authenticated local agent transport. `web/desktop.js` isolates these APIs from browser behavior; photo/edit rules stay in the web domain modules.

Exports choose a destination through the system dialog and stream 512 KiB chunks to a temporary sibling file, then replace the destination on completion. Transfer memory stays bounded without imposing a total file size limit. The host writes only to the explicitly selected export destination and does not automatically modify imported files. A failed or canceled transfer removes its temporary file.

The agent CLI reaches the current window's state through a loopback HTTP broker and long-polling MyGo bindings. It does not automate visible controls. A random bearer token and endpoint are placed in the current user's configuration directory; the server binds only to `127.0.0.1`. Closing the app removes its connection file.

Alternatives considered: a browser-only application cannot own portable desktop packaging or native save behavior; a Go native UI would require a separate image frontend; Electron adds another browser runtime. MyGo uses the operating system webview instead.

Consequences: Windows requires WebView2, macOS uses WKWebView, and Linux requires GTK 3 plus WebKitGTK 4.1. MyGo does not provide an Android/iOS application target. Compilation for another desktop OS does not demonstrate runtime behavior there. Distribution signing and notarization require the distributor's credentials and are not enabled by this decision.

The selected version was checked against the [official release](https://github.com/egoist/mygo/releases/tag/v0.7.4), its [Go module](https://github.com/egoist/mygo/blob/v0.7.4/go.mod), [configuration](https://github.com/egoist/mygo/blob/v0.7.4/docs/configuration.md), [frontend](https://github.com/egoist/mygo/blob/v0.7.4/docs/frontend.md) and [bindings documentation](https://github.com/egoist/mygo/blob/v0.7.4/docs/bindings.md). Context7 `/egoist/mygo` was used for discovery; its indexed version list lagged behind the official release, so source at the release tag controls the API pin.
