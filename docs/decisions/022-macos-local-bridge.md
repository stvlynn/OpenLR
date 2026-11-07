# Vendored MyGo bridge for the local macOS frontend

## Status

Proposed. The isolated native protocol fixture and 24 packaged application trials
passed. Acceptance of the vendored production build across all platforms is still
required.

## Context

The ordinary Apple Silicon video workflow can terminate in JavaScriptCore's
conservative-root buffer allocation. An identity-matched post-fault capture
identified the caller. A generated public-JSC comparison reproduced the same
failure in both Go-stack waits; four native-stack controls completed collection.
Both failing allocation values exactly match the page-rounded, doubled difference
between the observed pthread stack origin and Go SP. These fixture observations
do not identify the application's earlier suspended mutator sample.

WebKit deserializes script messages and supported evaluation results through a
shared UIProcess JSC context. Purego callbacks retain their pthread while entering
a Go stack. OpenLR needs its existing photo operations, GUI command dispatcher and
packaged agent CLI to continue working on all supported desktop targets.

## Proposed decision

Use a local URL-scheme transport in the vendored Darwin MyGo adapter. It admits
the existing secret-prefixed bridge messages into the same dispatcher, preserving
call IDs, page ownership, event delivery and channel backpressure. It adds no
trusted payload size ceiling.

Result-bearing evaluation keeps native compilation with nil arguments. A result
returns through the scheme, followed by an intentionally unsupported native
result. Only an admitted matching reply together with the public WKErrorDomain
code 5 completes the request. Native compilation errors retain MyGo's existing
expression-to-statement fallback; transport errors have a distinct prefix so they
cannot execute user code twice. Cancellation releases the adapter's ownership;
public WebKit APIs cannot stop already-running JavaScript.

Keep the selected Go modules in the standard root `vendor/` directory. Normal
`go build`, `go test`, the declared `go tool mygo` and desktop build/dev then use
one dependency graph. Maintain the local change as an attributed patch applied
when regenerating vendor, rather than preparing dependencies during every build.
Go's ordinary module/vendor consistency checks remain in effect.

## Consequences and scope

This is an OpenLR application dependency change. The application loads its own
`mygo://localhost` frontend; its current product flow does not expose general
remote-page hosting. The candidate does not establish general MyGo compatibility:
fetch adds CSP/connect-src constraints, scheme tasks lack native frame identity,
and BFCache restoration currently fails closed. Those limits must remain explicit
and must be evaluated against actual OpenLR interactions before acceptance.

The native window fixture passed 40 assertions, including Unicode payloads,
channels, syntax/runtime errors, exactly-once evaluation, cancellation, failed
navigation and a genuine old-page replay. It does not prove removal of every
possible JSC context creator or replace application/platform verification.

The diagnostic application at `c700b0d` completed 24/24 strict trials, with actual
image/audio/original checks and confirmed host/helper/oracle cleanup. No fault
capture or forced termination occurred. That package used an isolated signal
observation toolchain and disposable module replacement. An ordinary vendored
production build still needs its complete platform and native-dialog checks.

## Alternatives considered

| Delivery | Evidence and tradeoff |
| --- | --- |
| Standard vendor | Measured 621 files / 5,800,097 bytes, including MyGo CLI and required embeds. Offline dependency resolution passed all four desktop targets. Modified dependency source stays with the application. Regeneration must reapply the local patch. |
| Maintained fork and versioned replace | Go supports replacement for runtime and tool dependencies. This preserves ordinary commands with less source in this repository, but adds separate hosting and upstream maintenance for an application-specific adaptation. |
| Disposable build-only patch | Useful for the native comparison. Ordinary Go builds/tests outside that temporary configuration retain the unmodified dependency, so this does not provide consistent production delivery. |

## References

- [Captured caller and stack comparison](../../research/native-video.md#allocating-caller-captured-during-conservative-root-gathering)
- [40-assertion native fixture](https://github.com/stvlynn/OpenLR/actions/runs/42377530724)
- [24-trial candidate application](https://github.com/stvlynn/OpenLR/actions/runs/42378126957)
- [Pinned WebKit evaluation implementation](https://github.com/apple-oss-distributions/WebKit/blob/e97539821b38379d82a51b6740d90191d5d0b7af/Source/WebKit/UIProcess/API/Cocoa/WKWebView.mm#L1265)
- [Go vendoring](https://go.dev/ref/mod#vendoring) and [fork replacement](https://go.dev/doc/modules/managing-dependencies#external_fork)
