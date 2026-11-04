# OpenLR project guidance

OpenLR is a photo workflow project with a dependency-free ES module prototype under `web/` and a Go/MyGo desktop host. It is licensed under AGPL-3.0-only. Read the current architecture and product documentation before changing behavior. Research evidence and product requirements have different authority: an observed competitor feature is not automatically an OpenLR requirement.

## Start with the relevant evidence

- Read `README.md` for the supported commands and current scope.
- Read `docs/template-conventions.md` for boundaries, workflow, and verification rules.
- Read `docs/agent-cli.md` for command discovery, live GUI automation, and actual image/state results. CLI, UI controls, and browser automation must share the central command dispatcher.
- Read `docs/catalog-organization.md` before changing selection, batch actions, albums, filters, or saved edit versions.
- Read `docs/photo-merge.md` before changing HDR radiometry, feature registration, panorama blending, or merged-image storage.
- Read `docs/dng-export.md` before changing RAW-preserving export, linear DNG samples, TIFF/DNG tags, or color calibration.
- Read `docs/optics-geometry.md` before changing lens profiles, channel alignment, perspective, straightening, or coordinates shared with local tools.
- Read `docs/catalog-migration.md` before changing external catalog parsing, authorized original references, migration retry, or portable sync of referenced files. Preserve the distinction between synthetic schema tests and genuine catalog validation.
- Read `docs/template-sources.md` and `THIRD_PARTY_NOTICES.md` before introducing outside material.
- Read relevant records under `research/` when investigating prior art. Preserve the difference between source inspection, runtime observations, and hypotheses.
- Inspect affected code, tests, and error output before adding recovery behavior. Ask only when a product decision or consequential boundary remains unresolved after inspection; choose routine implementation details independently.

## Implementation expectations

- Use English for identifiers, code comments, and commit subjects. Documentation may use the user's requested language. Keep user-facing text in a shared message catalog or equivalent owner.
- Separate photo and edit rules from presentation, storage, codecs, and OS integration. Dependencies flow toward domain contracts; native and filesystem details belong in adapters.
- Preserve original image files. Derive previews and exports from explicit edit state, and report read, decode, and write failures visibly.
- Do not impose an arbitrary photo file size ceiling. Document codec support and resource constraints accurately; large payload handling must preserve the original bytes.
- Associate asynchronous work with the current asset and edit revision. A stale result must not replace the state of a newly selected image.
- Reuse an existing implementation of the same rule. Extract shared code when there is an actual shared responsibility, rather than merely similar syntax.
- Update behavior documentation and verification instructions in the same change as the implementation. Record significant architecture choices with their reasons and alternatives.
- Never claim a check passed when its command is a placeholder or it was not executed. State the tested environment and meaningful limitations.

## Source and working-copy hygiene

- Do not import template code, skills, assets, dependency locks, CI workflows, or license declarations without checking their provenance and terms.
- Do not treat Adobe or Lightroom branding, proprietary assets, catalogs, binaries, or strings as OpenLR source material. Use original UI and appropriately licensed test fixtures.
- Keep personal photographs, credentials, large generated data, and machine-specific paths out of tracked files. Use small licensed or generated fixtures for repeatable checks.
- Respect existing uncommitted work. Do not push, publish, or send messages on the user's behalf unless explicitly authorized.
- Use concise Conventional Commit subjects when a commit is requested, for example `feat(catalog): add image selection`.
