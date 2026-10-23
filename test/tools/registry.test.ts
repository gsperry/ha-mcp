import { describe, expect, it } from "vitest";
import { installFetchSpy } from "../helpers/fetch";
import { callTool } from "../helpers/mcp";

type Msg = Record<string, unknown>;

const spy = installFetchSpy();

const ENTITIES = [
  { entity_id: "light.kitchen_ceiling", name: null, original_name: "Ceiling", platform: "hue", device_id: "dev_kitchen", area_id: null, disabled_by: null },
  { entity_id: "light.desk", name: "Desk Lamp", original_name: "Lamp", platform: "hue", device_id: "dev_study", area_id: "kitchen", disabled_by: null },
  { entity_id: "sensor.garage_temp", name: null, original_name: "Temperature", platform: "zha", device_id: "dev_garage", area_id: null, disabled_by: null },
  { entity_id: "sensor.orphan", name: null, original_name: null, platform: "template", device_id: null, area_id: null, disabled_by: null },
  { entity_id: "switch.old_plug", name: "Old Plug", original_name: null, platform: "tplink", device_id: "dev_garage", area_id: null, disabled_by: "user" },
];
const DEVICES = [
  { id: "dev_kitchen", name: "Hue Bulb 1", name_by_user: null, area_id: "kitchen" },
  { id: "dev_study", name: "Hue Bulb 2", name_by_user: "Study Bulb", area_id: "study" },
  { id: "dev_garage", name: "Zigbee Thing", name_by_user: null, area_id: "garage" },
];
const AREAS = [
  { area_id: "kitchen", name: "Kitchen" },
  { area_id: "study", name: "Study" },
  { area_id: "garage", name: "Garage" },
  { area_id: "living_room_2", name: "Lounge" },
];

interface Fake {
  received: Msg[];
}

/** Queues a fake HA WebSocket. `answer` returns the reply for each command. */
function fakeHa(answer: (msg: Msg) => Msg): Fake {
  const state: Fake = { received: [] };
  spy.respondOnce(() => {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    const send = (m: Msg) => server.send(JSON.stringify(m));
    server.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data as string) as Msg;
      state.received.push(msg);
      send(msg["type"] === "auth" ? { type: "auth_ok", ha_version: "2026.10.2" } : answer(msg));
    });
    queueMicrotask(() => send({ type: "auth_required", ha_version: "2026.10.2" }));
    return new Response(null, { status: 101, webSocket: client });
  });
  return state;
}

function registries(entities: unknown[] = ENTITIES): Fake {
  const lists: Record<string, unknown> = {
    "config/entity_registry/list": entities,
    "config/device_registry/list": DEVICES,
    "config/area_registry/list": AREAS,
  };
  return fakeHa((m) => ({ id: m["id"], type: "result", success: true, result: lists[m["type"] as string] }));
}

const ids = (r: { json: any }): string[] => r.json.entities.map((e: any) => e.entity_id);

