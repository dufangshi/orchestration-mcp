# CLI Compatibility Proposal

Research date: 2026-03-18

## Executive Summary

This repository is already closer to CLI compatibility than it may look at first glance. The project is not "MCP-only" at the core. The real center of gravity is `RunManager`, the adapter interface, the normalized event model, and the file-backed storage under `.nanobot-orchestrator/`. MCP is currently a thin transport layer on top of that core.

That is the good news.

The main missing pieces are:

1. A first-class user-facing CLI surface for run lifecycle operations, not just the existing agent-to-agent `peer` helper.
2. A local supervisor/daemon mode for detached/background runs, because `continueRun()` and `cancelRun()` currently require a live in-process adapter handle.
3. A streaming-friendly CLI output model and a small local client/server abstraction so CLI and MCP can share the same orchestration core without duplicating behavior.

The recommended approach is:

1. Keep `RunManager`, `Storage`, event schemas, and adapters as the canonical orchestration core.
2. Add a transport-neutral local service boundary on top of `RunManager`.
3. Add a new `orchestrator` CLI with:
   - attached foreground execution,
   - detached/background execution,
   - run inspection/tailing,
   - continue/cancel/status,
   - session/agent messaging commands,
   - text, JSON, and streamed JSON output.
4. Add an optional local supervisor process for detached work.
5. Keep MCP as a supported transport, but stop treating MCP as the only primary way to invoke the system.

This gets the project to a practical CLI mode without rewriting the architecture around a new protocol.

## Assumptions

- The goal is to support CLI usage on the same machine where the orchestration code runs.
- "CLI mode" means direct terminal use by humans and shell scripts without requiring an external MCP client.
- The current storage format under `.nanobot-orchestrator/` should remain compatible unless there is a strong reason to version it.
- The current backend set remains:
  - `codex`
  - `claude_code`
  - `remote_a2a`
- The existing `peer` CLI should be preserved for compatibility, but folded into a broader CLI story.
- Node 20 remains the baseline runtime.

## What Users Mean By "CLI Mode"

In current AI tooling, "CLI mode" usually means all of the following, not just "there is a binary":

1. Interactive terminal use.
   Users expect to open a REPL-like session in the current repository and talk to the agent directly.

2. Non-interactive one-shot execution.
   Users expect commands like `tool -p "explain this repo"` or `cat diff.txt | tool -p "summarize"` that work well in scripts.

3. Streaming progress.
   Users expect to see partial output, intermediate actions, command execution, file edits, and final status in real time.

4. Structured automation output.
   Users expect JSON or newline-delimited JSON for CI jobs, shell scripts, or wrapper tools.

5. Session continuity.
   Users expect to resume a conversation, continue the last session, or bind a stable identity to a long-running agent.

6. Shell composability.
   Users expect stdin/stdout, exit codes, piping, file arguments, and predictable behavior in non-TTY environments.

7. Background execution.
   Users expect to kick off a long task, detach, inspect status later, tail logs, continue an interrupted prompt flow, and cancel if needed.

8. Low-friction configuration.
   Users expect environment variables, a config file, and a small set of default behaviors that work in the current directory.

9. Clear failure semantics.
   Users expect validation errors, auth errors, backend failures, and interrupted runs to be distinguishable both visually and via exit codes.

10. Project grounding.
   Users expect the CLI to operate in the current repo/worktree and persist enough state to remain useful across invocations.

For this project specifically, "CLI mode" should mean:

- I can run the orchestrator directly from a terminal.
- I do not need MCP to launch or inspect work.
- I can use the same orchestration engine for foreground work, detached work, and script automation.
- I can still use MCP if I want another agent to drive the orchestrator.

## External Research: Existing CLI Patterns

### Summary Table

| Tool / pattern | What users see | Relevant lessons for this project |
| --- | --- | --- |
| Claude Code CLI | Interactive REPL, `-p/--print`, `--output-format json|stream-json`, resume/continue, permission controls, MCP config | Users expect one-shot and interactive modes in the same binary, plus machine-readable output and session continuation |
| Gemini CLI | Terminal-first agent, prompt mode, documented JSON/streamed output, checkpointing, built-in search/file/shell/web tools, MCP support | Users expect a CLI agent to be both human-friendly and automation-friendly |
| aider | Strong command vocabulary, chat modes (`code`, `ask`, `architect`), file-scoped context controls, git integration | Users expect role/mode shortcuts, not only low-level API flags |
| Perplexity-style workflows | Ask a question in terminal, get grounded answer, sources, optional filters, stream partial output | Users often mean "fast one-shot research from the shell" when they say CLI mode |
| Codex positioning | Terminal-based local collaboration plus delegated/background work in cloud/app form | Users increasingly expect background execution and parallel agent workflows, not just a synchronous REPL |

### Detailed Takeaways

#### 1. Claude Code sets the clearest modern pattern for an agentic CLI

Anthropic's CLI reference explicitly combines:

- interactive REPL mode,
- one-shot print mode via `-p`,
- piped input,
- JSON and `stream-json` output,
- `--resume` and `--continue`,
- permission controls,
- MCP integration.

That is important because it shows that users now expect one binary to cover:

- human use,
- script use,
- session reuse,
- structured output,
- and tool integration.

