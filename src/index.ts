import {
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  readRequestBody,
  requestBodyTooLargeMessage,
} from "@modelcontextprotocol/sdk/server/requestBody.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.js";

export interface Env {
  HA_URL: string;
  HA_TOKEN: string;
  MCP_BEARER_TOKEN: string;
  /** Only the exact text `true` turns the system-action block off. See the README, Safety policy. */
  ALLOW_SYSTEM_ACTIONS?: string;
  /** Comma-separated legacy notify services the model may call. See the README, Safety policy. */
  ALLOWED_NOTIFY_SERVICES?: string;
  /** The legacy notify service that delivers delete confirmation codes. See the README, Deleting an automation. */
  DELETE_CONFIRMATION_NOTIFY_SERVICE?: string;
}

const MCP_PATH = "/mcp";

// https://claude.ai, https://anthropic.com and any subdomain of either, with no
// port and no path.
const ALLOWED_ORIGIN = /^https:\/\/(?:[a-z0-9-]+\.)*(?:claude\.ai|anthropic\.com)$/;

export function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGIN.test(origin);
}

const encoder = new TextEncoder();

/**
 * Constant-time comparison of the presented and expected bearer tokens. Both
 * sides are hashed first so the compared buffers always have the same length;
 * the comparison then reveals nothing about the secret's length.
 */
export async function bearerMatches(header: string | null, expected: string): Promise<boolean> {
  const presented = header?.match(/^Bearer (.+)$/)?.[1] ?? "";
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const equal = crypto.subtle.timingSafeEqual(a, b);
  // An empty secret or a missing header never authenticates.
  return equal && presented.length > 0 && expected.length > 0;
}

/** Logs protocol version and client name/version for an initialize request. Never logs anything else. */
function logInitialize(request: Request, body: unknown): void {
  const m = body as { method?: unknown; params?: { protocolVersion?: unknown; clientInfo?: { name?: unknown; version?: unknown } } } | null;
  if (m?.method === "initialize") {
    console.log(
      JSON.stringify({
        event: "initialize",
        protocolVersionHeader: request.headers.get("Mcp-Protocol-Version"),
        requestedProtocolVersion: String(m.params?.protocolVersion ?? ""),
        clientName: String(m.params?.clientInfo?.name ?? ""),
        clientVersion: String(m.params?.clientInfo?.version ?? ""),
      }),
    );
  }
}

/** A JSON-RPC error answer in the shape the SDK transport uses for its own refusals. */
function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const parseError = (): Response => jsonRpcError(400, -32700, "Parse error: Invalid JSON");

/**
 * Reads and parses the request body once. Answers what the transport would answer for a body that is too large (413),
 * unreadable or not JSON (400, -32700), and refuses a JSON-RPC batch (400, -32600): a batch would carry many tool calls,
 * and so many code guesses, in one request. Returns the parsed message for the transport otherwise.
 */
async function readMessage(request: Request): Promise<{ parsed: unknown } | { response: Response }> {
  let text: string;
  try {
    const body = await readRequestBody(request);
    if (body.tooLarge) {
      return { response: jsonRpcError(413, -32000, requestBodyTooLargeMessage(DEFAULT_MAX_REQUEST_BODY_SIZE)) };
    }
    text = body.text;
  } catch {
    return { response: parseError() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { response: parseError() };
  }
  if (Array.isArray(parsed)) {
    return { response: jsonRpcError(400, -32600, "Invalid Request: JSON-RPC batches are not supported") };
  }
  return { parsed };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Check order: path, method, Origin, bearer. The method check precedes auth
    // so a GET never draws a 401, which would start the SDK client's auth flow.
    if (url.pathname !== MCP_PATH) {
      return new Response(null, { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }
    const origin = request.headers.get("Origin");
    if (origin !== null && !isAllowedOrigin(origin)) {
      return new Response(null, { status: 403 });
    }
    if (!(await bearerMatches(request.headers.get("Authorization"), env.MCP_BEARER_TOKEN))) {
      return new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    }

    // The body is read and parsed here, once; the transport is given the parsed value and reads nothing itself.
    const message = await readMessage(request);
    if ("response" in message) return message.response;
    logInitialize(request, message.parsed);

    const server = createServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request, { parsedBody: message.parsed });
  },
} satisfies ExportedHandler<Env>;
