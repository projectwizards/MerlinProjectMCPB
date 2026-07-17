#!/usr/bin/env node
//
//  generate-catalog.js
//  MerlinProjectMCPB
//
//  Regenerates server/catalog.json — the tool/resource metadata the Node shim serves locally
//  for `tools/list` and `resources/list`.
//
//  Swift's `MCPCatalog` stays the single source of truth: this script connects to the *live*
//  MerlinProject server over the App Group Unix domain socket, asks it for `tools/list` and
//  `resources/list` (both of which the in-app server builds from `MCPCatalog`), and snapshots
//  the responses verbatim. Run it whenever `MCPCatalog.swift` changes, with MerlinProject (a
//  build containing the change) running:
//
//      npm run generate-catalog
//
//  The snapshot is committed so packaging the extension needs no running app.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { UnixSocketClientTransport } from "../server/bridge.js";

const appGroupID = "9R6P9VZV27.net.projectwizards.merlinproject.mcp";
const socketPath =
    process.env.MERLIN_MCP_SOCKET ??
    path.join(os.homedir(), "Library", "Group Containers", appGroupID, "mcp.sock");

const catalogPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "server",
    "catalog.json"
);

const client = new Client({ name: "MerlinMCPShim-CatalogGenerator", version: "1.0.0" });
try {
    // Fail fast on a bound-but-unserviced socket (e.g. app stuck in a modal dialog at launch)
    // instead of waiting out the SDK's 60 s default.
    await client.connect(new UnixSocketClientTransport(socketPath), { timeout: 10_000 });
} catch (error) {
    console.error(`Cannot connect to the live MerlinProject server at ${socketPath}:`);
    console.error(`  ${error.message}`);
    console.error("Launch MerlinProject (a build with the current MCPCatalog) and retry.");
    process.exit(1);
}

const serverInfo = client.getServerVersion();
const { tools } = await client.listTools();
const { resources } = await client.listResources();
await client.close();

// `serverName` is the stub-identity fallback the shim advertises when MerlinProject isn't
// running at session start — the counterpart of Swift's `MCPCatalog.serverName`.
const catalog = {
    serverName: serverInfo?.name ?? "MerlinProject",
    generatedFrom: `${serverInfo?.name} ${serverInfo?.version}`,
    tools,
    resources,
};

fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
console.log(
    `Wrote ${tools.length} tools and ${resources.length} resources ` +
        `from ${catalog.generatedFrom} to ${catalogPath}`
);
