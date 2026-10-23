import { describe, expect, it } from "vitest";
import { installFetchSpy } from "../helpers/fetch";
import { callTool, json } from "../helpers/mcp";
import { queuePolicyWs } from "../helpers/policy-fake";

const spy = installFetchSpy();

const state = (entity_id: string, s: string, attributes: Record<string, unknown>) => ({ entity_id, state: s, attributes });

// The slug of the second entity differs from its alias, as it does after a rename in the UI.
const states = [
  state("light.kitchen", "on", { friendly_name: "Kitchen" }),
  state("automation.sunset_lights", "on", { id: "1700000000001", friendly_name: "Sunset lights", last_triggered: "2026-10-21T18:00:00+00:00" }),
  state("automation.zz_old_slug", "off", { id: "1700000000002", friendly_name: "Porch light at night", last_triggered: null }),
  state("automation.from_package", "on", { id: "pkg_garage", friendly_name: "Garage package" }),
  state("automation.yaml_no_id", "unavailable", { friendly_name: "Yaml without id" }),
];

/** Answers one request and records the JSON body it carried (a body can only be read inside the handler). */
function recordBody(reply: unknown, sink: { body?: unknown }) {
  return async (request: Request): Promise<Response> => {
    sink.body = await request.json();
    return Response.json(reply);
  };
}
const notFound = () => Response.json({ message: "Resource not found" }, { status: 404 });

/** A handler that upgrades to a fake HA WebSocket answering `automation/config`. */
function fakeWs(answer: (msg: Record<string, unknown>) => Record<string, unknown>, seen: Record<string, unknown>[] = []) {
  return () => {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    server.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data as string) as Record<string, unknown>;
      seen.push(msg);
      if (msg.type === "auth") server.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.10.2" }));
      else server.send(JSON.stringify({ id: msg.id, type: "result", ...answer(msg) }));
    });
    queueMicrotask(() => server.send(JSON.stringify({ type: "auth_required", ha_version: "2026.10.2" })));
    return new Response(null, { status: 101, webSocket: client });
  };
}

describe("list_automations", () => {
  it("lists only automations, mapping id, alias, enabled and last_triggered; null id for YAML without id", async () => {
    spy.respondOnce(json(states));
    const r = await callTool("list_automations");
    expect(r.isError).toBe(false);
    expect(r.json.total).toBe(4);
    expect(r.json.next_offset).toBeNull();
    expect(r.json.automations.map((a: any) => a.entity_id)).toEqual([
      "automation.from_package",
      "automation.sunset_lights",
      "automation.yaml_no_id",
      "automation.zz_old_slug",
    ]);
    const byEntity = Object.fromEntries(r.json.automations.map((a: any) => [a.entity_id, a]));
    expect(byEntity["automation.zz_old_slug"]).toEqual({
      id: "1700000000002",
      entity_id: "automation.zz_old_slug",
      alias: "Porch light at night",
      enabled: false,
      state: "off",
      last_triggered: null,
    });
    expect(byEntity["automation.sunset_lights"].last_triggered).toBe("2026-10-21T18:00:00+00:00");
    expect(byEntity["automation.yaml_no_id"]).toMatchObject({ id: null, enabled: false, state: "unavailable" });
  });

  it("searches alias and entity_id, case-insensitively", async () => {
    spy.respondOnce(json(states));
    const byAlias = await callTool("list_automations", { search: "PORCH" });
    expect(byAlias.json.automations.map((a: any) => a.entity_id)).toEqual(["automation.zz_old_slug"]);
    spy.respondOnce(json(states));
    const bySlug = await callTool("list_automations", { search: "sunset_" });
    expect(bySlug.json.automations.map((a: any) => a.entity_id)).toEqual(["automation.sunset_lights"]);
  });

  it("pages with limit and offset and reports total and next_offset", async () => {
    spy.respondOnce(json(states));
    const first = await callTool("list_automations", { limit: 3 });
    expect(first.json).toMatchObject({ total: 4, count: 3, offset: 0, next_offset: 3 });
    spy.respondOnce(json(states));
    const second = await callTool("list_automations", { limit: 3, offset: 3 });
    expect(second.json).toMatchObject({ total: 4, count: 1, offset: 3, next_offset: null });
    expect(second.json.automations[0].entity_id).toBe("automation.zz_old_slug");
  });

  it("reports next_offset null when the page ends exactly at the total", async () => {
    spy.respondOnce(json(states));
    const r = await callTool("list_automations", { limit: 2, offset: 2 });
    expect(r.json).toMatchObject({ total: 4, count: 2, offset: 2, next_offset: null });
  });

  it("turns a missing last_triggered into an explicit null", async () => {
    spy.respondOnce(json(states));
    const r = await callTool("list_automations", { search: "garage" });
    expect(r.json.automations[0]).toHaveProperty("last_triggered", null);
  });

  it("rejects a limit above the maximum", async () => {
    const r = await callTool("list_automations", { limit: 501 });
    expect(r.isError).toBe(true);
    expect(spy.requests).toHaveLength(0);
  });

  it("surfaces Home Assistant's message on an error", async () => {
    spy.respondOnce(() => Response.json({ message: "Unauthorized" }, { status: 401 }));
    const r = await callTool("list_automations");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("HTTP 401");
    expect(r.text).toContain("Unauthorized");
    expect(spy.requests).toHaveLength(1);
  });
});

