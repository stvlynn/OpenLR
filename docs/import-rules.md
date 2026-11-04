# Import rules

Adapted from [AstraFoundry/Arion, docs/frontend/import-rules.md](https://github.com/AstraFoundry/Arion/blob/3b1acc15ce251014ba720ee333c3cd74a75ea49b/docs/frontend/import-rules.md), licensed AGPL-3.0-only. Changes: removed TypeScript aliases, Arion ownership links, and commerce examples; mapped the dependency rules to OpenLR's ES modules and Go/MyGo host, and scaled slice rules to the current prototype. See [third-party notices](../THIRD_PARTY_NOTICES.md).

## Dependency direction

As OpenLR grows, UI responsibilities follow this order:

```text
app composition → workspace/page → widgets → features → entities → shared
```

- General primitives do not import product workflows.
- Entity and edit-state rules do not depend on a feature, page, or app startup.
- Features may compose lower-level responsibilities. Pages and widgets compose features.
- A feature must not reach into another feature's internal state. Coordinate them from app composition or expose a small explicit contract.

## OpenLR mapping

The `web/` prototype uses native JavaScript ES modules and relative imports. Keep image/edit math, state, and UI coordination separate where those responsibilities exist. Do not introduce a bundler, path alias, framework, or six empty layer directories solely to imitate the reference template. Existing public module exports are the import boundary.

The desktop host uses Go package exports as its public API. MyGo view construction and callbacks belong at the UI boundary. Storage, native file dialogs, image decoding/encoding, and OS integration implement explicit adapter contracts; they cannot become hidden dependencies of pure edit calculations. Startup owns adapter selection and wiring.

## Changes to boundaries

When a new cross-module dependency is necessary, first identify the responsibility it serves. Move coordination to the owning upper layer or define a narrow interface. Record a significant boundary change in an ADR and update the architecture documentation with the reason. Routine implementation choices within established boundaries do not require a separate approval.
