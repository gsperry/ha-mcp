import { env, SELF } from "cloudflare:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { describe, expect, it, vi } from "vitest";
import readme from "../README.md?raw";
import worker, { type Env } from "../src/index.js";
import { TOOL_NAMES } from "../src/server.js";
import { installFetchSpy } from "./helpers/fetch.js";
import { json } from "./helpers/mcp.js";

const spy = installFetchSpy();

const URL_MCP = "https://worker.test/mcp";
const AUTH = { Authorization: "Bearer test-bearer-token" };
const MCP_HEADERS = {
  ...AUTH,
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

function rpc(method: string, id: number | undefined, params: unknown = {}, headers: Record<string, string> = {}) {
  return SELF.fetch(URL_MCP, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }),
  });
}

const initParams = {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "test-client", version: "1.2.3" },
};

describe("routing and auth edge", () => {
  it("404 for other paths, without checking auth", async () => {
    for (const path of ["/", "/mcp/", "/other"]) {
      const res = await SELF.fetch(`https://worker.test${path}`, { method: "POST" });
      expect(res.status).toBe(404);
    }
  });

  it("405 with Allow: POST for non-POST methods, even without auth", async () => {
    for (const method of ["GET", "DELETE", "PUT", "OPTIONS"]) {
      const res = await SELF.fetch(URL_MCP, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
      expect(res.headers.get("WWW-Authenticate")).toBeNull();
    }
  });

  it("403 for a disallowed Origin, before the bearer check", async () => {
    for (const origin of [
      "https://evil.example",
      "http://claude.ai",
      "https://claude.ai.evil.example",
      "https://notclaude.ai",
      "https://claude.ai:8443",
      "null",
    ]) {
      const res = await SELF.fetch(URL_MCP, { method: "POST", headers: { Origin: origin } });
      expect(res.status, origin).toBe(403);
    }
  });

  it("accepts allowed Origins and an absent Origin", async () => {
    for (const origin of [
      "https://claude.ai",
      "https://www.claude.ai",
      "https://anthropic.com",
      "https://a.b.anthropic.com",
    ]) {
      const res = await rpc("tools/list", 1, {}, { Origin: origin });
      expect(res.status, origin).toBe(200);
    }
    expect((await rpc("tools/list", 1)).status).toBe(200);
  });

  // The test configuration has OAuth on, so the 401 of the last release (a bare `Bearer` challenge)
  // is what a deployment without the OAuth settings answers. The OAuth-on 401 is covered in test/oauth.
  const oauthOff = { ...(env as unknown as Env), SIGN_IN_LIMITER: undefined } as Env;

  it("401 with an empty body and WWW-Authenticate for a missing or wrong bearer", async () => {
    const bad: Record<string, string>[] = [
      {},
      { Authorization: "Bearer wrong" },
      { Authorization: "Bearer test-bearer-token-extra" },
      { Authorization: "Bearer " },
      { Authorization: "test-bearer-token" },
      { Authorization: "Basic test-bearer-token" },
    ];
    for (const headers of bad) {
      const res = await worker.fetch(new Request(URL_MCP, { method: "POST", headers }), oauthOff);
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
      expect(await res.text()).toBe("");
    }
  });
});

describe("MCP handling", () => {
  it("initialize then tools/list succeed and return plain JSON", async () => {
    const init = await rpc("initialize", 1, initParams);
    expect(init.status).toBe(200);
    expect(init.headers.get("Content-Type")).toContain("application/json");
    const initBody = (await init.json()) as { result: { capabilities: { tools?: unknown } } };
    expect(initBody.result.capabilities.tools).toBeDefined();

    const list = await rpc("tools/list", 2);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } };
    expect(body.result.tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    expect(body.result.tools[0]?.annotations?.readOnlyHint).toBe(true);
  });

  it("serves two sequential tools/list requests", async () => {
    for (let i = 1; i <= 2; i++) {
      const res = await rpc("tools/list", i);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: i, result: { tools: expect.any(Array) } });
    }
  });

  it("serves two concurrent tools/list requests", async () => {
    const results = await Promise.all([rpc("tools/list", 1), rpc("tools/list", 2)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const bodies = (await Promise.all(results.map((r) => r.json()))) as { id: number }[];
    expect(bodies.map((b) => b.id)).toEqual([1, 2]);
  });

  it("accepts Mcp-Protocol-Version 2025-11-25", async () => {
    const res = await rpc("tools/list", 1, {}, { "Mcp-Protocol-Version": "2025-11-25" });
    expect(res.status).toBe(200);
  });

  it("calls a tool", async () => {
    spy.respondOnce(json([{ entity_id: "light.kitchen", state: "on", attributes: {} }]));
    const res = await rpc("tools/call", 1, { name: "list_entities", arguments: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content[0]?.text).toContain("light.kitchen");
  });

  it("logs protocol and client info on initialize, never the token", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await rpc("initialize", 1, initParams, { "Mcp-Protocol-Version": "2025-11-25" });
      const lines = log.mock.calls.map((c) => String(c[0]));
      const line = lines.find((l) => l.includes('"initialize"'));
      expect(line).toBeDefined();
      expect(JSON.parse(line!)).toMatchObject({
        protocolVersionHeader: "2025-11-25",
        requestedProtocolVersion: "2025-11-25",
        clientName: "test-client",
        clientVersion: "1.2.3",
        auth: "static",
      });
      expect(lines.join("\n")).not.toContain("test-bearer-token");
    } finally {
      log.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The edge reads and parses the body once, refuses JSON-RPC batches, and gives the transport the parsed value.
// ---------------------------------------------------------------------------------------------

const BOM = "\uFEFF";
const BATCH_REFUSAL = { jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request: JSON-RPC batches are not supported" }, id: null };
const PARSE_ERROR = { jsonrpc: "2.0", error: { code: -32700, message: "Parse error: Invalid JSON" }, id: null };
const TOO_LARGE = { jsonrpc: "2.0", error: { code: -32000, message: "Payload Too Large: Request body must not exceed 4194304 bytes" }, id: null };

const listMessage = (id = 1) => ({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
const callMessage = (id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "delete_automation", arguments: { id: "a1", challenge: "dc1.1.x.y", code: "12345678" } },
});

function post(body: string, headers: Record<string, string> = MCP_HEADERS): Promise<Response> {
  return SELF.fetch(URL_MCP, { method: "POST", headers, body });
}

async function expectBody(res: Response, status: number, body: unknown): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get("Content-Type")).toContain("application/json");
  expect(await res.json()).toEqual(body);
}

describe("JSON-RPC batches are refused at the edge", () => {
  const arrays: [string, string][] = [
    ["an array of one", JSON.stringify([callMessage()])],
    ["an array of two", JSON.stringify([callMessage(1), callMessage(2)])],
    ["an empty array", "[]"],
    ["an array after white space and a line break", ` \n\t${JSON.stringify([callMessage()])}`],
    ["an array after one byte order mark", `${BOM}${JSON.stringify([callMessage()])}`],
    ["an array of non-messages", "[1, null, \"x\"]"],
  ];

  it.each(arrays)("%s with a valid bearer gets 400 and the batch refusal, builds no server and makes no Home Assistant request", async (_name, body) => {
    const connect = vi.spyOn(McpServer.prototype, "connect");
    const handle = vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, "handleRequest");
    try {
      await expectBody(await post(body), 400, BATCH_REFUSAL);
      expect(connect).not.toHaveBeenCalled();
      expect(handle).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
      handle.mockRestore();
    }
  });

  it("an array after two byte order marks is a parse error (still no batch), with no server", async () => {
    const connect = vi.spyOn(McpServer.prototype, "connect");
    try {
      await expectBody(await post(`${BOM}${BOM}${JSON.stringify([callMessage()])}`), 400, PARSE_ERROR);
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });

  it.each(arrays)("%s without a bearer gets the 401 and learns nothing about batches", async (_name, body) => {
    const oauthOff = { ...(env as unknown as Env), SIGN_IN_LIMITER: undefined } as Env;
    const res = await worker.fetch(
      new Request(URL_MCP, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body }),
      oauthOff,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await res.text()).toBe("");
  });

  it.each([
    ["a single message", JSON.stringify(listMessage())],
    ["a single message after one byte order mark", `${BOM}${JSON.stringify(listMessage())}`],
    ["a single message after white space", `  \n${JSON.stringify(listMessage())}`],
  ])("%s is still served", async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 1, result: { tools: expect.any(Array) } });
  });

  it("a single message after two byte order marks is a parse error, as it always was", async () => {
    await expectBody(await post(`${BOM}${BOM}${JSON.stringify(listMessage())}`), 400, PARSE_ERROR);
  });
});

