import { SELF, env as bindings } from "cloudflare:test";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env } from "../../src/index";
import { createServer } from "../../src/server";

const HEADERS = {
  Authorization: "Bearer test-bearer-token",
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

export interface ToolReply {
  isError: boolean;
  text: string;
  /** The text parsed as JSON; undefined when it is not JSON (an error message). */
  json: any;
}

/** Calls a tool through the full request path: edge, transport, SDK, handler. */
export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
  const res = await SELF.fetch("https://worker.test/mcp", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (res.status !== 200) throw new Error(`tools/call answered HTTP ${res.status}`);
  const body = (await res.json()) as { result: { isError?: boolean; content: { type: string; text: string }[] } };
  const text = body.result.content[0]?.text ?? "";
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: body.result.isError === true, text, json };
}

/** Lists the tools through the full request path. */
export async function listTools(): Promise<{ name: string; description?: string; annotations?: Record<string, unknown>; inputSchema: any }[]> {
  const res = await SELF.fetch("https://worker.test/mcp", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  return ((await res.json()) as { result: { tools: any[] } }).result.tools;
}

/**
 * A fetch handler that builds its Response when the Worker asks for it. A
 * Response made in the test's own context cannot be read from inside the
 * Worker's request handler, so queue this, not a ready-made Response.
 */
export const json = (body: unknown, init?: ResponseInit) => (): Response => Response.json(body, init);

/**
 * Calls a tool on a server built from the given settings, through the transport and the SDK, as the Worker does
 * for each request. The shared bindings are the base, so a test names only the settings it changes.
 */
export async function callToolWithEnv(settings: Partial<Env>, name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
  const server = createServer({ ...(bindings as unknown as Env), ...settings });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const res = await transport.handleRequest(
    new Request("https://worker.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const body = (await res.json()) as { result: { isError?: boolean; content: { type: string; text: string }[] } };
  const text = body.result.content[0]?.text ?? "";
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: body.result.isError === true, text, json };
}
