# Claude Code Regression Check — nanobot Orchestration MCP

**Date:** 2026-03-10
**Scope:** Post-fix pass — source read (`README`, `src/adapters/claude.ts`, `src/adapters/async-event-queue.ts`, `src/core/run-manager.ts`, `src/adapters/base.ts`) + full `npm test` run
**Prior baseline:** `docs/claude-code-dogfood-report.md` (identified R1–R11)

---

## Non-Blocking Design — Still Intact ✅

The fire-and-poll contract is unchanged:

1. `spawnRun` in `RunManager` returns `SpawnRunResult` before any agent I/O starts.
   `managed.task = this.runManaged(managed).catch(…)` is a detached, floating `Promise`; it is not awaited before the function returns.
2. `ClaudeCodeAdapter.spawn()` is synchronous — it instantiates a `ClaudeCodeRunHandle` with a null `runPromise` and no I/O.
   The SDK `query()` call is stored but not iterated until `handle.run()` is called inside the background task.
3. `ClaudeCodeRunHandle.doRun()` streams from the SDK inside `for await (…)` and pushes every translated event into `AsyncEventQueue.push()`. The queue is a zero-allocation coroutine bridge: `push()` either resolves a waiting consumer directly or appends to an in-memory list.
4. `poll_events` on the MCP side hits `EventBuffer.waitForAfter()` — an in-process long-poll — so no MCP call ever blocks on agent computation.

**Conclusion:** The orchestration design is still non-blocking end-to-end.

---

## What Was Verified Directly

### Source files read

| File | What was checked |
|---|---|
| `README.md` | `spawn_run` notes confirm `bypassPermissions` intent; storage layout section present |
| `src/adapters/claude.ts` | `buildClaudeOptions`, `ClaudeCodeRunHandle.doRun()`, `handleMessage` dispatch, all `emitXxx` helpers |
| `src/adapters/async-event-queue.ts` | push/end/iterator implementation; no memory leak on `end()` after drain |
| `src/adapters/base.ts` | Thin abstract base; no hidden blocking |
| `src/core/run-manager.ts` | `spawnRun`, `runManaged`, `consumeEvents`, `cancelRun`, `markRunFailed`, `persistEvent`, `applyEventToRecord` |
| `test/claude-adapter.test.mjs` | Two new tests (options shape + full message-mapping sequence) |
| `test/run-manager.test.mjs` | Two new tests (cancel `lastSeq`, fail `lastSeq`) |
| `test/event-buffer.test.mjs` | Long-poll mechanics |
| `test/server.test.mjs` | Tool registration |

### Test run

```
npm test  →  8 tests, 0 failures, 0 skipped
```

All tests passed. The two newly added scenarios (cancelled `lastSeq` sync and failed run `lastSeq` sync) correspond directly to bugs R4 and R5 from the prior report and now pass.

### Fixes confirmed by the new tests

**R4 fixed — `lastSeq` now stays consistent after cancel and fail.**
`cancelRun` and `markRunFailed` both route their terminal events through `persistEvent` → `applyEventToRecord`, which increments `managed.record.lastSeq` before writing `run.json`.
Tests `cancelRun persists lastSeq …` and `markRunFailed persists lastSeq …` each assert that `run.last_seq === 1` in memory and `runJson.lastSeq === 1` on disk after the first (and only) event is appended.

**R5 fixed — `run_started` no longer carries a bogus `backend_session_id` for new sessions.**
`ClaudeCodeRunHandle.doRun()` now populates `runStartedData` only when `this.params.session.backendSessionId` is truthy, leaving `data: {}` for new sessions.
The adapter message-mapping test asserts `events[0].data` deep-equals `{}`, confirming no spurious field.

---

## Remaining Risks

The following risks from the prior report are **not addressed** by this round of fixes. They remain valid.

| ID | Severity | Description |
|---|---|---|
| R1 / R2 / R3 | High | All run state lives only in the current process. A server restart empties `RunManager.runs`; `list_runs` returns nothing, `get_run` and `poll_events` throw, and `events.jsonl` history is unreachable even though it is on disk. |
| R6 | Medium | No unit test for the Codex adapter's event-mapping logic. The adapter handles a wider switch tree than the Claude adapter but is covered only by integration with the real SDK. |
| R7 | Medium | Concurrent `cancelRun` + `runManaged` completion can race on `writeRunRecord`. The status guard prevents double-completion, but both paths can issue the final write at the same time. Low probability, but no locking in place. |
| R8 | Low | `src/index.ts` registers no `SIGTERM` / `SIGINT` handlers; in-flight SDK connections are hard-killed on supervisor shutdown. |
| R9 | Low | `parseStructuredOutput` speculatively parses any final agent text as JSON in the fallback completion path. A valid-JSON response is silently promoted to `structuredOutput`. |
| R11 | Low | `poll_events` defaults to `wait_ms = 20 000`. If the MCP client's tool-call timeout is shorter, the client drops the response mid-wait and re-polls from the same `after_seq`, potentially missing events from the dropped batch. |

R10 (`bypassPermissions` hardcoded) is a deliberate design choice and documented in the README; it is not repeated here as a risk.

---

## Summary

The two targeted fixes (R4 `lastSeq` consistency and R5 spurious `backend_session_id`) are in place and directly proven by the new tests. The non-blocking spawn-and-poll architecture is intact. The test count grew from 6 to 8; all pass. The highest-priority unresolved gap remains the lack of crash-restart recovery (R1–R3), which limits operational reliability but does not affect the orchestration design correctness for a continuously-running server.