describe("get_automation", () => {
  const config = { alias: "Porch light at night", triggers: [{ trigger: "sun" }], actions: [], variables: { x: 1 }, future_key: true };

  it("reads by id through the REST config endpoint without touching states", async () => {
    spy.respondOnce(json(config));
    const r = await callTool("get_automation", { id: "1700000000002" });
    expect(r.isError).toBe(false);
    expect(r.json).toEqual({ id: "1700000000002", entity_id: null, config, editable: true });
    expect(spy.requests.map((q) => new URL(q.url).pathname)).toEqual(["/api/config/automation/config/1700000000002"]);
  });

  it("encodes an id that is not path-safe", async () => {
    spy.respondOnce(json(config));
    await callTool("get_automation", { id: "a/b c" });
    expect(new URL(spy.requests[0]!.url).pathname).toBe("/api/config/automation/config/a%2Fb%20c");
  });

  it("resolves an entity_id to its id attribute, not to its slug", async () => {
    spy.respondOnce(json(states[2]));
    spy.respondOnce(json(config));
    const r = await callTool("get_automation", { entity_id: "automation.zz_old_slug" });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ id: "1700000000002", entity_id: "automation.zz_old_slug", editable: true });
    expect(spy.requests.map((q) => new URL(q.url).pathname)).toEqual([
      "/api/states/automation.zz_old_slug",
      "/api/config/automation/config/1700000000002",
    ]);
  });

  it("falls back to the WebSocket and marks editable false when the config endpoint answers 404", async () => {
    const seen: Record<string, unknown>[] = [];
    spy.respondOnce(json(states[3]));
    spy.respondOnce(notFound);
    spy.respondOnce(fakeWs(() => ({ success: true, result: { config } }), seen));
    const r = await callTool("get_automation", { entity_id: "automation.from_package" });
    expect(r.isError).toBe(false);
    expect(r.json).toEqual({ id: "pkg_garage", entity_id: "automation.from_package", config, editable: false });
    expect(seen.find((m) => m.type === "automation/config")).toMatchObject({ entity_id: "automation.from_package" });
  });

  it("goes straight to the WebSocket for an entity with no id attribute", async () => {
    spy.respondOnce(json(states[4]));
    spy.respondOnce(fakeWs(() => ({ success: true, result: { config } })));
    const r = await callTool("get_automation", { entity_id: "automation.yaml_no_id" });
    expect(r.json).toMatchObject({ id: null, editable: false, config });
    expect(spy.requests.map((q) => new URL(q.url).pathname)).toEqual(["/api/states/automation.yaml_no_id", "/api/websocket"]);
  });

  it("resolves an id that only a package defines through the states list, then the WebSocket", async () => {
    spy.respondOnce(notFound);
    spy.respondOnce(json(states));
    spy.respondOnce(fakeWs(() => ({ success: true, result: { config } })));
    const r = await callTool("get_automation", { id: "pkg_garage" });
    expect(r.json).toMatchObject({ id: "pkg_garage", entity_id: "automation.from_package", editable: false });
  });

  it("reports an unknown id that no loaded automation uses, without opening a WebSocket", async () => {
    spy.respondOnce(notFound);
    spy.respondOnce(json(states));
    const r = await callTool("get_automation", { id: "nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("nope");
    expect(spy.requests).toHaveLength(2);
  });

  it("surfaces a WebSocket failure in the fallback with HA's code", async () => {
    spy.respondOnce(json(states[3]));
    spy.respondOnce(notFound);
    spy.respondOnce(fakeWs(() => ({ success: false, error: { code: "unauthorized", message: "Unauthorized" } })));
    const r = await callTool("get_automation", { entity_id: "automation.from_package" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("unauthorized");
    expect(r.text).toContain("WebSocket");
  });

  it("reports a network error thrown by the fallback's upgrade request as a failed WebSocket read", async () => {
    spy.respondOnce(json(states[3]));
    spy.respondOnce(notFound);
    spy.respondOnce(() => {
      throw new TypeError("upgrade refused");
    });
    const r = await callTool("get_automation", { entity_id: "automation.from_package" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("automation.from_package");
    expect(r.text).toContain("reading its config over the WebSocket failed");
    expect(r.text).toContain("upgrade refused");
  });

  it("does not fall back on a 401 and does not retry", async () => {
    spy.respondOnce(() => Response.json({ message: "Unauthorized" }, { status: 401 }));
    const r = await callTool("get_automation", { id: "1" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("HTTP 401");
    expect(spy.requests).toHaveLength(1);
  });

  it("reports an entity that does not exist (HA's 404 on the state)", async () => {
    spy.respondOnce(() => Response.json({ message: "Entity not found." }, { status: 404 }));
    const r = await callTool("get_automation", { entity_id: "automation.ghost" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Entity not found.");
    expect(spy.requests).toHaveLength(1);
  });

  it("requires exactly one of id and entity_id", async () => {
    expect((await callTool("get_automation", {})).isError).toBe(true);
    expect((await callTool("get_automation", { id: "1", entity_id: "automation.x" })).isError).toBe(true);
    expect((await callTool("get_automation", { entity_id: "light.kitchen" })).isError).toBe(true);
    expect(spy.requests).toHaveLength(0);
  });
});

describe("trigger_automation", () => {
  const stateRead = (s: string, attributes: Record<string, unknown> = {}) => json({ entity_id: "automation.x", state: s, attributes });
  /** The safety policy reads the automation's config over the WebSocket before the trigger is sent. */
  const policyWs = (entity: string) =>
    queuePolicyWs(spy, {
      platforms: { [entity]: "automation" },
      automations: { [entity]: { alias: "x", triggers: [], actions: [{ action: "persistent_notification.create", data: { message: "hi" } }] } },
    });

  it("sends skip_condition false explicitly when the caller omits it, and reports last_triggered before and after", async () => {
    const sent: { body?: unknown } = {};
    spy.respondOnce(stateRead("on", { last_triggered: "2026-10-21T18:00:00+00:00" }));
    policyWs("automation.zz_old_slug");
    spy.respondOnce(recordBody([], sent));
    spy.respondOnce(stateRead("on", { last_triggered: "2026-10-22T09:00:00+00:00" }));
    const r = await callTool("trigger_automation", { entity_id: "automation.zz_old_slug" });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      entity_id: "automation.zz_old_slug",
      skip_condition: false,
      state_before: "on",
      last_triggered_before: "2026-10-21T18:00:00+00:00",
      last_triggered_after: "2026-10-22T09:00:00+00:00",
    });
    expect(r.json).not.toHaveProperty("changed_states");
    const note = (r.json as { note?: unknown }).note;
    expect(typeof note).toBe("string");
    expect(note).toContain("the run did not start");
    expect(note).toContain("the conditions were not met");
    expect(note).toMatch(/\.$/);
    expect(spy.requests.map((q) => `${q.method} ${new URL(q.url).pathname}`)).toEqual([
      "GET /api/states/automation.zz_old_slug",
      "GET /api/websocket",
      "POST /api/services/automation/trigger",
      "GET /api/states/automation.zz_old_slug",
    ]);
    expect(sent.body).toEqual({ entity_id: "automation.zz_old_slug", skip_condition: false });
  });

  it("sends skip_condition true and variables unchanged when asked; a never-run automation reports null", async () => {
    const sent: { body?: unknown } = {};
    spy.respondOnce(stateRead("off"));
    policyWs("automation.sunset_lights");
    spy.respondOnce(recordBody([], sent));
    spy.respondOnce(stateRead("off"));
    const variables = { who: "guy", nested: { n: [1, 2], future: null } };
    const r = await callTool("trigger_automation", { entity_id: "automation.sunset_lights", skip_condition: true, variables });
    expect(r.isError).toBe(false);
    expect(sent.body).toEqual({ entity_id: "automation.sunset_lights", skip_condition: true, variables });
    expect(r.json).toMatchObject({ state_before: "off", last_triggered_before: null, last_triggered_after: null });
  });

  it("refuses an entity Home Assistant does not know, without sending the trigger", async () => {
    // HA would answer 200 to the service call and silently drop the missing entity.
    spy.respondOnce(() => Response.json({ message: "Entity not found." }, { status: 404 }));
    const r = await callTool("trigger_automation", { entity_id: "automation.ghost" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No automation automation.ghost");
    expect(r.text).toContain("Entity not found.");
    expect(spy.requests.map((q) => q.method)).toEqual(["GET"]);
  });

  it("refuses an unavailable automation, without sending the trigger", async () => {
    spy.respondOnce(stateRead("unavailable"));
    const r = await callTool("trigger_automation", { entity_id: "automation.yaml_no_id" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("unavailable");
    expect(spy.requests.map((q) => q.method)).toEqual(["GET"]);
  });

  it("fails closed on a 401 from the state read, without retrying or sending the trigger", async () => {
    spy.respondOnce(() => Response.json({ message: "Unauthorized" }, { status: 401 }));
    const r = await callTool("trigger_automation", { entity_id: "automation.sunset_lights" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("HTTP 401");
    expect(spy.requests).toHaveLength(1);
  });

  it("surfaces Home Assistant's message when the trigger call itself fails", async () => {
    spy.respondOnce(stateRead("on"));
    policyWs("automation.sunset_lights");
    spy.respondOnce(() => Response.json({ message: "Service not found" }, { status: 400 }));
    const r = await callTool("trigger_automation", { entity_id: "automation.sunset_lights" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Service not found");
  });

  it("still reports the trigger as sent when the read-back fails", async () => {
    spy.respondOnce(stateRead("on"));
    policyWs("automation.sunset_lights");
    spy.respondOnce(json([]));
    spy.respondOnce(() => Response.json({ message: "boom" }, { status: 500 }));
    const r = await callTool("trigger_automation", { entity_id: "automation.sunset_lights" });
    expect(r.isError).toBe(false);
    expect(r.json.last_triggered_after).toBeNull();
    expect(r.json.note).toContain("could not be read back");
  });

  it("refuses a non-automation entity and a malformed id before calling Home Assistant", async () => {
    expect((await callTool("trigger_automation", { entity_id: "light.kitchen" })).isError).toBe(true);
    expect((await callTool("trigger_automation", { entity_id: "Automation.X/../y" })).isError).toBe(true);
    expect(spy.requests).toHaveLength(0);
  });

  it("says the automation may still have run when the trigger connection fails", async () => {
    spy.respondOnce(stateRead("on"));
    policyWs("automation.sunset_lights");
    spy.respondOnce(() => {
      throw new Error("connection reset");
    });
    const r = await callTool("trigger_automation", { entity_id: "automation.sunset_lights" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("may still have run");
  });
});

describe("check_config", () => {
  it("returns result, errors and warnings", async () => {
    spy.respondOnce(json({ result: "invalid", errors: "Integration error: x", warnings: null }));
    const r = await callTool("check_config");
    expect(r.isError).toBe(false);
    expect(r.json).toEqual({ result: "invalid", errors: "Integration error: x", warnings: null });
    expect(spy.requests[0]!.method).toBe("POST");
    expect(new URL(spy.requests[0]!.url).pathname).toBe("/api/config/core/check_config");
  });

  it("fails closed on a 401 with the likely cause, without retrying", async () => {
    spy.respondOnce(() => Response.json({ message: "Unauthorized" }, { status: 401 }));
    const r = await callTool("check_config");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("HTTP 401");
    expect(r.text).toContain("administrator");
    expect(spy.requests).toHaveLength(1);
  });
});
