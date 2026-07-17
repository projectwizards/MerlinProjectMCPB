# MerlinProjectMCPB

Node.js port of the Swift `MerlinMCPShim`, packaged as an MCPB Desktop Extension. It exists
because Claude's Desktop Extension marketplace only accepts Node.js-based extensions; behavior
is identical to the Swift shim, and the two implementations should be kept in sync
(`server/index.js` ↔ `MerlinMCPShim/main.swift`, `server/bridge.js` ↔
`MerlinMCPShim/ShimBridge.swift`).

## Architecture

    IDE  ⇄  stdio  ⇄  shim Server  ⇄  shim Client (cached)  ⇄  UDS  ⇄  live Server (Merlin Project)

- `tools/list` / `resources/list` are answered locally from `server/catalog.json`, so agents see
  the full tool metadata even when Merlin Project isn't running.
- `tools/call` / `resources/read` are forwarded to the live in-app server over the Unix domain
  socket in the shared App Group container
  (`~/Library/Group Containers/9R6P9VZV27.net.projectwizards.merlinproject.mcp/mcp.sock`,
  overridable via `MERLIN_MCP_SOCKET` for testing).
- When Merlin Project isn't reachable, tool calls return a structured "not running" error and the
  shim reconnects automatically on the next call after the app launches — no client restart.
- The shim advertises the live server's identity when Merlin Project is up at session start, and
  forwards the IDE's real `clientInfo` (Claude, Cursor, …) on the socket handshake so the app's
  connected-tools popover shows the agent's name.

Unlike the Swift shim, the Node process has no App Group entitlement — it simply constructs the
container path directly, which works for unsandboxed processes. Note that macOS 15+ may prompt
the user once before a foreign process (Claude Desktop's node runtime) may read another app's
group container.

## Files

- `manifest.json` — MCPB manifest (`server.type: "node"`).
- `server/index.js` — entry point; stdio-facing MCP server.
- `server/bridge.js` — connection cache, UDS transport, forwarding logic.
- `server/catalog.json` — generated snapshot of the live server's `tools/list` /
  `resources/list`. **Do not edit by hand.**
- `scripts/generate-catalog.js` — regenerates `server/catalog.json` from a running build.
- `scripts/test-e2e.js` — end-to-end tests (live forwarding, app-down fallback, mid-session
  recovery).

## Workflow

```sh
npm install                  # once, and after dependency changes
npm run generate-catalog     # once after catalog changes; needs Merlin Project running
npm test                     # phase A needs Merlin Project running; B and C are self-contained
npm run pack                 # builds the .mcpb archive for marketplace submission
```

Swift's `MCPCatalog` remains the single source of truth for tool/resource metadata: the catalog
snapshot is generated from a live server (which serves that catalog), never written by hand.
Regenerate it and re-pack whenever the catalog changes.
