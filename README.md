# nanobot orchestration MCP

TypeScript MCP server for launching and tracking external coding-agent runs.

## Install

```bash
cd orchestration-mcp
npm install
npm run build
```

## Run

```bash
cd orchestration-mcp
npm start
```

## nanobot config example

```json
{
  "tools": {
    "mcpServers": {
      "orchestrator": {
        "command": "node",
        "args": [
          "/abs/path/to/orchestration-mcp/dist/index.js"
        ]
      }
    }
  }
}
```

## Tools

- `spawn_run`
- `get_run`
- `poll_events`
- `cancel_run`
- `continue_run`
- `list_runs`
- `get_event_artifact`

## `spawn_run` notes

- `backend`: `"codex"`, `"claude_code"`, or `"remote_a2a"`
- `role`: orchestration role label such as `planner`, `worker`, or `reviewer`
- `prompt`: plain-text instruction for simple runs
- `input_message`: optional structured message for multipart/A2A-style inputs
- `cwd`: absolute working directory
- `session_mode`: `new` or `resume`
- `session_id`: required when resuming a prior session
- `profile`: optional path to a persona/job-description file for future profile-driven behavior

Unless you are explicitly instructed to use a profile, leave `profile` empty.

- `output_schema`: optional JSON Schema for structured final output
- `metadata`: optional orchestration metadata stored for correlation and auditing
- `backend_config`: optional backend-specific settings. For `remote_a2a`, set `agent_url` and any auth headers/tokens here.

For `remote_a2a`, `spawn_run.cwd` also becomes the remote subagent execution directory for that A2A task context.

At least one of `prompt` or `input_message` is required.

## `continue_run` notes

Use `continue_run` when a run enters `input_required` or `auth_required` and the backend supports interactive continuation.

Inputs:

- `run_id`
- `input_message`

## `get_event_artifact` notes

Use `get_event_artifact` when a sanitized event returned by `poll_events` contains `event.data.artifact_refs` and you need the full original payload.

Inputs:

- `run_id`
- `seq`
- `field_path`: JSON Pointer relative to `event.data`, for example `/stdout`, `/raw_tool_use_result`, or `/input/content`
- `offset`: optional byte offset, default `0`
- `limit`: optional byte limit, default `65536`

Typical flow:

1. Call `poll_events`.
2. Inspect `event.data.artifact_refs` on any sanitized event.
3. Call `get_event_artifact` with the same `run_id`, the event `seq`, and one of the exposed `field_path` values.

## Backend defaults

- `codex`: uses the current `@openai/codex-sdk` defaults plus non-interactive execution settings already wired in the adapter
- `claude_code`: uses `@anthropic-ai/claude-agent-sdk` with `permissionMode: "bypassPermissions"` so the MCP call stays non-blocking, and reuses persisted backend session ids for `resume`
- `remote_a2a`: connects to a remote A2A-compatible agent using `@a2a-js/sdk`, streams task updates into normalized orchestration events, and supports `continue_run` for `input_required`

For `claude_code`, make sure the local environment already has a working Claude Code authentication setup before testing.

## Test A2A agents

The repo includes helper modules for local A2A-wrapped test agents:

- `dist/test-agents/codex-a2a-agent.js`
- `dist/test-agents/claude-a2a-agent.js`
- `dist/test-agents/start-a2a-agent.js`

These export startup helpers that wrap the local Codex and Claude SDKs behind an A2A server so the orchestration MCP can test its internal `remote_a2a` backend against realistic subagents.

To start an interactive wrapper launcher:

```bash
npm run start:a2a-agent
```

The script will ask whether to wrap `codex` or `claude_code`.

After startup, it prints the `agent_url` and a ready-to-use `spawn_run` payload for the MCP layer. The wrapper no longer locks a working directory at startup. Each `remote_a2a` call uses the `cwd` provided to `spawn_run`, and the wrapper keeps that cwd fixed for the lifetime of the same A2A `contextId`.

## Storage

Run data is stored under:

```text
<cwd>/.nanobot-orchestrator/
  runs/
    <run_id>/
      run.json
      events.jsonl
      result.json
      artifacts/
        000008-command_finished/
          manifest.json
          stdout.0001.txt
          stdout.0002.txt
  sessions/
    <session_id>.json
```

Notes:

- `events.jsonl` stores sanitized events intended for `poll_events` consumption.
- Oversized raw payloads are moved into per-event artifact files and referenced from `event.data.artifact_refs`.
- `run.json` and `result.json` keep the current run snapshot and final result behavior.
