# Preference persistence

## Status

Accepted. Native application verification of the implementation is recorded in the owning research and acceptance records.

## Context

A normal default-store ARM macOS application restart lost an acknowledged preference change. A balanced native comparison later reproduced stale localStorage data in one of four ARM trials, while all four strict IndexedDB transactions retained their values. Intel macOS and Windows passed both candidates. This supports a persistence boundary change without claiming a traced WebKit root cause.

## Decision

Store workspace preferences in a `settings` store in the existing catalog database, upgraded from version 5 to 6. Read settings before workspace readiness. A missing settings record imports the recognized boolean fields from the legacy localStorage record and waits for a strict transaction before publishing them. Once present, the catalog record is authoritative; the legacy record remains untouched for migration recovery and is no longer written.

The shared `preferences` dispatcher waits for a strict transaction to complete before changing the in-memory object, drawing or acknowledging success. A failed write rejects through the existing GUI notice and CLI error path, retaining prior state. Catalog transaction error handling is reused. Other catalog transactions retain their existing durability policy.

## Consequences

Settings now share catalog availability and startup error handling. Migration and settings writes are asynchronous. The command's response and four boolean fields are unchanged. Strict durability requests confirmed persistent writes but is not a promise against all hardware or filesystem failures. No settling delays, write retries or new UI controls are introduced.

## Alternatives considered

- Keep localStorage: observed stale data after an acknowledged normal quit in the actual ARM comparison.
- Add a flush delay: a guessed wait does not provide a persistence acknowledgment and was not used.
- Native settings file: would add an OS adapter, separate browser persistence and additional migration paths. The existing catalog can provide the tested transaction boundary without duplicate backends.

## References

- [Comparison and exact evidence limits](../../research/preferences-persistence.md)
- [MDN transaction durability](https://github.com/mdn/content/blob/main/files/en-us/web/api/idbtransaction/durability/index.md)
