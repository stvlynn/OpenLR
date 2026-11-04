# Template source review

Reviewed on 2026-11-05. The fixed commits below identify what was inspected; upstream `main` can change. OpenLR reuses two Arion documentation templates as recorded below and restates selected engineering ideas in its project guidance. This review imports no skills, product assets, or dependencies from these repositories.

## stvlynn/agentic-coding

Repository: [stvlynn/agentic-coding](https://github.com/stvlynn/agentic-coding). Inspected commit: [`b15612fc04242759cc591545677af26dc2b5af32`](https://github.com/stvlynn/agentic-coding/tree/b15612fc04242759cc591545677af26dc2b5af32).

| Inspected evidence | What OpenLR takes from it |
| --- | --- |
| [AGENTS.md](https://github.com/stvlynn/agentic-coding/blob/b15612fc04242759cc591545677af26dc2b5af32/AGENTS.md) | A project entry point, relevant documentation before implementation, visible failure handling, documentation maintained with code |
| [Architecture](https://github.com/stvlynn/agentic-coding/blob/b15612fc04242759cc591545677af26dc2b5af32/docs/project/architecture.md) | UI responsibility boundaries and inward-facing domain contracts, mapped to photo workflows |
| [package.json](https://github.com/stvlynn/agentic-coding/blob/b15612fc04242759cc591545677af26dc2b5af32/package.json) | A caution: its check, test, lint, format, and docs scripts print placeholders; they are not inherited validation |

The repository describes itself as a language- and framework-agnostic template. Its [GitHub repository metadata](https://api.github.com/repos/stvlynn/agentic-coding) reported `license: null`; the recursive tree at the inspected commit contained no LICENSE, COPYING, or NOTICE file. This is an observation of that revision, not proof about every contributor or future revision. Do not label this template MIT or assume its template designation grants a general reuse license. [GitHub's licensing documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository) explains the distinction between public availability and an open-source license.

## AstraFoundry/Arion

Repository: [AstraFoundry/Arion](https://github.com/AstraFoundry/Arion). Inspected commit: [`3b1acc15ce251014ba720ee333c3cd74a75ea49b`](https://github.com/AstraFoundry/Arion/tree/3b1acc15ce251014ba720ee333c3cd74a75ea49b).

| Inspected evidence | What OpenLR takes from it |
| --- | --- |
| [AGENTS.md](https://github.com/AstraFoundry/Arion/blob/3b1acc15ce251014ba720ee333c3cd74a75ea49b/AGENTS.md) | Route a task to relevant docs, choose local details independently, preserve verification limits, keep volatile facts with one owner |
| [Architecture](https://github.com/AstraFoundry/Arion/blob/3b1acc15ce251014ba720ee333c3cd74a75ea49b/docs/project/architecture.md) | Explicit native adapters and revision-scoped asynchronous work, applied independently to image selection and edits |
| [package.json](https://github.com/AstraFoundry/Arion/blob/3b1acc15ce251014ba720ee333c3cd74a75ea49b/package.json) | Real repository checks, separate tooling and native checks, pinned package management |
| [Desktop go.mod](https://github.com/AstraFoundry/Arion/blob/3b1acc15ce251014ba720ee333c3cd74a75ea49b/apps/desktop/go.mod) | Evidence that the desktop implementation uses Go/MyGo and local modules; this does not make it a drop-in image editor |

[GitHub metadata](https://api.github.com/repos/AstraFoundry/Arion) identifies `stvlynn/agentic-coding` as Arion's template repository. Arion is an example of how the generic conventions evolved into a local-first native application, rather than a generic image-processing library.

The [LICENSE](https://github.com/AstraFoundry/Arion/blob/3b1acc15ce251014ba720ee333c3cd74a75ea49b/LICENSE) contains GNU AGPL version 3. The inspected [license decision](https://github.com/AstraFoundry/Arion/blob/3b1acc15ce251014ba720ee333c3cd74a75ea49b/docs/decisions/009-agpl-license.md) and package manifest specify **AGPL-3.0-only**. The standard license's example notice mentioning later versions does not override that explicit project declaration. Third-party files inside Arion carry their own notices and require their own review.

## Reuse record

OpenLR adopts the responsibilities and workflow described in [template conventions](template-conventions.md). It selects Go/MyGo for its desktop host and dependency-free JavaScript ES modules for its browser prototype. It is licensed AGPL-3.0-only, with full text in [LICENSE](../LICENSE) and the declaration in [licensing](licensing.md).

| Local file | Arion source at the fixed revision above | Treatment |
| --- | --- | --- |
| `LICENSE` | `LICENSE` | Full license text retained unchanged |
| `docs/decisions/adr-template.md` | `docs/decisions/adr-template.md` | Template retained; provenance comment added |
| `docs/import-rules.md` | `docs/frontend/import-rules.md` | Adapted to OpenLR's ES module and Go package boundaries; changes stated in the file |

Arion branding, UI assets, voice-input behavior, private evaluation arrangement, dependency pins, and CI workflows are not imported. The unlicensed `agentic-coding` repository is an acknowledged research reference, rather than a vendored source dependency.

Any future copied or adapted file needs an exact upstream path and commit, its applicable license and notices, a description of changes, and a record in [third-party notices](../THIRD_PARTY_NOTICES.md). For material without a clear applicable reuse grant, obtain permission or implement independently. Resolve applicable compatibility and source-distribution requirements before merging additional imports. This review records evidence and project policy; it does not replace a license compatibility review of a concrete import.
