import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./index.js";
import { registerAutomationTools } from "./tools/automations.js";
import { registerDashboardTools } from "./tools/dashboards.js";
import { registerEntityTools } from "./tools/entities.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerRegistryTools } from "./tools/registry.js";
import { registerServiceTools } from "./tools/services.js";

export { TOOL_NAMES } from "./tool-names.js";

/**
 * Builds a new MCP server. Called once per request: a server can be connected
 * to one transport only, and a stateless transport cannot serve a second
 * request, so neither may live at module scope.
 */
export function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "ha-mcp", version: "0.0.0" });
  registerEntityTools(server, env);
  registerServiceTools(server, env);
  registerHistoryTools(server, env);
  registerRegistryTools(server, env);
  registerAutomationTools(server, env);
  registerDashboardTools(server, env);
  return server;
}
