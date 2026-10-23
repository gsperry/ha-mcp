/**
 * Smoke test for a running ha-mcp Worker (local `wrangler dev` or deployed).
 *
 * Inputs come from the environment only:
 *   SMOKE_URL            full MCP endpoint, for example https://host/mcp
 *   MCP_BEARER_TOKEN     the bearer token the Worker expects
 *   SMOKE_AUTOMATION_ID  optional; when set, also reads that automation
 *
 * Every step is read-only. Prints one PASS or FAIL line per step and exits
 * non-zero if any step fails. The token is never printed.
 */
import { TOOL_NAMES } from "../src/tool-names.ts";

const url = process.env.SMOKE_URL;
const token = process.env.MCP_BEARER_TOKEN;
const automationId = process.env.SMOKE_AUTOMATION_ID;

if (!url || !token) {
  console.error("FAIL setup: SMOKE_URL and MCP_BEARER_TOKEN must be set in the environment");
  process.exit(2);
}

let nextId = 1;
let failures = 0;
let halted = false;

type Json = Record<string, unknown>;
type Rpc = { result?: Json; error?: { code: number; message: string } };

/** Thrown for a 401, so the run can stop instead of repeating a rejected login. */
class Unauthorized extends Error {}

/** Sends one JSON-RPC request and returns the decoded response body. */
async function rpc(method: string, params: unknown): Promise<Rpc> {
  const response = await fetch(url as string, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (response.status === 401) throw new Unauthorized(`HTTP 401 Unauthorized: the bearer token was rejected`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
  }
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    if (!data) throw new Error("event stream response carried no data line");
    return JSON.parse(data.slice(5)) as Rpc;
  }
  return JSON.parse(text) as Rpc;
}

/** Runs one step; a thrown error or a false return counts as a failure. */
async function step(name: string, run: () => Promise<string>): Promise<void> {
  if (halted) {
    console.log(`SKIP ${name}: the bearer token was rejected`);
    return;
  }
  try {
    console.log(`PASS ${name}: ${await run()}`);
  } catch (error) {
    failures++;
    if (error instanceof Unauthorized) halted = true;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${name}: ${message.replaceAll(token as string, "[redacted]")}`);
  }
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null;
}

/** Calls a tool and returns its text; a protocol error or isError result throws. */
async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const body = await rpc("tools/call", { name, arguments: args });
  if (body.error) throw new Error(`JSON-RPC error ${body.error.code}: ${body.error.message}`);
  const content = body.result?.content;
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text = isRecord(first) && typeof first.text === "string" ? first.text : "";
  if (body.result?.isError === true) throw new Error(`tool reported an error: ${text.slice(0, 300)}`);
  return text;
}

await step("initialize", async () => {
  const body = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "ha-mcp-smoke", version: "0.0.0" },
  });
  if (body.error) throw new Error(`JSON-RPC error ${body.error.code}: ${body.error.message}`);
  const info = body.result?.serverInfo;
  if (!isRecord(info) || typeof info.name !== "string") throw new Error("response has no serverInfo");
  return `server ${info.name} ${String(info.version)}, protocol ${String(body.result?.protocolVersion)}`;
});

await step("tools/list", async () => {
  const body = await rpc("tools/list", {});
  if (body.error) throw new Error(`JSON-RPC error ${body.error.code}: ${body.error.message}`);
  const tools = body.result?.tools;
  if (!Array.isArray(tools)) throw new Error("response has no tools array");
  const names = tools.map((tool: unknown) => (isRecord(tool) ? String(tool.name) : ""));
  const missing = TOOL_NAMES.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !(TOOL_NAMES as readonly string[]).includes(name));
  if (missing.length || extra.length) {
    throw new Error(`missing [${missing.join(", ")}], unexpected [${extra.join(", ")}]`);
  }
  return `${names.length} tools`;
});

await step("list_entities automation", async () => {
  const text = await callTool("list_entities", { domain: "automation", limit: 5 });
  return `${text.length} characters returned`;
});

if (automationId) {
  await step("get_automation", async () => {
    const text = await callTool("get_automation", { id: automationId });
    return `${text.length} characters returned`;
  });
} else {
  console.log("SKIP get_automation: SMOKE_AUTOMATION_ID is not set");
}

console.log(failures === 0 ? "RESULT PASS" : `RESULT FAIL (${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
