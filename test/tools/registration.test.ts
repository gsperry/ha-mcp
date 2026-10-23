import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../../src/server";
import { installFetchSpy } from "../helpers/fetch";
import { listTools } from "../helpers/mcp";

installFetchSpy();

describe("tools/list", () => {
  it("lists exactly the registered tools, each with a description and an input schema", async () => {
    const tools = await listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const t of tools) {
      expect(t.description?.length ?? 0, t.name).toBeGreaterThan(40);
      expect(t.inputSchema.type, t.name).toBe("object");
    }
  });

  it("marks read tools read-only and call_service as not read-only", async () => {
    const byName = Object.fromEntries((await listTools()).map((t) => [t.name, t.annotations]));
    for (const name of ["list_entities", "get_entity", "list_services", "get_history", "search_registry", "list_automations", "get_automation", "check_config"]) {
      expect(byName[name]?.readOnlyHint, name).toBe(true);
    }
    expect(byName.call_service?.readOnlyHint).toBe(false);
    expect(byName.call_service?.destructiveHint).toBe(true);
    expect(byName.trigger_automation?.readOnlyHint).toBe(false);
    expect(byName.trigger_automation?.destructiveHint).toBe(true);
  });

  it("marks the dashboard read tools read-only and save_dashboard destructive", async () => {
    const byName = Object.fromEntries((await listTools()).map((t) => [t.name, t.annotations]));
    expect(byName.list_dashboards?.readOnlyHint).toBe(true);
    expect(byName.get_dashboard?.readOnlyHint).toBe(true);
    expect(byName.save_dashboard?.readOnlyHint).toBe(false);
    expect(byName.save_dashboard?.destructiveHint).toBe(true);
  });
});
