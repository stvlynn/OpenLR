# Template conventions applied to OpenLR

The references and fixed revisions behind these conventions are recorded in [template sources](template-sources.md). OpenLR uses a dependency-free ES module prototype under `web/` and a Go/MyGo desktop host. These are complementary implementations; the browser prototype alone does not prove native functionality. The reused [ADR template](decisions/adr-template.md) retains upstream attribution under AGPL-3.0-only.

## Documentation and task flow

`AGENTS.md` is the project entry point. Product documentation defines intended OpenLR behavior; research records report observations and their limits. Implementation details belong next to their owning modules or in architecture documentation. A research comparison cannot silently override a product decision.

Before implementation, read only the relevant product and architecture material, inspect the affected code, and define the observable result. If the task changes a command, setting, default, or module boundary, search its previous name with `rg` and update the owning documentation and references together. Keep facts with one owning document and link to them elsewhere.

For a significant architecture choice, add an architecture decision record under `docs/decisions/` using the [ADR template](decisions/adr-template.md). Record context, decision, consequences, and alternatives. Use the next unused numeric prefix. Experimental proposals must be labeled as proposals; successful compilation does not promote them to validated product behavior.

## UI boundaries

Apply the template's downward dependency principle where the implementation benefits from it:

| Responsibility | Owns | Must delegate |
| --- | --- | --- |
| App composition | Startup, global providers, runtime wiring | Edit rules, codec implementation |
| Workspace or page | Arrangement of library, image view, and controls | Shared image processing |
| Feature | Complete action such as import, adjustment, or export | Generic storage and native APIs |
| Entity | Asset identity, metadata types, edit-state rules | UI rendering and OS access |
| Shared primitive | General controls, math, formatting | Product workflows |

Higher layers may depend on lower layers. A reusable primitive cannot import a product feature. Cross-feature interaction uses a public contract or app composition; do not reach into another feature's internal state. Keep small prototypes simple: these responsibilities do not require an empty directory for every conceptual layer.

## Processing and native boundaries

Domain logic describes an image, an edit recipe, and supported operations independently of a specific UI framework, image codec, database, or filesystem API. Use-case code coordinates loading, applying edits, and export through explicit contracts. Adapters implement concrete persistence, decode/encode, OS access, and acceleration. App startup wires them together.

An edit changes recipe state; preview and export consume that recipe. The original source remains intact. Errors include enough context for recovery without exposing personal file paths in shared logs. Each asynchronous operation captures asset identity and a revision; changing selection, changing edits, or cancelling invalidates incompatible results.

MyGo is the chosen desktop host. GPU strategy, catalog persistence, RAW processing, and color management still require OpenLR-specific decisions. Arion's speech, input-method, encryption, and model-provisioning infrastructure do not establish those choices for a photo application. See [import rules](import-rules.md) for the concrete module mapping.

## Verification and handoff

Commands in the root manifest must perform real checks. A command that only prints a future instruction is not a quality gate. Use the lockfile and tool versions selected by OpenLR rather than copying a reference repository's pins.

Select checks according to the change: formatting or link checks for documentation; type, build, and behavior checks for code; visual inspection for layout; real decoding and exported-image inspection for processing. Native-only behavior needs the actual target OS. Browser rendering, mocked adapters, and static source inspection must be identified as such.

A handoff states the resulting behavior, commands actually executed, and remaining limitations. Preserve a broken check's error evidence and investigate the cause. If degraded behavior is intentional, document its trigger and visible outcome and verify it; silent fallback is not evidence of success.

Browser state waits must check the resolved condition, not the truthiness of a Promise. Follow [browser verification](browser-verification.md) for asynchronous dispatcher state, handler completion, and independent persisted/output assertions.