For this repo, that strongly suggests the CLI should not be a narrow "just spawn a run" wrapper. It should cover the full run lifecycle.

#### 2. Gemini CLI reinforces the "terminal-first agent" expectation

Gemini CLI positions itself as:

- terminal-first,
- scriptable,
- searchable,
- checkpointable,
- MCP-extensible.

The important lesson is not the exact feature list. The important lesson is that modern AI CLIs are expected to be both:

- friendly for direct use, and
- integrable into automation.

This argues for supporting:

- text output for humans,
- JSON/JSONL for scripts,
- and resumable sessions.

#### 3. aider shows the value of task-oriented command vocabulary

aider exposes distinct working modes like:

- ask,
- code,
- architect,
- slash commands like `/add`, `/drop`, `/diff`, `/commit`.

The lesson for this repository is that the raw `role` enum (`planner`, `worker`, `reviewer`) is useful internally, but the CLI should offer higher-level verbs. For example:

- `orchestrator ask` -> planner
- `orchestrator run` -> worker
- `orchestrator review` -> reviewer

That is more discoverable than forcing users to always specify `--role`.

#### 4. Perplexity-style CLI expectations are about one-shot research workflows

Perplexity's official APIs emphasize:

- web-grounded responses,
- search filtering by domain/region/recency,
- streaming,
- source visibility.

There is not an obvious official canonical Perplexity terminal client documented the way Claude Code and Gemini CLI are, so this proposal interprets "Perplexity-style CLI" as a user expectation rather than a specific upstream product contract.

What users generally mean is:

- quick question in shell,
- answer with grounding,
- compact output by default,
- sources/citations when relevant,
- streaming for long responses,
- scriptable behavior.

For this repo, that translates best to an `ask` command and a strong non-interactive mode. It does not require the orchestrator itself to become a search engine.

#### 5. Background and delegated runs are now part of the CLI expectation set

OpenAI's Codex help material positions Codex as usable:

- locally in terminal/IDE,
- and through delegated/background workflows.

Even though this repo is local orchestration rather than a cloud task system, users now reasonably expect:

- detach,
- inspect later,
- continue later,
- and run multiple agents in parallel.

That matters because it is exactly where the current architecture still needs one major addition: a local supervisor process.

## Current Codebase Assessment

### What already exists

The current architecture is:

`transport -> RunManager -> adapter handle -> normalized events + file-backed storage`

Concretely:

- `src/server.ts` creates a `RunManager` and registers MCP tools on top.
- `src/core/run-manager.ts` owns orchestration behavior.
- `src/core/storage.ts` persists runs, sessions, inboxes, and artifacts.
- `src/core/session-manager.ts` manages session records.
- `src/adapters/codex.ts`, `src/adapters/claude.ts`, and `src/backends/remote-a2a.ts` implement backends behind the same adapter contract.
- `src/core/event-sanitizer.ts` and `src/core/event-buffer.ts` provide durable and live event handling.
- `src/tools/*.ts` are thin MCP wrappers.

The project already supports these operations through `RunManager` and MCP:

- spawn a run,
- inspect a run,
- poll events,
- cancel a run,
- continue a run waiting for input/auth,
- list runs,
- fetch event artifacts,
- list stable agent identities,
- send agent messages,
- fetch agent inbox messages.

There is also already a small CLI surface:

- `peer`

The existing `peer` binary is important because it proves two things:

1. The codebase already accepts "CLI is allowed here".
2. A CLI can read and act on orchestration state without going through MCP.

### Architectural strengths

These are the parts that make CLI compatibility realistic:

1. MCP is already thin.
   The real logic is not inside the MCP layer. That means a CLI can reuse the core directly.

2. The adapter contract is clean.
   Backends already implement a transport-independent interface:
   - `spawn()`
   - `run()`
   - optional `continue()`
   - `cancel()`
   - `eventStream`

3. The event model is already normalized.
   CLI rendering can build on existing event types like:
   - `agent_message`
   - `command_started`
   - `command_finished`
   - `tool_started`
   - `file_changed`
   - `input_required`
   - `run_completed`

4. Storage is already durable and useful outside MCP.
   Runs, sessions, artifacts, and inboxes are already persisted on disk.

5. There is already a notion of stable agent identity.
   Session nicknames and `list_agents` / `send_agent_message` are strong primitives for CLI workflows.

6. The codebase already distinguishes session from run.
   That maps naturally to CLI concepts like:
   - "resume the session"
   - "inspect this run"
   - "tail this run"

### Current limitations that matter for CLI mode

These are the important gaps.

#### 1. The existing CLI is not a general orchestration CLI

`peer` is agent-centric and narrow. It supports:

- who am I,
- list agents,
- send a message,
- read inbox,
- wait for inbox.

It does not support:

- spawn,
- tail events,
- wait for completion,
- cancel,
- continue,
- artifact reads,
- session inspection,
- detached/background run management.

#### 2. Active control is process-local

This is the biggest architectural constraint.

`continueRun()` and `cancelRun()` require the run to still be active in the current process because they need the live adapter handle.

That means:

- persisted runs can be inspected across invocations,
- but active runs cannot be fully controlled from a different process unless the original process is still alive and reachable.

For foreground CLI mode, that is fine.

For detached/background CLI mode, it is not enough.

#### 3. There is no direct streaming CLI transport