describe("bad bodies are answered at the edge as the transport answers them", () => {
  it.each([
    ["malformed JSON", "{not json"],
    ["an empty body", ""],
    ["a lone byte order mark", BOM],
    ["a truncated message", '{"jsonrpc":"2.0","id":1,'],
  ])("%s gets 400 with -32700", async (_name, body) => {
    await expectBody(await post(body), 400, PARSE_ERROR);
  });

  it("a body over 4 MiB gets 413 with the transport's own body, by declared Content-Length and by size", async () => {
    const big = "x".repeat(4 * 1024 * 1024 + 1);
    await expectBody(await post(big), 413, TOO_LARGE);

    // Declared over the limit with a small body: refused without reading.
    const declared = await worker.fetch(
      new Request(URL_MCP, { method: "POST", headers: { ...MCP_HEADERS, "Content-Length": String(5 * 1024 * 1024) }, body: "{}" }),
      env as unknown as Env,
    );
    await expectBody(declared, 413, TOO_LARGE);

    // No declared length, more bytes than the limit arrive.
    const chunk = new Uint8Array(1024 * 1024).fill(120);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 5) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const streamed = await worker.fetch(
      new Request(URL_MCP, { method: "POST", headers: MCP_HEADERS, body: stream, duplex: "half" } as RequestInit),
      env as unknown as Env,
    );
    await expectBody(streamed, 413, TOO_LARGE);
  });

  it("a body that is exactly the limit is not refused as too large", async () => {
    const message = JSON.stringify(listMessage());
    const padded = `${message}${" ".repeat(4 * 1024 * 1024 - message.length)}`;
    expect(padded.length).toBe(4 * 1024 * 1024);
    expect((await post(padded)).status).toBe(200);
  });

  it("a body stream that fails while it is read gets 400 with -32700 and no uncaught exception", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("the connection broke");
      },
    });
    const res = await worker.fetch(
      new Request(URL_MCP, { method: "POST", headers: MCP_HEADERS, body: stream, duplex: "half" } as RequestInit),
      env as unknown as Env,
    );
    await expectBody(res, 400, PARSE_ERROR);
  });

  it("a wrong Accept with an unparseable or array body gets the edge's 400, not the transport's 406", async () => {
    const wrongAccept = { ...MCP_HEADERS, Accept: "text/plain" };
    await expectBody(await post("{nope", wrongAccept), 400, PARSE_ERROR);
    await expectBody(await post(JSON.stringify([listMessage()]), wrongAccept), 400, BATCH_REFUSAL);
  });

  it("a wrong Content-Type with an unparseable body gets 400, not 415", async () => {
    const wrongType = { ...MCP_HEADERS, "Content-Type": "text/plain" };
    await expectBody(await post("{nope", wrongType), 400, PARSE_ERROR);
  });

  it("a wrong Accept or Content-Type with a parseable single message still gets the transport's 406 or 415", async () => {
    const body = JSON.stringify(listMessage());
    const wrongAccept = await post(body, { ...MCP_HEADERS, Accept: "text/plain" });
    expect(wrongAccept.status).toBe(406);
    const wrongType = await post(body, { ...MCP_HEADERS, "Content-Type": "text/plain" });
    expect(wrongType.status).toBe(415);
  });

  it("the transport is given the parsed value and the edge has already consumed the body, which is read once", async () => {
    const handle = vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, "handleRequest");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const message = { jsonrpc: "2.0", id: 7, method: "initialize", params: initParams };
      const request = new Request(URL_MCP, { method: "POST", headers: { ...MCP_HEADERS, "Mcp-Protocol-Version": "2025-11-25" }, body: `${BOM}${JSON.stringify(message)}` });
      const res = await worker.fetch(request, env as unknown as Env);
      expect(res.status).toBe(200);
      expect(handle).toHaveBeenCalledTimes(1);
      const [given, options] = handle.mock.calls[0]!;
      expect(options).toEqual({ parsedBody: message });
      expect(given.bodyUsed).toBe(true);
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"initialize"'));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ requestedProtocolVersion: "2025-11-25", clientName: "test-client", clientVersion: "1.2.3" });
    } finally {
      handle.mockRestore();
      log.mockRestore();
    }
  });

  it("an initialize log line is never written for a refused body", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await post(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "initialize", params: initParams }]));
      await post("{nope");
      expect(log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"initialize"'))).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it("the README's troubleshooting row names the batch refusal", () => {
    const row = readme.split("\n").find((line) => line.startsWith('| 400 "JSON-RPC batches are not supported"'));
    expect(row).toBeDefined();
    expect(row).toContain(BATCH_REFUSAL.error.message.replace("Invalid Request: ", ""));
    expect(row).toMatch(/send one message per request/i);
  });
});
