# Native startup timeout evidence

The Windows job of [`3163f36`, Actions 42103142177](https://github.com/stvlynn/OpenLR/actions/runs/42103142177) built successfully and passed browser verification (338/346, eight optional-resource skips). The first native `state --summary true --timeout 30` failed at that revision's `scripts/native-smoke.mjs:429`. It had not imported a photo or exercised the new white-balance commands. Linux and macOS Intel completed their native suites. The Windows log contains no command receipt, renderer navigation or catalog readiness observation; it does not establish a product root cause.

Source inspection distinguishes four boundaries. `main.go` calls `startAgent` after MyGo readiness and the instance lock, before opening the window. `agent.go` publishes its session after binding the loopback listener. A valid session therefore does not establish that the WebView loaded. `web/agent.js` polls commands through MyGo IPC; ordinary `app.run` waits for catalog/preset reads and initial drawing. `export-status` instead uses the separate control poll and bypasses that readiness promise. Neither the existing startup error listener nor the failure log proves which of these later stages stalled.

The native smoke now gathers evidence only after its existing startup assertion fails and before host cleanup. It retains the original error and deadlines. It records elapsed launch/session/request times and child PID/exit state, validates the descriptor using the existing CLI `connect`, and confirms that its PID belongs to the spawned child before sending probes. It then concurrently sends one authenticated `/health` request and one read-only `export-status` command. Each network probe has a two-second deadline. It does not retry `state`, change application startup or make a failed test pass. Asynchronous spawn errors also enter this path; cleanup failures are reported separately without replacing the initial error.

| Observation | What it establishes |
| --- | --- |
| Health and control both respond | Broker and renderer control round trip work at diagnostic time; investigate ordinary delivery/readiness next. |
| Health responds, control does not | Broker is reachable; renderer loading, IPC or control dispatch still needs evidence. |
| Health does not respond | Broker/process/loopback remains unresolved; do not infer a catalog or image-processing error. |

These are observations taken after the original deadline. A later working probe cannot prove the same path worked during the failed request. Diagnostics log only allowlisted status, timing and process fields: no descriptor/token, endpoint, workspace result, photo name, profile or environment dump. If these probes remain insufficient, the next justified step is timestamped renderer/navigation and poll/delivery milestones under the existing diagnostics switch, rather than a speculative timeout increase.

`node --test tests/native-startup-diagnostics.test.js` passed 4/4 on Windows / Node 24.9.0. It uses a real local HTTP server with controlled responses, not a native GUI: checks include authenticated health/control requests, no ordinary-state replay, returned-data omission, an unresponsive control path, invalid-session refusal and a mismatched process ID. An actual missing-executable launch also printed the sanitized diagnostic and retained the original `ENOENT` with exit 1. This validates the diagnostic mechanism, not the unresolved startup failure.

The subsequent panel revision `0c030e5` completed [Actions 42105066362](https://github.com/stvlynn/OpenLR/actions/runs/42105066362) successfully on all three platforms at its first attempt, before these diagnostics were added. It is a new successful execution, not evidence that the earlier timeout's root cause was repaired.