Today the system offers:

- in-process event buffering for live runs,
- filesystem reads for historical runs,
- MCP long-polling for clients.

That is enough for MCP and for a small polling CLI, but it is not yet ideal for:

- `tail -f` style UX,
- attached live rendering,
- low-latency JSON event streaming between a daemon and a CLI client.

#### 4. There is no general config/auth UX

Today auth is effectively backend-native:

- Codex auth is whatever the Codex SDK / environment already uses.
- Claude auth is whatever Claude Code SDK / environment already uses.
- Remote A2A auth comes from explicit backend config.

That is acceptable internally, but CLI users will expect:

- `config show`,
- `auth doctor`,
- defaults for backend/role/output,
- and better error messages when prerequisites are missing.

#### 5. The current documentation is already drifting

The README no longer reflects the full current tool surface and does not document the `peer` CLI.

That matters because a broader CLI rollout will fail if the project continues to treat local invocation as secondary.

#### 6. Scaling characteristics are currently simple, not optimized

The current JSONL reads for events/inboxes are straightforward but load whole files and filter in memory.

That is acceptable for an MCP prototype and moderate CLI use.

It may need refinement if detached runs become common and logs get large.

## Gap Analysis: What Must Change To Be Truly CLI-Compatible

### Functional gaps

| Capability | Current state | Gap |
| --- | --- | --- |
| Foreground synchronous run | Not exposed as CLI | Need `run` / `ask` / `review` commands |
| Detached/background run | Not supported as a CLI workflow | Need local supervisor/daemon |
| Status inspection | Partially available through MCP and storage | Need human CLI and script CLI commands |
| Event tailing | Possible by polling | Need proper `tail` UX and JSONL streaming |
| Continue/auth-required flows | Exists only for active in-process runs | Need daemon-owned run handles |
| Cancel from later invocation | Same limitation | Need daemon-owned run handles |
| Structured automation output | MCP has structured output; CLI does not | Need `--output json` / `--output jsonl` |
| Interactive REPL | Not present | Optional phase 2, but should be planned |
| Backend defaults/config | Ad hoc | Need config/env story |
| Auth diagnostics | Ad hoc | Need `auth doctor` and backend-specific error shaping |

### UX gaps

| UX expectation | Current state | Gap |
| --- | --- | --- |
| Obvious top-level binary | Only `peer` exists | Need `orchestrator` bin |
| Human-friendly verbs | Internal tool names are low-level | Need task-oriented commands |
| Consistent help text | Minimal hand-rolled parser in `peer` | Need full CLI help and flag docs |
| Shell-friendly piping | Not generally exposed | Need stdin/file/prompt support |
| Exit codes | Not standardized | Need predictable command exit behavior |

### Architecture gaps

| Area | Current state | Gap |
| --- | --- | --- |
| Core transport abstraction | MCP and peer each talk to core differently | Need a shared service/client boundary |
| Cross-process active control | No local control plane | Need daemon or equivalent local host |
| Streaming transport | Polling only | Need local streaming channel |
| Lifecycle management | MCP server owns active runs only while alive | Need supervisor semantics for CLI detach |

## Implementation Options

## Option 1: Thin In-Process CLI Over `RunManager`

### Description

Add a new `orchestrator` CLI that directly constructs `RunManager` with the existing adapters and runs commands in-process.

This would support:

- `orchestrator run`
- `orchestrator ask`
- `orchestrator review`
- `orchestrator runs list`
- `orchestrator runs show`
- `orchestrator events tail`
- `orchestrator artifacts get`
- `orchestrator agents ...`

Foreground mode would work well because the CLI process itself holds the live adapter handle.

### Advantages

- Fastest path to initial CLI support.
- Reuses the existing code almost directly.
- Low protocol complexity.
- Great for one-shot, attached, script-style usage.

### Disadvantages

- Detached/background runs remain weak.
- Once the foreground CLI exits, no later process can continue/cancel the live run.
- Tailing from another process falls back to polling persisted events only.
- No single always-on local owner for active handles.

### Best use

- MVP if the goal is only foreground CLI mode.

### Verdict

Good as a phase, not good enough as the full answer to the user's stated goal because background/status/continue/cancel later are explicit requirements.

## Option 2: Local Supervisor/Daemon Plus CLI Client

### Description

Introduce a long-lived local orchestration host process. The new `orchestrator` CLI becomes a client:

- foreground commands can run attached,
- detached commands register work with the supervisor,
- later invocations can inspect, continue, cancel, or tail those runs through a local control channel.

The supervisor owns:

- the `RunManager`,
- the adapters,
- all active handles,
- live event subscriptions.

The CLI becomes a renderer and request client.

### Advantages

- Fully supports background/detached workflows.
- Makes `continue` and `cancel` work across CLI invocations.
- Enables true `tail` and `wait` commands.
- Creates one local control plane usable by both CLI and MCP.
- Provides a path to future GUI, TUI, or local HTTP API without changing the core again.

### Disadvantages

- More moving parts.
- Requires daemon lifecycle management.
- Requires local IPC transport design.
- Needs crash/restart semantics for active runs.

### Best use

- Full CLI compatibility with background tasks.

### Verdict

Recommended.

## Option 3: CLI Wrapper That Talks To An Embedded MCP Server

