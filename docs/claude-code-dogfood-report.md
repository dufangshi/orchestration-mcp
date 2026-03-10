# Claude Code Dogfood Report — nanobot Orchestration MCP

**Prepared by:** Claude Code (dogfood session, `orchestration-mcp` repo)
**Date:** 2026-03-10
**Scope:** Full source read + `npm test` pass; no production traffic observed

### Executive Summary

The server is well-structured for its purpose: it implements a clean fire-and-poll pattern that keeps every MCP tool call fast and non-blocking. The two adapters (Codex and Claude Code) share a common `AdapterRunHandle` interface, and the event normalization layer is thorough. All six tests pass. The main gaps are (1) no cross-restart visibility into runs (all state is in-memory only), (2) a `lastSeq` counter that goes out of sync when a run is cancelled or forcibly failed, and (3) no unit test for the Codex adapter's event-mapping logic. These are fixable incrementally; none block the current usage model.

---

## 1. MCP Tool Contract

The server registers exactly five tools, verified by reading `src/server.ts`, each individual tool module under `src/tools/`, and by the passing test `server registers all orchestration tools`.

| Tool | Input key fields | Returns | Side-effects |
|---|---|---|---|
| `spawn_run` | `backend`, `role`, `prompt`, `cwd`, `session_mode`, `session_id?`, `profile?`, `output_schema?`, `metadata?` | `run_id`, `backend`, `role`, `session_id`, `status` | Creates run record, session record on disk; starts background task |
| `get_run` | `run_id` | Run summary: `status`, `last_seq`, `summary`, `started_at`, `updated_at`, `cwd`, `metadata` | None (read-only) |
| `poll_events` | `run_id`, `after_seq`, `limit` (default 100, max 1000), `wait_ms` (default 20 000, max 30 000) | `run_id`, `status`, `events[]`, `next_after_seq` | None — long-polls in-process `EventBuffer` |
| `cancel_run` | `run_id` | `run_id`, `status`, `cancelled_at` | Calls adapter `abort()`; writes status to disk |
| `list_runs` | `status?`, `backend?`, `cwd?` | `runs[]` (same shape as `get_run`) | None |

All tool inputs and outputs are validated with `zod/v4` schemas (`src/core/schemas.ts`). The schemas are reused as both MCP `inputSchema` / `outputSchema` and as the authoritative type source. Helper `asToolResult` / `asToolError` normalise the MCP response envelope.

**Verified directly:** All five tools in `src/tools/`, all schemas in `src/core/schemas.ts`.

---

## 2. Backend Support

Two backends are registered at server startup in `src/server.ts`:

### `codex` — `@openai/codex-sdk`

- Uses `Codex.startThread` (new) or `Codex.resumeThread` (resume) with `sandboxMode: 'workspace-write'`, `approvalPolicy: 'never'`, and `networkAccessEnabled: true`.
- Streaming is done via `thread.runStreamed(prompt, { outputSchema, signal })`.
- `AbortController` signal is used for cancellation.
- Normalises `ThreadEvent` types: `thread.started`, `turn.started/completed/failed`, `error`, `item.started/updated/completed` (for agent messages, reasoning, commands, file changes, MCP tool calls, web searches, todo lists).
- Thread ID (`thread_id`) flows out of `thread.started` event in a `status_changed` event; `RunManager.applyEventToRecord` picks it up to persist the backend session ID for future resumes.

**Verified directly:** `src/adapters/codex.ts`

### `claude_code` — `@anthropic-ai/claude-agent-sdk`

- Uses `query({ prompt, options })` where options include `cwd`, `tools: { type: 'preset', preset: 'claude_code' }`, `permissionMode: 'bypassPermissions'`, `allowDangerouslySkipPermissions: true`.
- For new sessions: `options.sessionId` is set to the MCP-layer session UUID. For resuming: `options.resume` is set to the persisted `backendSessionId`.
- Normalises `SDKMessage` types: `system/init` and all `system/*` subtypes, `assistant`, `result`, `tool_progress`, `tool_use_summary`, `auth_status`, `rate_limit_event`, `prompt_suggestion` (silently dropped).
- The backend session ID arrives in the `system/init` message (`message.session_id`) and is captured into the `status_changed` event's `data.backend_session_id`.
- Cancellation calls `sdkQuery.close()`.

**Verified directly:** `src/adapters/claude.ts`

---

## 3. Non-Blocking Orchestration Design

### How spawn_run stays non-blocking

`spawnRun` in `RunManager`:
1. Creates the session and run record (both written to disk immediately).
2. Calls `adapter.spawn(params)` — which is **synchronous** for both adapters: it instantiates a handle with a lazy `runPromise = null` but does not start any I/O.
3. Fires `this.runManaged(managed)` as a detached floating `Promise` (`managed.task = this.runManaged(...)`) and stores the handle in `this.runs`.
4. Returns the `SpawnRunResult` immediately (before any agent I/O has happened).

