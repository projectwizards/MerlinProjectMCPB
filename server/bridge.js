//
//  bridge.js
//  MerlinProjectMCPB
//
//  Node.js port of MerlinMCPShim/ShimBridge.swift — keep the two in sync.
//
//  Bridges the IDE-facing MCP `Server` (running on the shim's stdio) to the live MerlinProject
//  MCP server (running inside the host app and reachable via a Unix domain socket in the
//  shared App Group container).
//
//  Wire shape:
//
//      IDE  ⇄  stdio  ⇄  shim Server  ⇄  shim Client (cached)  ⇄  UDS  ⇄  live Server
//
//  - `tools/list` and `resources/list` are answered locally from the bundled catalog snapshot
//    (see catalog.json / generate-catalog.js) so the IDE always sees the same metadata
//    regardless of whether MerlinProject is up.
//
//  - `tools/call` and `resources/read` are forwarded to the live server through a lazily
//    connected SDK `Client`. If the connect fails (host app down, crashed, still binding), the
//    shim returns a structured "Merlin Project is not running" error to the agent and clears
//    its cached state, so the next call will retry the connect cleanly. The moment the user
//    launches MerlinProject the bridge picks up on the next call without any MCP-client
//    restart.
//
//  At process startup `index.js` runs `probeLiveServer()` once: if it succeeds, the shim
//  advertises the live server's real `serverInfo.name` / `serverInfo.version` to the IDE in
//  the `initialize` reply; if it fails, the shim falls back to a stub identity (`MerlinProject
//  / 0.0.0-stub`). After that the cached client connection is reused across every CallTool /
//  ReadResource for the rest of the session.

import * as net from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

/// User-facing error string returned to the agent whenever the live server isn't reachable.
/// Phrased as an actionable instruction so chat agents (Cursor, Claude, …) can surface it
/// verbatim to the user without rewording. Must match ShimBridge.unavailableMessage in Swift.
export const unavailableMessage =
    "Merlin Project is not currently running on this Mac. Please ask the user to launch the " +
    "Merlin Project app, then retry the request — the MCP shim will detect the launch and " +
    "connect to the running app on its own; no MCP-client restart is needed.";

/// Forwarded tool calls carry a generous timeout instead of the SDK's 60 s default: the live
/// server answers in-process queries quickly, but large `get_media` transfers shouldn't be
/// killed mid-flight. Progress notifications (if the live server ever sends them) reset it.
const forwardTimeoutMilliseconds = 300_000;

/// The UDS `initialize` handshake gets a short timeout instead of the SDK's 60 s default. A
/// healthy live server answers instantly; the only way the handshake can stall is a bound
/// socket whose owner never services it — e.g. MerlinProject blocked in a modal dialog at
/// launch (its MCP server dispatches on the main actor). Failing fast keeps the startup probe
/// from delaying the shim's own `initialize` reply to the IDE, and turns stalled forwards into
/// the actionable "not running" message instead of a long hang.
const handshakeTimeoutMilliseconds = 10_000;

// MARK: - ShimBridge

/// Bridges the shim's stdio-facing SDK Server to the live MerlinProject server over a UDS.
export class ShimBridge {
    #socketPath;

    /// Promise for the cached client connection; non-null when the live server is currently
    /// reachable (or a connect is in flight). Concurrent forwarders await the same promise, so
    /// connects are serialized exactly like the Swift actor serializes `ensureClient()`.
    /// Cleared by `#invalidateConnection()` whenever any forwarding call fails so the next
    /// request retries the connect from scratch.
    #clientPromise = null;

    /// The resolved client behind `#clientPromise`, kept so the `onclose` handler can tell
    /// whether the connection that just died is still the cached one.
    #currentClient = null;

    /// `serverInfo` reported by the live server during the most recent successful initialize.
    /// Only used by `probeLiveServer()` at startup; once the SDK Server is constructed with this
    /// identity it doesn't change for the rest of the session.
    #liveInfo = null;

    /// `clientInfo` that the IDE sent in *its* `initialize` request to the shim's stdio Server.
    /// Captured by `recordForwardedClientInfo()` from the Server's `oninitialized` hook and
    /// reused when the shim's UDS Client handshakes against the live host-app server, so the
    /// host sees the real agent identity (`Cursor`, `Claude`, …) rather than the shim's own name.
    ///
    /// `null` until the IDE's initialize arrives. Only the probe-time UDS connect (which runs
    /// before the IDE has spoken to us) falls back to the shim's own name; that connection is
    /// invalidated immediately after the probe so it never participates in tool-forwarding.
    #forwardedClientInfo = null;

    constructor(socketPath) {
        this.#socketPath = socketPath;
    }

    // MARK: - Public API used by index.js