### Description

Create an `orchestrator` CLI that internally starts or connects to the project's own MCP server and calls the same tool surface.

### Advantages

- Maximum reuse of the existing public tool contract.
- Very little semantic drift between MCP and CLI.

### Disadvantages

- MCP is request/response oriented, not a natural local CLI control plane.
- Streaming remains awkward because the CLI would still be translating polling semantics.
- Detached/background control is still not solved unless there is also a daemon behind the MCP server.
- Error handling and exit codes become indirect.
- Internally dogfooding MCP for local CLI calls adds complexity without giving users new value.

### Best use

- Debugging and test harnesses, not the primary architecture.

### Verdict

Not recommended as the main approach.

## Recommended Architecture

Use a hybrid of Option 1 and Option 2:

1. Add a first-class `orchestrator` CLI now.
2. Make foreground/attached commands work in-process immediately.
3. Add a supervisor/daemon for detached and cross-process control.
4. Put a small transport-neutral service/client boundary between the CLI/MCP layers and `RunManager`.

### Design Principles

1. Keep `RunManager` as the canonical orchestration engine.
2. Do not re-encode orchestration rules in both MCP and CLI layers.
3. Reuse current normalized events and storage format wherever possible.
4. Add new code at the transport and UX layers, not by rewriting the adapter model.
5. Preserve the current MCP tool surface for compatibility.

### Proposed Internal Layers

```text
CLI / MCP / future UI
        |
Orchestrator Client API
        |
Local In-Process Host OR Local Supervisor Host
        |
RunManager
        |
Adapters (codex / claude_code / remote_a2a)
        |
Storage / Sessions / Event artifacts
```

### Proposed new modules

Suggested structure, not a hard requirement:

```text
src/
  cli/
    orchestrator.ts
    renderers/
      text.ts
      json.ts
      jsonl.ts
    commands/
      run.ts
      ask.ts
      review.ts
      runs.ts
      events.ts
      artifacts.ts
      agents.ts
      daemon.ts
      config.ts
      auth.ts
  app/
    orchestrator-service.ts
    orchestrator-client.ts
    in-process-host.ts
  daemon/
    server.ts
    client.ts
    pidfile.ts
    socket.ts
```

This proposal does not require moving all current code. It mainly introduces:

- a reusable host/client abstraction,
- a broader CLI surface,
- an optional supervisor process.

### How MCP should fit after the change

MCP should remain supported, but it should no longer be the only first-class entrypoint.

Recommended rule:

- CLI and MCP both call the same service boundary.
- The CLI uses the in-process host for attached mode and the daemon host for detached mode.
- The MCP server can either:
  - keep using `RunManager` directly in-process, or
  - optionally proxy to the daemon host later if a unified host is desirable.

I would not make MCP depend on the daemon for the first rollout. Keep transports decoupled until the CLI mode is stable.

## Command UX Design

The user asked specifically for `orchestrator ...` examples. This section uses that as the proposed binary name.

### Top-level command families

High-level task verbs:

- `orchestrator ask`
- `orchestrator run`
- `orchestrator review`

Lifecycle/admin verbs:

- `orchestrator runs ...`
- `orchestrator events ...`
- `orchestrator artifacts ...`
- `orchestrator sessions ...`
- `orchestrator agents ...`
- `orchestrator daemon ...`
- `orchestrator config ...`
- `orchestrator auth ...`

Compatibility:

- keep `peer` as a compatibility wrapper
- also expose `orchestrator agents send|inbox|wait|list`

### High-level command mapping to current roles

| CLI command | Internal role | Default behavior |
| --- | --- | --- |
| `orchestrator ask` | `planner` | analysis, planning, explanation, optionally read-only |
| `orchestrator run` | `worker` | code-changing execution |
| `orchestrator review` | `reviewer` | review/remediation flow, optionally defaulting to `profile/reviewer-remediator.md` |

This is a better UX than forcing users to say `--role reviewer` every time.

### Example commands

#### Foreground one-shot

```bash
orchestrator ask "Summarize the architecture of this repository"
orchestrator run "Implement a CLI mode for this project" --backend codex
orchestrator review "Review the latest diff and fix low-risk issues"
```

#### Foreground with structured output

```bash
orchestrator ask "Summarize this repo" --output json
orchestrator run "Find test failures" --output jsonl
```

#### Piped input

```bash
git diff --staged | orchestrator ask "Summarize these staged changes"
cat failing.log | orchestrator run "Diagnose the failure from this log"
```

#### Detached/background

```bash
orchestrator run "Implement the migration" --detach --name worker1
orchestrator review "Audit the latest changes" --detach --name reviewer1
```

#### Inspecting and tailing

```bash
orchestrator runs list
orchestrator runs list --status running
orchestrator runs show 8c7d0a41-...
orchestrator events tail 8c7d0a41-...
orchestrator events tail 8c7d0a41-... --output jsonl
```

#### Continue/cancel

```bash
orchestrator continue 8c7d0a41-... --message "Approved. Proceed with the safer option."
orchestrator cancel 8c7d0a41-...
```

#### Session reuse

```bash
orchestrator sessions list
orchestrator resume 5a2f... "Continue the previous implementation"
orchestrator run "Continue previous session" --resume 5a2f...
```

#### Agent messaging

