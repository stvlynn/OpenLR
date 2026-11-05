# Waiting for browser state

Browser acceptance uses the real shared dispatcher, catalog, codecs and exported bytes. A wait must establish its condition before the next assertion or action; merely awaiting the first state request is insufficient.

Use Playwright's synchronous `waitForFunction` for directly observable DOM, image dimensions, canvas pixels or a completed-handler marker. For asynchronous browser predicates, use `waitForAsyncFunction` from `tests/browser-wait.mjs`. It awaits each evaluation, checks the resolved value, and repeats only false observations until its deadline. Evaluation errors fail immediately. It returns the matching serialized value, not a JSHandle. Polling observes state; it must not repeat a state-changing command.

The helper does not establish that every part of a UI handler has completed. A save may finish its catalog command before output, preference acknowledgment or error presentation. In those cases, wait for a visible terminal state or the actual handler's completion, as the export boundary test does. Preserve separate checks for rendered pixels, exported files, original bytes and reopened records.

## Evidence and comparison

The installed Playwright 1.56.1 polling implementation checks the truthiness of `predicate()` before resolving its value. An async predicate returns a truthy Promise, so a first resolved `false` can end the wait. This was observed in the previous-export CI failure and reproduced with a deliberately held GUI handler. It is a test synchronization defect, not evidence that each affected production operation failed.

Context7's `/microsoft/playwright` documentation confirms that [`page.evaluate`](https://github.com/microsoft/playwright/blob/main/docs/src/api/class-page.md) awaits a returned Promise. The implementation evidence is the [pinned polling source](https://github.com/microsoft/playwright/blob/v1.56.1/packages/playwright-core/src/server/frames.ts). The shared helper uses that existing evaluation API rather than adding a second test framework, changing the application dispatcher or increasing arbitrary sleeps.

The helper's real-browser tests compare the old false-return behavior with a deferred false-to-true condition, and check deadline/error handling. Existing workflow tests retain their actual output assertions. Keyboard history now independently asserts the undo and redo values, and the range-mask workflow verifies the same component's changed value after reload. A matching mask type alone would not establish persistence of its edited parameter.

```sh
node --test tests/browser-wait.test.js tests/history-workflow.test.js tests/range-masks.test.js
OPENLR_TEST_CMS=1 npm test
```

The environment-variable command above is POSIX syntax; in PowerShell use `$env:OPENLR_TEST_CMS='1'; npm test`. Independent CMS/model checks require their documented local tools and fixtures; report skips explicitly. Platform native acceptance remains a separate check from browser polling tests.