    /// Tries to connect to the live server. Returns its `serverInfo` (`{name, version}`) on
    /// success; returns `null` on failure (host app not up). Used once at startup so the shim's
    /// own SDK `Server` can advertise the live server's real identity to the IDE.
    ///
    /// The probe runs *before* the IDE has sent its own `initialize` to the shim, so we don't
    /// yet know the IDE's `clientInfo` and the throwaway UDS connection has to handshake under
    /// the shim's own name. To stop that misnamed session from sticking around, we invalidate
    /// the cached client right after capturing the live `serverInfo`. The first real
    /// `tools/call` will then reconnect — by which time `recordForwardedClientInfo()` has run
    /// and the new UDS handshake carries the IDE's actual name (Cursor, Claude, …).
    async probeLiveServer() {
        try {
            await this.#ensureClient();
            const info = this.#liveInfo;
            await this.#invalidateConnection();
            return info;
        } catch {
            return null;
        }
    }

    /// Records the `clientInfo` the IDE advertised in its own `initialize` request to the shim's
    /// stdio Server. Wired in from `index.js` via the SDK Server's `oninitialized` hook. The next
    /// `#ensureClient()` call uses this info when handshaking against the live server, so the
    /// host app records the agent's real name in `MCPSession.clientName` (and thus in the
    /// toolbar popover's connected-tools list).
    recordForwardedClientInfo(info) {
        this.#forwardedClientInfo = info ?? null;
    }

    /// Forwards a `tools/call` to the live server. Returns a structured "Merlin not running"
    /// CallTool result (with `isError: true`) when the live server isn't reachable, so the SDK
    /// Server replies to the IDE with a normal CallTool result rather than a JSON-RPC error.
    /// The agent gets actionable text it can show to the user.
    async forwardCallTool(params) {
        try {
            const client = await this.#ensureClient();
            return await client.callTool(
                {
                    name: params.name,
                    arguments: params.arguments,
                    _meta: params._meta,
                },
                undefined,
                { timeout: forwardTimeoutMilliseconds, resetTimeoutOnProgress: true }
            );
        } catch {
            // Either we couldn't connect, or an in-flight call failed (e.g. live server quit
            // while we were holding a cached connection). Clear the cached client so the next
            // call retries the connect cleanly.
            await this.#invalidateConnection();
            return unavailableResult();
        }
    }

    /// Forwards a `resources/read` to the live server. Throws an MCP error when the live server
    /// isn't reachable, so the SDK Server surfaces a JSON-RPC error to the IDE — the schema
    /// XSDs live inside the host app's MerlinKit bundle, not in this shim, so we have nothing
    /// useful to serve locally.
    async forwardReadResource(params) {
        try {
            const client = await this.#ensureClient();
            return await client.readResource(
                { uri: params.uri },
                { timeout: forwardTimeoutMilliseconds, resetTimeoutOnProgress: true }
            );
        } catch {
            await this.#invalidateConnection();
            throw new McpError(ErrorCode.InvalidRequest, unavailableMessage);
        }
    }

    // MARK: - Connection management

