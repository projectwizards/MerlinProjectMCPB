// End-to-end test for MerlinProjectMCPB:
//   npm test
//
// Phase A needs a running MerlinProject build with the MCP server; phases B and C are
// self-contained.
//
// Phase A — live: talks to the running MerlinProject dev build.
// Phase B — down: socket override to a nonexistent path; expects stub identity + structured errors.
// Phase C — recovery: shim starts with no live server, then a fake live server appears mid-session;
//            expects the next call to succeed without a shim restart, and the fake server to see
//            the IDE's real clientInfo (not "MerlinMCPShim").

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const shimPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "index.js");
let failures = 0;

function check(label, condition, detail = "") {
    const mark = condition ? "PASS" : "FAIL";
    if (!condition) failures++;
    console.log(`  [${mark}] ${label}${condition ? "" : "  — " + detail}`);
}

async function connectShim(env) {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [shimPath],
        env: { ...process.env, ...env },
        stderr: "pipe",
    });
    const client = new Client({ name: "ShimE2ETest", version: "9.9.9" });
    await client.connect(transport);
    return client;
}

// ---------- Phase A: live app ----------
console.log("Phase A — live MerlinProject");
{
    const client = await connectShim({});
    const info = client.getServerVersion();
    check("advertises live identity", info?.name === "MerlinProject" && info?.version !== "0.0.0-stub",
        JSON.stringify(info));

    const { tools } = await client.listTools();
    check("tools/list serves 9 tools locally", tools.length === 9, `got ${tools.length}`);

    const { resources } = await client.listResources();
    check("resources/list serves 2 resources locally", resources.length === 2, `got ${resources.length}`);

    const result = await client.callTool({ name: "list_open_documents", arguments: {} });
    const text = result.content?.[0]?.text ?? "";
    check("tools/call list_open_documents forwards", !result.isError && text.length > 0,
        JSON.stringify(result).slice(0, 200));

    const read = await client.readResource({ uri: "schema://reduced" });
    const xsd = read.contents?.[0]?.text ?? "";
    check("resources/read schema://reduced forwards", xsd.includes("schema"), xsd.slice(0, 120));

    await client.close();
}

// ---------- Phase B: app down ----------
console.log("Phase B — MerlinProject not running (socket override to nonexistent path)");
{
    const client = await connectShim({ MERLIN_MCP_SOCKET: "/nonexistent/mcp.sock" });
    const info = client.getServerVersion();
    check("advertises stub identity", info?.name === "MerlinProject" && info?.version === "0.0.0-stub",
        JSON.stringify(info));

    const { tools } = await client.listTools();
    check("tools/list still serves 9 tools", tools.length === 9, `got ${tools.length}`);

    const result = await client.callTool({ name: "list_open_documents", arguments: {} });
    check("tools/call returns isError result with guidance",
        result.isError === true && result.content?.[0]?.text?.includes("not currently running"),
        JSON.stringify(result).slice(0, 200));

    let readError = null;
    try {
        await client.readResource({ uri: "schema://reduced" });
    } catch (error) {
        readError = error;
    }
    check("resources/read raises JSON-RPC error", readError !== null &&
        String(readError.message).includes("not currently running"), String(readError));

    await client.close();
}

// ---------- Phase C: live server appears mid-session ----------
console.log("Phase C — live server appears after the session started");
{
    const fakeSocketPath = path.join(os.tmpdir(), `merlin-shim-test-${process.pid}.sock`);

    const client = await connectShim({ MERLIN_MCP_SOCKET: fakeSocketPath });

    const before = await client.callTool({ name: "list_open_documents", arguments: {} });
    check("call before launch reports unavailable", before.isError === true, JSON.stringify(before).slice(0, 150));

    // Minimal fake "live server": newline-framed JSON-RPC answering initialize and tools/call.
    let seenClientName = null;
    const fakeServer = net.createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            let index;
            while ((index = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                if (!line) continue;
                const message = JSON.parse(line);
                if (message.method === "initialize") {
                    seenClientName = message.params?.clientInfo?.name;
                    socket.write(JSON.stringify({
                        jsonrpc: "2.0", id: message.id,
                        result: {
                            protocolVersion: message.params.protocolVersion,
                            capabilities: { tools: {} },
                            serverInfo: { name: "FakeLive", version: "1.2.3" },
                        },
                    }) + "\n");
                } else if (message.method === "tools/call") {
                    socket.write(JSON.stringify({
                        jsonrpc: "2.0", id: message.id,
                        result: { content: [{ type: "text", text: "fake-live-response" }] },
                    }) + "\n");
                }
                // notifications (initialized) need no reply
            }
        });
    });
    await new Promise((resolve) => fakeServer.listen(fakeSocketPath, resolve));

    const after = await client.callTool({ name: "list_open_documents", arguments: {} });
    check("call after launch succeeds without shim restart",
        !after.isError && after.content?.[0]?.text === "fake-live-response",
        JSON.stringify(after).slice(0, 150));
    check("live server sees the IDE's clientInfo", seenClientName === "ShimE2ETest",
        `saw ${JSON.stringify(seenClientName)}`);

    await client.close();
    fakeServer.close();
    await import("node:fs").then((fs) => fs.promises.rm(fakeSocketPath, { force: true }));
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