### Background task structure (`runManaged`)

Inside `runManaged`, two concurrent branches run with `Promise.allSettled`:

- **`consumeEvents(managed)`** — iterates `handle.eventStream` (an `AsyncEventQueue`), assigns monotonically increasing `seq` numbers, writes each event to `events.jsonl`, and wakes up any pending `waitForAfter` callers in the `EventBuffer`.
- **`handle.run()`** — drives the actual SDK streaming loop, translating raw SDK messages into normalized events that get pushed into the `AsyncEventQueue`.

The `AsyncEventQueue` (`src/adapters/async-event-queue.ts`) is a single-producer / single-consumer coroutine bridge: `push()` feeds from the `run()` side; `Symbol.asyncIterator` consumes on the `consumeEvents` side.

### Long-polling with EventBuffer

`EventBuffer` (`src/core/event-buffer.ts`) is a per-run in-memory append-only list of normalized events. It supports:
- **Immediate return** — if events with `seq > afterSeq` are already buffered.
- **Long-wait** — registers a `Waiter` with a `setTimeout`; any subsequent `append()` call resolves matching waiters early.

`poll_events` delegates directly to `buffer.waitForAfter(afterSeq, limit, waitMs)`.
**MCP server timeout** for `poll_events` is bounded at 30 000 ms by the Zod schema; the default is 20 000 ms. Callers are expected to loop until they see a terminal status.

### Cancellation

`cancelRun` synchronously updates the in-memory record fields (status, summary, timestamps) and calls `adapter.cancel(handle)`. Both adapters implement `abort()` — codex via `AbortController.abort()`, Claude via `sdkQuery.close()`. The `runManaged` loop has a guard: if status is already `cancelled` when it completes, it skips the normal `completed` path. A `status_changed/cancelled` event is appended to the buffer and to disk before `cancelRun` returns.

**Verified directly:** `src/core/run-manager.ts`, `src/core/event-buffer.ts`, `src/adapters/async-event-queue.ts`

---

## 4. Risks and Gaps

The following items were identified by code inspection. Items marked **[observed]** were confirmed by reading live code; items marked **[inferred]** are logical conclusions from code structure.

### High severity

**R1 — All run state lives only in the current process [observed]**
`RunManager.runs` is a plain `Map<string, ManagedRun>` that is never populated from disk on startup. After a server restart: `list_runs` returns an empty set, `get_run` and `poll_events` both throw "Unknown run_id", and every in-flight run is silently abandoned. The on-disk artifacts (run.json, events.jsonl) survive but are unreachable via MCP. This affects `list_runs` (R2) and `poll_events` history (R3) as separate consequences.

**R2 — `listRuns` sees only this process's runs [observed]**
A direct consequence of R1: `listRuns` queries only `this.runs`, not the filesystem. Runs from previous server invocations or sibling processes sharing the same `cwd` are invisible. Any operator tooling that restarts the server and then calls `list_runs` to audit previous work will always receive an empty result.

**R3 — `poll_events` cannot replay history after a reconnect [observed]**
`EventBuffer` is populated only by live `append()` calls; the `events.jsonl` file is never read back. If a caller loses its connection, restarts the MCP client (but the server stays up), and calls `poll_events` with `after_seq=0`, it receives only the events still in the in-process buffer — it cannot recover the full history even though all events are on disk.

### Medium severity

**R4 — `lastSeq` not updated after `cancelRun` or `markRunFailed` [observed]**
`cancelRun` and `markRunFailed` both call `prepareEvent` (which uses `managed.record.lastSeq + 1` to assign the event seq), then call `writeRunRecord`. However, neither calls `applyEventToRecord`, so `managed.record.lastSeq` is never incremented. As a result, the `run.json` on disk records a `lastSeq` value that is one behind the last event actually written to `events.jsonl`. This creates a silent inconsistency between the two artifact files.

**R5 — `run_started` event for `claude_code` has incorrect `backend_session_id` for new sessions [observed]**
In `ClaudeCodeRunHandle.doRun()`, the `run_started` event sets `data.backend_session_id` to `this.params.session.backendSessionId ?? this.params.session.sessionId`. For a freshly created session, `backendSessionId` is `null`, so it falls back to the MCP-layer UUID. The real backend session ID only arrives later in the `system/init` message. Callers that read `run_started` expecting the Claude session ID will get a misleading value.

**R6 — No `Codex` adapter unit test [observed]**
`test/claude-adapter.test.mjs` provides a comprehensive message-to-event mapping test for the Claude adapter. No equivalent test exists for `CodexAdapter`. The Codex adapter handles a wider variety of `ThreadEvent` types and maps them through a more complex switch tree, but correctness relies entirely on integration with the actual SDK.

