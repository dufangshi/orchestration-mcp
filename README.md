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
- `list_runs`
- `get_event_artifact`

## `spawn_run` notes

- `backend`: `"codex"` or `"claude_code"`
- `role`: orchestration role label such as `planner`, `worker`, or `reviewer`
- `cwd`: absolute working directory
- `session_mode`: `new` or `resume`
- `session_id`: required when resuming a prior session
- `profile`: optional path to a persona/job-description file for future profile-driven behavior

Unless you are explicitly instructed to use a profile, leave `profile` empty.

- `output_schema`: optional JSON Schema for structured final output
- `metadata`: optional orchestration metadata stored for correlation and auditing

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

For `claude_code`, make sure the local environment already has a working Claude Code authentication setup before testing.

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