```bash
orchestrator agents list
orchestrator agents send reviewer1 "Please review the latest checkpoint"
orchestrator agents inbox --agent reviewer1
orchestrator agents wait --agent reviewer1
```

#### Artifact retrieval

```bash
orchestrator artifacts get 8c7d0a41-... 14 /stdout
orchestrator artifacts get 8c7d0a41-... 22 /raw_tool_use_result --output-file tool.json
```

#### Supervisor lifecycle

```bash
orchestrator daemon start
orchestrator daemon status
orchestrator daemon stop
```

### Default command behavior recommendations

#### `ask`

- Default role: `planner`
- Default output: text
- Default expectation: mostly non-mutating analysis
- Optional future behavior: `--read-only`

#### `run`

- Default role: `worker`
- Default output: text with live event rendering
- Default working directory: current directory
- Default session mode: new

#### `review`

- Default role: `reviewer`
- If `profile/reviewer-remediator.md` exists or a configured reviewer profile exists, use it by default.
- This is directly grounded in the current repo because the reviewer profile already exists.

### Input options

Recommended common options across `ask`, `run`, `review`:

- positional prompt or `-p/--prompt`
- `--backend codex|claude_code|remote_a2a`
- `--cwd /abs/path`
- `--detach`
- `--resume <session-id>`
- `--name <agent-name>`
- `--profile <path>`
- `--schema <path-to-json-schema>`
- `--metadata key=value`
- `--output text|json|jsonl`
- `--wait`
- `--timeout <ms>`

Recommended stdin behavior:

- If stdin is piped and no explicit structured input is provided, append piped text as an additional text part to the user input.
- If both prompt and stdin are present, keep both.

That gives the CLI the shell composability users expect.

## Input / Output Streaming Model

### Recommendation

Reuse the existing `NormalizedEvent` stream as the canonical streaming event model.

Do not invent a second event grammar if it can be avoided.

### Why this fits the current codebase

The repository already standardizes event types and artifacts:

- live event flow in `RunManager`
- durable `events.jsonl`
- artifact offloading for large payloads

That is a strong foundation. The CLI should build on it.

### Output modes

#### 1. `text`

Human-friendly default output.

Recommended rendering rules:

- print high-signal status changes,
- stream `agent_message` text,
- summarize command/tool/file events,
- print `input_required` / `auth_required` prominently,
- print final summary/result at the end.

Example:

```text
[running] worker1 (codex)
Thinking...
Running: npm test
Command finished: npm test (exit 1)
Updated 2 file(s)
Run completed
```

#### 2. `json`

One final machine-readable payload:

- run summary,
- terminal status,
- final response,
- structured output if available,
- last sequence number.

This is for wrappers that do not want incremental events.

#### 3. `jsonl`

Newline-delimited JSON event stream for scripts and programmatic wrappers.

Recommended shape:

- one line per normalized event,
- final line may include a terminal summary object.

This is the most natural match for the current event architecture.

### Attached mode behavior

In attached mode:

- the CLI should subscribe to live events,
- render them as they happen,
- and exit when the run reaches a terminal or waiting state.

Suggested exit behavior:

- if the run completes: return exit code 0
- if the run fails: non-zero
- if the run enters `input_required` or `auth_required` and the command is non-interactive: return a dedicated non-zero code with the run id visible

### Detached mode behavior

In detached mode:

- start the run through the daemon,
- return immediately with:
  - `run_id`
  - `session_id`
  - `agent_name`
  - initial status

Default text output should be compact:

```text
run_id=8c7d0a41-... status=queued agent=worker1 session=5a2f...
```

Default JSON output should return the structured spawn result.

### Streaming transport between CLI and daemon

For the daemon path, the easiest practical option in Node is:

- local HTTP over a Unix domain socket on macOS/Linux
- local HTTP over a named pipe on Windows later if cross-platform matters
- NDJSON for follow/tail endpoints

Why HTTP over local socket is a good fit here:

- Express is already a dependency.
- It is easy to expose:
  - normal request/response endpoints,
  - a chunked NDJSON stream for event tailing.
- It is easy to debug.
- It avoids inventing a custom IPC protocol too early.

This local control API does not need to be public or documented as a stable user-facing HTTP product. It is simply a good internal transport for CLI mode.

## Session And State Handling

### Current model

The codebase already has the right conceptual split:

- session = stable conversation/identity
- run = one execution instance on top of that session

That should remain unchanged.

### Recommended CLI semantics

#### Session creation

By default:

- `ask`, `run`, and `review` create a new session unless the user asks to resume.

#### Session resume

Support both:

- explicit resume by session id
- continue-most-recent semantics

Examples:

```bash
orchestrator resume <session-id> "continue from prior context"
orchestrator run "continue" --continue
```

Recommended internal mapping:

- `resume <session-id>` -> existing `session_mode: resume`
- `--continue` -> find most recent session for the current cwd/backend/agent and resume it

### Stable agent naming

Keep the existing nickname/agent-name model.

CLI should expose it more directly:

- `--name worker1`
- `--name reviewer1`

That is already supported internally via `nickname` on `spawnRun`.

### Storage compatibility

Do not replace the current storage layout for v1 CLI support.

Keep:

```text
<cwd>/.nanobot-orchestrator/
  runs/
  sessions/
```

