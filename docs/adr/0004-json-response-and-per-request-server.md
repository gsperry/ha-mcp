# 0004. Plain JSON responses and a new server and transport per request

Date: 2026-10-22
Status: Accepted

## Context

The Worker serves the MCP streamable HTTP protocol with the web-standard transport, `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` 1.32.1. It keeps no session state: every request must stand alone, because a Worker isolate can be replaced at any time and concurrent requests share module scope.

Two facts about the SDK shape the design:

- A stateless transport (no `sessionIdGenerator`) throws on its second `handleRequest` ("Stateless transport cannot be reused across requests"), and `McpServer.connect` refuses a second transport once connected. The SDK's own JSDoc Workers example shares one transport and server across requests, which fails from the second request on. Hono's example in the SDK builds both per request.
- By default a POST is answered as a server-sent-event stream with keep-alive frames. With `enableJsonResponse: true` the transport waits for all responses and returns one `application/json` body.

The default JSON-schema validator (Ajv) is constructed with every `Server`, so per-request construction means per-request Ajv construction. Ajv generates code with `new Function`, which workerd can disallow when it is exercised.

## Options considered

1. One module-scope server and transport. Rejected: fails from the second request on, and concurrent requests would collide on JSON-RPC ids.
2. A module-scope server with a new transport per request. Rejected: `connect` throws when the server is already connected.
3. Stateful sessions (a session id per client, held in a Durable Object). Rejected: far more moving parts for tools that are plain request/response calls.
4. SSE-framed responses (the default). Rejected: nothing here streams; the keep-alive timer and event framing only complicate clients and tests.
5. Inject the SDK's `CfWorkerJsonSchemaValidator`. Not needed: see Consequences. It would add a runtime dependency.

## Decision

- `src/server.ts` exports `createServer(env)`, which returns a new `McpServer`. `src/index.ts` calls it for every request, connects a new transport created with `sessionIdGenerator: undefined` and `enableJsonResponse: true`, and returns `transport.handleRequest(request)`. Nothing MCP-related lives at module scope.
- `src/server.ts` also exports `TOOL_NAMES`, the list of registered tool names, so tests and scripts can compare against `tools/list`. The list is defined in `src/tool-names.ts`, which has no imports so that Node can load it directly (see 0013); `src/server.ts` re-exports it.
- The SDK installs the `tools/list` and `tools/call` handlers, and advertises the tools capability, only when the first tool is registered. A server with no tools answers `tools/list` with "method not found". Until real tools existed the server therefore registered one read-only placeholder, `server_info`, which returned the server name and version; it was removed once the real tools were registered.
- On `initialize` the Worker logs one JSON line with the `Mcp-Protocol-Version` header, the protocol version requested in the body and the client name and version. Nothing else from the request is logged.

## Consequences

- Each request pays for constructing a server, a transport and the validator. This is small compared with the Home Assistant call a tool makes.
- Responses are plain JSON, so any HTTP client can read them.
- Constructing the server (including Ajv) and serving `initialize`, `tools/list` and `tools/call` work in the local workerd test runtime and in the bundled Worker (`wrangler deploy --dry-run`). Ajv is never asked to compile a schema, because the Worker uses no elicitation. If a later feature does, the validator must be replaced by the Workers-safe one.
- The local test runtime is not production Workers; the first connection from a real client is the check that matters.
- A stateless server cannot remember a negotiated protocol version, so the `Mcp-Protocol-Version` header is validated by the SDK on every request: a version outside the SDK's supported list gets a 400.
- The SDK limits a request body to 4 MiB.