describe("search_registry", () => {
  it("fetches the three registry lists over one connection and joins device and area names", async () => {
    const ha = registries();
    const r = await callTool("search_registry");
    expect(r.isError).toBe(false);
    expect(spy.requests).toHaveLength(1);
    expect(ha.received.filter((m) => m["type"] !== "auth").map((m) => m["type"])).toEqual([
      "config/entity_registry/list",
      "config/device_registry/list",
      "config/area_registry/list",
    ]);
    expect(r.json.total).toBe(4);
    expect(r.json.count).toBe(4);
    expect(r.json.truncated).toBe(false);
    expect(r.json.entities).toEqual([
      { entity_id: "light.desk", name: "Desk Lamp", platform: "hue", device_id: "dev_study", device: "Study Bulb", area_id: "kitchen", area: "Kitchen", disabled_by: null, hidden_by: null },
      { entity_id: "light.kitchen_ceiling", name: "Ceiling", platform: "hue", device_id: "dev_kitchen", device: "Hue Bulb 1", area_id: "kitchen", area: "Kitchen", disabled_by: null, hidden_by: null },
      { entity_id: "sensor.garage_temp", name: "Temperature", platform: "zha", device_id: "dev_garage", device: "Zigbee Thing", area_id: "garage", area: "Garage", disabled_by: null, hidden_by: null },
      { entity_id: "sensor.orphan", name: null, platform: "template", device_id: null, device: null, area_id: null, area: null, disabled_by: null, hidden_by: null },
    ]);
  });

  it("lets an entity's own area win over its device's, and inherits the device's area otherwise", async () => {
    registries();
    const r = await callTool("search_registry");
    const byId = Object.fromEntries(r.json.entities.map((e: any) => [e.entity_id, e]));
    // light.desk is in the study device but assigned to the kitchen itself.
    expect(byId["light.desk"].area).toBe("Kitchen");
    // light.kitchen_ceiling has no area of its own and takes its device's.
    expect(byId["light.kitchen_ceiling"].area).toBe("Kitchen");
    expect(byId["sensor.garage_temp"].area).toBe("Garage");
  });

  it("filters by query over entity_id, entity name, device name and area name, ignoring case", async () => {
    registries();
    expect(ids(await callTool("search_registry", { query: "GARAGE" }))).toEqual(["sensor.garage_temp"]);
    registries();
    expect(ids(await callTool("search_registry", { query: "desk lamp" }))).toEqual(["light.desk"]);
    registries();
    expect(ids(await callTool("search_registry", { query: "study bulb" }))).toEqual(["light.desk"]);
    registries();
    // matches the device's own name even though the user renamed it
    expect(ids(await callTool("search_registry", { query: "bulb 2" }))).toEqual(["light.desk"]);
    registries();
    // area name: the kitchen holds light.desk (own area) and light.kitchen_ceiling (inherited)
    expect(ids(await callTool("search_registry", { query: "kitchen" }))).toEqual(["light.desk", "light.kitchen_ceiling"]);
    registries();
    expect(ids(await callTool("search_registry", { query: "no-such-thing" }))).toEqual([]);
  });

  it("filters by area, by name or by area_id", async () => {
    registries();
    expect(ids(await callTool("search_registry", { area: "kitchen" }))).toEqual(["light.desk", "light.kitchen_ceiling"]);
    registries();
    expect(ids(await callTool("search_registry", { area: "Garage" }))).toEqual(["sensor.garage_temp"]);
    registries();
    // study only appears as a device area that the entity overrides, so nothing is in it
    expect(ids(await callTool("search_registry", { area: "study" }))).toEqual([]);
  });

  it("matches an area whose id differs from its name by either one, and not by another value", async () => {
    const lounge = [{ entity_id: "light.sofa", name: null, original_name: "Sofa", platform: "hue", device_id: null, area_id: "living_room_2", disabled_by: null }];
    registries(lounge);
    expect(ids(await callTool("search_registry", { area: "Lounge" }))).toEqual(["light.sofa"]);
    registries(lounge);
    expect(ids(await callTool("search_registry", { area: "living_room_2" }))).toEqual(["light.sofa"]);
    registries(lounge);
    expect(ids(await callTool("search_registry", { area: "living_room" }))).toEqual([]);
  });

  it("finds a renamed entity by its original name", async () => {
    registries([{ entity_id: "light.reading", name: "Reading Light", original_name: "Hue Lamp", platform: "hue", device_id: null, area_id: null, disabled_by: null }]);
    expect(ids(await callTool("search_registry", { query: "lamp" }))).toEqual(["light.reading"]);
  });

  it("gives a null area name for an area id that is not in the area registry", async () => {
    registries([{ entity_id: "light.ghost", name: null, original_name: "Ghost", platform: "hue", device_id: null, area_id: "deleted_area", disabled_by: null }]);
    const r = await callTool("search_registry");
    expect(r.json.entities[0]).toMatchObject({ area_id: "deleted_area", area: null });
  });

  it("reports hidden_by", async () => {
    registries([{ entity_id: "light.hid", name: null, original_name: "Hid", platform: "hue", device_id: null, area_id: null, disabled_by: null, hidden_by: "user" }]);
    const r = await callTool("search_registry");
    expect(r.json.entities[0].hidden_by).toBe("user");
  });

  it("filters by domain and rejects an invalid domain without calling HA", async () => {
    registries();
    expect(ids(await callTool("search_registry", { domain: "sensor" }))).toEqual(["sensor.garage_temp", "sensor.orphan"]);
    registries();
    const bad = await callTool("search_registry", { domain: "Light.x" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Invalid domain/);
    expect(spy.requests).toHaveLength(1);
  });

  it("leaves disabled entities out by default and returns them with include_disabled", async () => {
    registries();
    expect(ids(await callTool("search_registry"))).not.toContain("switch.old_plug");
    registries();
    const r = await callTool("search_registry", { include_disabled: true });
    expect(r.json.total).toBe(5);
    const plug = r.json.entities.find((e: any) => e.entity_id === "switch.old_plug");
    expect(plug).toMatchObject({ name: "Old Plug", disabled_by: "user", area: "Garage" });
  });

  it("combines filters", async () => {
    registries();
    expect(ids(await callTool("search_registry", { domain: "light", area: "kitchen", query: "ceiling" }))).toEqual(["light.kitchen_ceiling"]);
  });

  it("caps rows at 200 and reports the total and truncation", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      entity_id: `sensor.s${String(i).padStart(3, "0")}`,
      name: null,
      original_name: `S${i}`,
      platform: "x",
      device_id: null,
      area_id: null,
      disabled_by: null,
    }));
    registries(many);
    const r = await callTool("search_registry");
    expect(r.isError).toBe(false);
    expect(r.json.total).toBe(250);
    expect(r.json.count).toBe(200);
    expect(r.json.truncated).toBe(true);
    expect(r.json.entities).toHaveLength(200);
    expect(r.json.entities[0].entity_id).toBe("sensor.s000");
    expect(r.json.entities[199].entity_id).toBe("sensor.s199");
  });

  it("surfaces a Home Assistant error as an error result with its message and stops at the first failure", async () => {
    const ha = fakeHa((m) => ({
      id: m["id"],
      type: "result",
      success: false,
      error: { code: "unauthorized", message: "Unauthorized" },
    }));
    const r = await callTool("search_registry");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("unauthorized");
    expect(r.text).toContain("Unauthorized");
    expect(ha.received.filter((m) => m["type"] !== "auth")).toHaveLength(1);
  });

  it("reports a malformed registry reply as an error", async () => {
    fakeHa((m) => ({ id: m["id"], type: "result", success: true, result: { not: "a list" } }));
    const r = await callTool("search_registry");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/something other than a list/);
  });
});
