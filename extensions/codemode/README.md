# Ziggy Code Mode

This optional Pi package registers one tool, `codemode_execute`. It parses JavaScript with Acorn
and evaluates a fixed orchestration subset in an owned tree-walking interpreter. It never passes
source to `eval`, `Function`, `vm`, a shell, or a general JavaScript runtime.

## Profile configuration

Create a physical, regular, non-symlink `codemode.json` at the Profile root. Every stdio server and
every callable tool must be explicit:

The package opens this file once with the platform's no-follow flag, validates the opened handle,
reads from that same handle, and always closes it. Platforms without a reliable no-follow open flag
fail closed instead of falling back to a symlink-racy read.

```json
{
  "mcpServers": {
    "notes": {
      "command": "/absolute/path/to/mcp-server",
      "args": ["--stdio"],
      "env": { "NOTES_TOKEN": "host-only-value" },
      "allowTools": ["search_notes", "get_note"]
    }
  },
  "limits": {
    "timeoutMs": 30000,
    "maxSteps": 50000,
    "maxToolCalls": 20,
    "maxOutputBytes": 32768,
    "maxCodeBytes": 32768,
    "maxCatalogTools": 100,
    "maxMcpMessageBytes": 262144
  }
}
```

The child receives only the configured `env` map. Generated code cannot inspect it. MCP clients
start on the first search or call and cache their bounded tool list for the Pi session. Timeout,
external cancellation, and `session_shutdown` revoke the clients, terminate their detached process
groups, escalate from TERM to KILL after a bounded grace period, and await confirmed child exit.
Stderr is deliberately ignored; stdout accepts only bounded newline-framed JSON-RPC messages as
required by the MCP stdio transport.

## Interpreter surface

Use `await tools.$codemode.search({ query, namespace?, limit? })` for bounded discovery, then call
an allowed MCP tool through `await tools.<server>.<tool>(input)`. Bracket access works for valid MCP
names that are not JavaScript identifiers. The first slice also supports JSON data, variables,
returns, conditionals, `while` and `for...of`, arrow functions, templates, basic operators, selected
safe array/string/Object/JSON helpers, and captured `console.log`, `warn`, and `error`.

All other identifiers, imports, dynamic code construction, prototypes, filesystem/network/process
globals, Pi tools, and non-allowed MCP tools fail closed. This is a confinement mechanism for tool
orchestration, not OS isolation; MCP servers themselves retain the authority granted by their
command, arguments, environment, and explicit `allowTools` policy.
