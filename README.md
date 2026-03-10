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

## `spawn_run` notes

- `backend`: currently only `"codex"`
- `role`: orchestration role label such as `planner`, `worker`, or `reviewer`
- `cwd`: absolute working directory
- `session_mode`: `new` or `resume`
- `session_id`: required when resuming a prior session
- `profile`: optional path to a persona/job-description file for future profile-driven behavior

Unless you are explicitly instructed to use a profile, leave `profile` empty.

- `output_schema`: optional JSON Schema for structured final output
- `metadata`: optional orchestration metadata stored for correlation and auditing

## Storage

Run artifacts are stored under:

```text
<cwd>/.nanobot-orchestrator/
```