Because:

- it already works,
- the current tests cover it,
- `peer` already depends on it,
- MCP tooling already depends on it,
- event artifact retrieval already depends on it.

### Additional daemon metadata

Add a separate daemon control area, preferably outside project repos:

```text
~/.nanobot-orchestrator/
  daemon/
    daemon.json
    control.sock
    logs/
```

This should not disturb per-project run/session storage.

### Crash/restart handling

This is a required part of background run support.

Recommended rule:

- if the daemon is restarted and finds runs previously marked `queued`, `running`, `input_required`, or `auth_required` with no live handle, mark them terminal with a descriptive failure reason such as:
  - `orchestrator host stopped before the run completed`

This is better than silently leaving them in an impossible active state.

## Auth And Config Handling

### Recommendation

Do not build custom login flows in v1.

Instead:

1. preserve backend-native auth,
2. add a clean config layer for defaults,
3. add an `auth doctor` command that checks prerequisites and explains failures clearly.

### Why this matches the current codebase

The existing adapters already assume backend-native auth:

- Codex uses the Codex SDK environment.
- Claude uses the Claude Agent SDK environment.
- Remote A2A uses explicit config and headers.

Trying to own login UX inside this project would increase scope significantly and would not be necessary for initial CLI compatibility.

### Proposed config sources

Priority order:

1. CLI flags
2. environment variables
3. user config file
4. built-in defaults

### Proposed config file

Because this repository currently has no general config loader, the simplest v1 format is JSON:

```json
{
  "default_backend": "codex",
  "default_role": "worker",
  "default_output": "text",
  "daemon": {
    "autostart": true
  },
  "backends": {
    "remote_a2a": {
      "agent_url": "http://127.0.0.1:53552",
      "headers_env": ["A2A_AUTH_TOKEN"]
    }
  },
  "profiles": {
    "reviewer": "/abs/path/to/profile/reviewer-remediator.md"
  }
}
```

Suggested location:

```text
~/.nanobot-orchestrator/config.json
```

### Suggested environment variables

- `ORCHESTRATOR_HOME`
- `ORCHESTRATOR_DEFAULT_BACKEND`
- `ORCHESTRATOR_DEFAULT_OUTPUT`
- `ORCHESTRATOR_REMOTE_A2A_URL`

Keep backend-native auth env/config behavior as-is for:

- Codex
- Claude Code
- remote A2A headers/tokens

For this project's own backends, the important point is not to hide the upstream auth requirements.

### `orchestrator auth doctor`

Recommended checks:

- for `codex`:
  - can the SDK initialize?
  - are expected environment/config signals present?
- for `claude_code`:
  - can the SDK initialize?
  - does auth appear configured?
- for `remote_a2a`:
  - is `agent_url` configured?
  - can the agent card be fetched?

`auth doctor` should print actionable next steps rather than raw stack traces.

## Background Runs And Status Inspection

This is where the daemon matters most.

### Required behaviors

Users should be able to:

1. start a run detached
2. list detached runs
3. inspect one run
4. tail its events
5. continue it if input is required
6. cancel it
7. retrieve artifacts

### Proposed daemon behavior

#### Start behavior

- `orchestrator daemon start` starts the local supervisor.
- `orchestrator run --detach` auto-starts the daemon if allowed by config.

#### Status behavior

Use existing run summaries as the stable inspection surface:

- `orchestrator runs list`
- `orchestrator runs show <run-id>`

The daemon should return the same canonical fields already used by MCP:

- `run_id`
- `backend`
- `role`
- `session_id`
- `agent_name`
- `status`
- `started_at`
- `updated_at`
- `summary`
- `last_seq`
- `cwd`
- `metadata`
- `remote_ref`

That keeps CLI, daemon, and MCP aligned.

#### Waiting

Add:

```bash
orchestrator runs wait <run-id>
```

Semantics:

- block until:
  - terminal status,
  - waiting status (`input_required` / `auth_required`),
  - timeout.

This is more ergonomic than forcing users to manually tail or poll.

#### Continue

Add:

```bash
orchestrator continue <run-id> --message "..."
```

This should route to the daemon, which still owns the live adapter handle.

#### Cancel

Add:

```bash
orchestrator cancel <run-id>
```

Again, this should route to the daemon for active runs.

#### Tail

Add:

```bash
orchestrator events tail <run-id>
```

Behavior:

- if connected to daemon and run is live, follow live events,
- otherwise fall back to persisted `events.jsonl`.

That makes the command useful even for historical runs.

## Error Handling

### Recommendation

Standardize both:

- human-facing error messages,
- process exit codes.

The project already has good internal validation via Zod. CLI mode should translate those errors into a predictable contract.

### Suggested exit codes

| Exit code | Meaning |
| --- | --- |
| `0` | Success / completed |
| `2` | Usage or validation error |
| `3` | Configuration or auth prerequisite missing |
| `4` | Backend unavailable or daemon unavailable |
| `5` | Run failed |
| `6` | Run cancelled |
| `7` | Run requires input/auth and the command was non-interactive |
| `8` | Internal transport or unexpected orchestrator error |

### Error categories

#### 1. Usage errors

Examples:

- invalid flag combination
- missing prompt
- relative `cwd` when absolute path is required

These should not print stack traces by default.