**R7 — Concurrent cancel + `runManaged` write race [inferred]**
`cancelRun` directly mutates `managed.record` fields and calls `writeRunRecord`. Concurrently, `runManaged`'s `Promise.allSettled` may resolve and also call `writeRunRecord`. The guard `if (managed.record.status === 'cancelled') return` prevents a double-completion, but both write paths can race on the last `writeRunRecord` call. In most cases this is harmless (last write wins for idempotent JSON), but under high concurrency or slow I/O it could produce a torn write.

### Low severity

**R8 — No process-signal handling [observed]**
`src/index.ts` does not register `SIGTERM` or `SIGINT` handlers. A supervisor kill sends the process to a hard exit, abandoning in-flight adapter connections and possibly leaving `events.jsonl` mid-write.

**R9 — `parseStructuredOutput` speculatively parses all final text as JSON [observed]**
Both adapters call `parseStructuredOutput(this.latestAgentMessage)` in their fallback completion path (when the SDK does not return an explicit result). If the agent emits a final text response that happens to be valid JSON, it is silently promoted to `structuredOutput`. This only affects the fallback path (the explicit `result` message takes precedence for Claude; Codex uses the same fallback), but could confuse callers.

**R10 — `permissionMode: 'bypassPermissions'` and `allowDangerouslySkipPermissions: true` are hardcoded [observed]**
These settings are required for non-blocking orchestration — the agent must never stop to prompt for permission mid-run. The trade-off is that spawned Claude Code agents have unrestricted filesystem and shell access within the given `cwd`. This is a deliberate design choice, not an oversight, but it should be prominently documented so operators understand the trust model before deployment.

**R11 — `wait_ms` default of 20 000 ms may exceed MCP client tool-call timeouts [inferred]**
If the host MCP client has a shorter tool-call timeout than the requested `wait_ms`, the client drops the response while the server is still waiting. The client then re-calls `poll_events` with the same `after_seq`, misses the batch that arrived during the dropped call, and may see events out of order or with gaps. Operators should verify the client-side timeout is comfortably above the chosen `wait_ms` value (the default is 20 000 ms; the schema allows up to 30 000 ms).

---

## 5. Recommended Next-Step Checklist

- [ ] **Fix `lastSeq` after cancel / fail** — Call `applyEventToRecord` (or manually increment `managed.record.lastSeq`) inside `cancelRun` and `markRunFailed` before writing `run.json`.
- [ ] **Fix `run_started` backend_session_id for new Claude sessions** — Either omit the field when it is unknown, or emit the real backend session ID after the `system/init` message arrives.
- [ ] **Add crash-restart recovery** — On `RunManager` construction (or on first `spawnRun` for a given `cwd`), scan `.nanobot-orchestrator/runs/` and re-hydrate completed/failed `RunRecord`s from `run.json` so `get_run` and `list_runs` work across restarts. Runs that were `queued` or `running` at shutdown should be re-marked `failed` with a descriptive error message.
- [ ] **Replay events.jsonl into EventBuffer on re-hydration** — When loading a run record from disk, parse its `events.jsonl` into the `EventBuffer` so `poll_events` can serve the complete history, not just events since the last server start.
- [ ] **Add a Codex adapter message-mapping test** — Mirror the `ClaudeCodeAdapter` test in `test/codex-adapter.test.mjs` to cover `thread.started`, `turn.*`, `item.*` (all item types), and the `error` / `turn.failed` paths.
- [ ] **Add a full run-lifecycle integration test** — Use a fake adapter (similar to the fake query factory in the Claude test) to exercise the full `RunManager` path: spawn → events flow → complete, including the `poll_events` long-poll wake-up and the `cancel_run` abort path.
- [ ] **Add SIGTERM / SIGINT handling** — In `src/index.ts`, register signal handlers that call `server.close()` and allow active SDK queries to drain or abort cleanly.
- [ ] **Document the permission model** — Add a security note to the README explaining that `permissionMode: 'bypassPermissions'` is required for non-blocking operation and what that means for operators deploying this server.
- [ ] **Consider a configurable `wait_ms` ceiling** — Or document the interaction with MCP client timeouts so operators can tune both sides to avoid lost `poll_events` responses.

---

## Appendix: Storage Layout

All artifacts are written under `<cwd>/.nanobot-orchestrator/`:

```
<cwd>/.nanobot-orchestrator/
  runs/
    <runId>/
      run.json       — RunRecord snapshot (overwritten on each state change)
      events.jsonl   — Append-only newline-delimited NormalizedEvent stream
      result.json    — RunResult (written on terminal state)
  sessions/
    <sessionId>.json — SessionRecord (backend session ID updated on first event)
```

The `cwd` value is validated to be an absolute path pointing to an existing directory before any storage writes occur.

---

*All sections above are based on direct source code reading of `src/**/*.ts`, `test/**/*.mjs`, `package.json`, `tsconfig.json`, and `README.md`, plus a live `npm test` run that produced 6 passing tests and 0 failures.*