    /// Returns the cached client if any, otherwise opens a fresh UDS connection, performs the
    /// MCP `initialize` handshake against the live server, caches the resulting `Client`, and
    /// returns it. Throws if any step fails; the caller maps that to the user-facing
    /// unavailability message.
    ///
    /// Memoized on `#clientPromise`, so concurrent callers await the same in-flight connect:
    /// the second caller sees the connection the first caller just installed and skips straight
    /// to a hit — the JS analogue of the Swift actor serializing `ensureClient()`.
    async #ensureClient() {
        if (this.#clientPromise === null) {
            this.#clientPromise = this.#connect();
            this.#clientPromise.catch(() => {
                // A failed connect must not stay cached, or every later call would rethrow the
                // same stale error instead of retrying. (`#invalidateConnection()` in the
                // forwarders also clears it, but the probe path relies on this too.)
                this.#clientPromise = null;
            });
        }
        return await this.#clientPromise;
    }

    async #connect() {
        // 1.+2. UDS connect with MCP newline-framing. A successful connect implies the host app
        //    is up *and* its `MCPSocketServer` has bound the socket — we don't need a separate
        //    process check. Typical failure modes (`ENOENT` on a missing socket file,
        //    `ECONNREFUSED` on a stale one left after a crash) just throw and we surface
        //    unavailability.
        const transport = new UnixSocketClientTransport(this.#socketPath);

        // 3. Connect the SDK `Client` over the framed socket. The `connect` call performs the
        //    MCP `initialize` handshake automatically and exposes the live server's real
        //    `serverInfo` via `getServerVersion()`.
        //
        //    The Client's name/version come from the IDE's own `initialize` whenever it has
        //    arrived (the common case for any real forward), so the host's `MCPSession`
        //    records `clientName == "Cursor" / "Claude" / …` rather than `"MerlinMCPShim"`.
        //    The fallback only triggers during `probeLiveServer()` at startup, before the IDE
        //    has spoken to us — and that connection is discarded by the probe immediately.
        const clientInfo = this.#forwardedClientInfo ?? {
            name: "MerlinMCPShim",
            version: "0.0.0",
        };
        const client = new Client({
            name: clientInfo.name,
            version: clientInfo.version ?? "0.0.0",
        });

        try {
            await client.connect(transport, { timeout: handshakeTimeoutMilliseconds });
        } catch (error) {
            await transport.close().catch(() => {});
            throw error;
        }

        // Unlike the Swift channel, the SDK surfaces the live side going away as an `onclose`
        // callback. Drop the cached client eagerly so a call arriving after MerlinProject quit
        // and relaunched reconnects immediately instead of failing once on the dead socket.
        client.onclose = () => {
            if (this.#currentClient === client) {
                this.#clientPromise = null;
                this.#currentClient = null;
            }
        };

        // 4. Cache and hand back. Subsequent forwarders will reuse this client until something
        //    on the live side fails, at which point `#invalidateConnection()` wipes the cache.
        this.#currentClient = client;
        const serverInfo = client.getServerVersion();
        this.#liveInfo = serverInfo
            ? { name: serverInfo.name, version: serverInfo.version }
            : null;
        return client;
    }

    /// Tears down the cached client (if any) so the next forwarder call retries the connect
    /// from scratch. Called whenever a forward call fails for any reason — we'd rather pay one
    /// extra `connect()` round-trip on the next call than risk reusing a half-broken client.
    async #invalidateConnection() {
        const promise = this.#clientPromise;
        this.#clientPromise = null;
        this.#currentClient = null;
        this.#liveInfo = null;
        if (promise !== null) {
            try {
                const client = await promise;
                await client.close();
            } catch {
                // The connection was already broken; there is nothing left to close.
            }
        }
    }
}

// MARK: - Replies

function unavailableResult() {
    return {
        content: [{ type: "text", text: unavailableMessage }],
        isError: true,
    };
}

// MARK: - net.Socket ↔ MCP Transport adapter

/// MCP `Transport` wrapping a `net.Socket` connected to a Unix domain socket. Mirrors the
/// Swift `NIOSocketTransport` used on both ends of the shim ⇄ host-app connection: newline-
/// delimited JSON framing, one JSON-RPC message per line.
///
/// - `send()` appends a newline delimiter and writes the framed message to the socket.
/// - Incoming bytes are accumulated in a buffer; every complete `\n`-terminated line is parsed
///   and handed to `onmessage`, which the SDK `Client` consumes directly.
///
/// Exported for scripts/generate-catalog.js, which talks to the same socket.
export class UnixSocketClientTransport {
    onclose;
    onerror;
    onmessage;

    #socketPath;
    #socket = null;
    #buffer = Buffer.alloc(0);

    constructor(socketPath) {
        this.#socketPath = socketPath;
    }

    start() {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection(this.#socketPath);
            this.#socket = socket;

            socket.once("connect", () => {
                // Reject only pre-connect errors; afterwards route errors to `onerror` and let
                // the `close` event (which always follows) tear the transport down.
                socket.removeListener("error", reject);
                socket.on("error", (error) => this.onerror?.(error));
                resolve();
            });
            socket.once("error", reject);

            socket.on("data", (chunk) => this.#didReceive(chunk));
            socket.on("close", () => this.onclose?.());
        });
    }

    /// Splits the accumulated byte stream on newline boundaries and yields every complete
    /// JSON-RPC message. The Swift peer writes exactly one JSON object per line, so a parse
    /// failure means the framing is corrupt — surfaced via `onerror`, never thrown.
    #didReceive(chunk) {
        this.#buffer = Buffer.concat([this.#buffer, chunk]);

        let newlineIndex;
        while ((newlineIndex = this.#buffer.indexOf(0x0a)) !== -1) {
            const line = this.#buffer.subarray(0, newlineIndex);
            this.#buffer = this.#buffer.subarray(newlineIndex + 1);
            if (line.length === 0) {
                continue;
            }
            let message;
            try {
                message = JSON.parse(line.toString("utf8"));
            } catch (error) {
                this.onerror?.(error);
                continue;
            }
            this.onmessage?.(message);
        }
    }

    send(message) {
        return new Promise((resolve, reject) => {
            if (this.#socket === null || this.#socket.destroyed) {
                reject(new Error("Socket is not connected."));
                return;
            }
            this.#socket.write(JSON.stringify(message) + "\n", (error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    async close() {
        this.#socket?.destroy();
        this.#socket = null;
    }
}