#### 2. Backend prerequisite errors

Examples:

- Claude auth not configured
- remote A2A URL missing
- backend binary/SDK unavailable

These should give:

- what failed,
- which backend,
- how to fix it.

#### 3. Run-state errors

Examples:

- `continue` called on a completed run
- `cancel` called for a historical run not owned by any live daemon

These should mention:

- `run_id`
- current status
- whether the daemon currently owns the run

#### 4. Daemon transport errors

Examples:

- socket missing
- daemon stale pidfile
- daemon incompatible version

These should provide recovery commands such as:

```text
Run `orchestrator daemon start` or remove the stale socket file.
```

### Text output policy

Default CLI mode should be concise:

- one-line error summary,
- optional `--verbose` or `ORCHESTRATOR_DEBUG=1` for full stack trace.

## Logging And Telemetry

### Logging

The project already has excellent raw material for logs:

- normalized events,
- artifacts,
- run summaries.

Recommended additions:

1. CLI log file:

```text
~/.nanobot-orchestrator/logs/cli.log
```

2. Daemon log file:

```text
~/.nanobot-orchestrator/logs/daemon.log
```

3. Event-level correlation:

- include `run_id`, `session_id`, `agent_name`, `backend`

### Telemetry

Recommendation:

- no mandatory remote telemetry in v1
- if telemetry is added later, keep it opt-in only

This project feels like developer infrastructure, and opt-in only is the safer default.

### Useful local metrics

Even without remote telemetry, the daemon can maintain local counters:

- runs started by backend
- terminal status counts
- average queue wait time
- average run duration
- artifact bytes written
- number of waiting/auth-required interruptions
- daemon uptime

These are useful for debugging and future hardening.

## Testing Strategy

The repository already has a solid test culture around `RunManager`, storage, server registration, peer env, and peer CLI. The CLI proposal should extend that pattern rather than invent a separate manual-testing culture.

### 1. Unit tests

Add focused tests for:

- command parsing
- output mode selection
- exit code mapping
- config loading precedence
- daemon socket path logic
- text renderers for event sequences

### 2. Integration tests for foreground CLI

Use fake adapters similar to existing test doubles and verify:

- `orchestrator ask/run/review`
- text output
- JSON output
- JSONL output
- stdin handling
- `--resume`

### 3. Integration tests for daemon mode

Spawn the supervisor in a temp directory and test:

- `run --detach`
- `runs list`
- `runs show`
- `events tail`
- `continue`
- `cancel`
- daemon restart behavior

### 4. Compatibility tests

Do not regress existing surfaces:

- existing MCP tools still register and behave the same
- existing `peer` commands keep working
- current storage layout remains readable

### 5. Failure-path tests

Must include:

- missing auth/config
- invalid remote A2A URL
- backend crash
- daemon crash during active run
- stale socket / stale pidfile
- continuing a completed run

### 6. Snapshot-style renderer tests

Because CLI UX matters, add snapshot tests for:

- text event rendering
- status summaries
- error formatting

### 7. Performance sanity tests

Because event and inbox reads are currently simple JSONL scans, add basic tests for:

- large `events.jsonl`
- large inbox files
- artifact retrieval slices

This is not premature optimization. It is making sure the CLI stays usable on large runs.

## Migration And Rollout Plan

### Phase 0: Documentation correction

Before major code changes:

- update README to document the full current MCP surface
- document `peer`
- document storage/inbox behavior accurately

This reduces confusion immediately.

### Phase 1: Shared CLI foundation

Implement:

- `orchestrator` binary
- common command parser
- renderer layer
- in-process host/client wrapper over `RunManager`

Ship read-only/admin commands first:

- `runs list`
- `runs show`
- `events tail`
- `artifacts get`
- `agents ...`

This is low risk and builds momentum.

### Phase 2: Foreground execution

Add:

- `ask`
- `run`
- `review`

in attached mode only.

This already satisfies a large part of "CLI mode" for direct use.

### Phase 3: Local supervisor/daemon

Add:

- daemon host
- detach support
- `runs wait`
- `continue`
- `cancel`
- daemon lifecycle commands

This is the point where CLI compatibility becomes complete enough for serious use.

### Phase 4: Session ergonomics and peer consolidation

Add:

- `resume`
- `--continue`
- `sessions list`
- `orchestrator agents ...`

Keep `peer` as a compatibility alias, but route the long-term docs toward `orchestrator agents`.

### Phase 5: Hardening

Add:

- auth doctor
- config docs
- shell completions
- richer renderer polish
- large-run performance improvements if needed

## File-Level Implementation Recommendations

This section is intentionally concrete and grounded in the actual codebase.

### Reuse without major redesign

Keep as-is conceptually:

- `src/core/run-manager.ts`
- `src/core/storage.ts`
- `src/core/session-manager.ts`
- `src/core/types.ts`
- `src/core/schemas.ts`
- adapter files

### Extend rather than replace

Recommended additions to `RunManager` or an adjacent service:

- `watchRun(runId, afterSeq?) -> AsyncIterable<NormalizedEvent>`
- `waitRun(runId, options)`
- `findLatestSession(...)`
- `findLatestRun(...)`

These are convenience operations that CLI mode wants frequently.

### Preserve MCP tools

Keep:

- `src/tools/*.ts`
- `src/server.ts`
- `src/index.ts`

The MCP layer should not be rewritten just because a CLI is added.

### Evolve `peer`

Keep:

- `src/cli/peer.ts`

But over time:

- either reimplement it on top of the new CLI command library,
- or keep it as a thin compatibility shim delegating to `orchestrator agents ...`.

## Risks And Open Questions

### 1. Daemon complexity is real

The supervisor is the right answer for background runs, but it adds:

- lifecycle management,
- IPC transport,
- crash recovery,
- version compatibility concerns.

This is manageable, but it is the hardest part of the proposal.

### 2. Backend headless behavior may differ in edge cases

Even though the adapters already work for MCP-driven orchestration, daemonized CLI usage may expose new edge cases:

- auth refresh timing,
- long-lived SDK objects,
- terminal assumptions in upstream SDKs,
- cancellation races.

This is a testing risk, not a design blocker.

### 3. Windows support is not clearly addressed by the current repo

The repo clearly runs in Node and should theoretically be portable, but the current path/env assumptions and the proposed Unix socket control path are more naturally macOS/Linux first.

Open question:

- Is Windows first-class for CLI mode?

If yes, named pipes or localhost TCP should be planned early.

### 4. Current JSONL reads may eventually become a scaling bottleneck

The current storage is simple and robust, but CLI adoption may increase:

- number of runs,
- event volume,
- inbox size.

This is likely acceptable for v1, but large-run behavior should be observed.

### 5. Naming is still open

The user asked for `orchestrator ...` examples. That is a good product name for the proposal.

But the actual package name is currently `nanobot-orchestration-mcp`.

Open question:

- Should the bin be `orchestrator`, `nanobot-orchestrator`, or both?

My recommendation is:

- ship `orchestrator` as the primary bin,
- keep `peer`,
- keep the package name unchanged unless there is a broader packaging plan.

### 6. How much interactive REPL should v1 include?

This proposal includes attached one-shot mode as mandatory and a full interactive REPL as optional phase 2+.

That is intentional.

A rich REPL is valuable, but:

- it is not required to unlock CLI compatibility,
- and the detached/lifecycle/admin path is more important for this project's orchestration identity.

### 7. Should MCP eventually proxy to the daemon?

There are good reasons to do that later:

- one active run host,
- one local control plane,
- easier status continuity.

But there are also reasons not to do it immediately:

- extra complexity,
- possible new failure modes,
- less isolation between transports.

Recommendation:

- do not make this part of the first CLI rollout.

## Recommended Final Direction

The right end state is:

1. This project has a first-class `orchestrator` CLI.
2. MCP remains supported, but is only one transport among several.
3. Foreground commands run directly and render live events.
4. Detached commands are hosted by a local supervisor process.
5. The current `RunManager` + adapters + storage remain the orchestration core.
6. The existing `peer` behavior becomes one sub-area of the broader CLI, not a separate product story.

In short:

- do not rebuild the orchestrator around CLI,
- do not rebuild it around MCP,
- make the orchestration core transport-neutral and let both CLI and MCP sit on top of it.

That is the smallest design that fully addresses the user's goal.

## Proposed Initial Scope For Implementation

If implementation started immediately, I would sequence it like this:

1. Add `orchestrator` binary and command framework.
2. Ship read-only/admin commands first.
3. Ship attached `ask/run/review`.
4. Add daemon for `--detach`, `continue`, `cancel`, `wait`.
5. Fold `peer` into `orchestrator agents`.
6. Update README and examples.

That path gives value quickly while still converging on the recommended architecture.

## Sources

External research:

- Anthropic Claude Code CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-reference
- Google Gemini CLI README: https://github.com/google-gemini/gemini-cli
- aider documentation overview: https://aider.chat/docs/
- aider in-chat commands: https://aider.chat/docs/usage/commands.html
- aider chat modes: https://aider.chat/docs/usage/modes.html
- aider git integration: https://aider.chat/docs/git.html
- Perplexity Search API quickstart: https://docs.perplexity.ai/docs/search/quickstart
- Perplexity Sonar API quickstart: https://docs.perplexity.ai/docs/sonar/quickstart
- Perplexity Sonar core features: https://docs.perplexity.ai/docs/sonar/features
- OpenAI Codex CLI getting started: https://help.openai.com/en/articles/11096431-openai-codex-cli-getting-started

Local codebase inspection:

- `README.md`
- `package.json`
- `src/server.ts`
- `src/index.ts`
- `src/core/run-manager.ts`
- `src/core/session-manager.ts`
- `src/core/storage.ts`
- `src/core/types.ts`
- `src/core/schemas.ts`
- `src/core/event-buffer.ts`
- `src/core/event-sanitizer.ts`
- `src/core/messages.ts`
- `src/core/profile.ts`
- `src/core/peer-env.ts`
- `src/adapters/codex.ts`
- `src/adapters/claude.ts`
- `src/backends/remote-a2a.ts`
- `src/cli/peer.ts`
- `src/tools/*.ts`
- `test/run-manager.test.mjs`
- `test/server.test.mjs`
- `test/storage.test.mjs`
- `test/session-manager.test.mjs`
- `test/peer-cli.test.mjs`
- `test/peer-env.test.mjs`
- `test/a2a-backend.test.mjs`
