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

## Storage

Run artifacts are stored under:

```text
<cwd>/.nanobot-orchestrator/
```
