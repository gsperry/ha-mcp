import { describe, expect, it } from "vitest";
import { installFetchSpy } from "../helpers/fetch";
import { callTool, json } from "../helpers/mcp";

const spy = installFetchSpy();

const states = [
  { entity_id: "sensor.b_temp", state: "20", attributes: { friendly_name: "Bedroom Temperature", unit: "C" } },
  { entity_id: "light.kitchen", state: "on", attributes: { friendly_name: "Kitchen Light", brightness: 200 } },
  { entity_id: "light.hall", state: "off", attributes: {} },
  { entity_id: "sensor.a_temp", state: "18", attributes: { friendly_name: "Attic Temperature" } },
];

describe("list_entities", () => {
  it("returns compact rows sorted by entity_id with paging metadata", async () => {
    spy.respondOnce(json(states));
    const r = await callTool("list_entities");
    expect(r.isError).toBe(false);
    expect(r.json).toEqual({
      total: 4,
      offset: 0,
      count: 4,
      next_offset: null,
      entities: [
        { entity_id: "light.hall", name: null, state: "off" },
        { entity_id: "light.kitchen", name: "Kitchen Light", state: "on" },
        { entity_id: "sensor.a_temp", name: "Attic Temperature", state: "18" },
        { entity_id: "sensor.b_temp", name: "Bedroom Temperature", state: "20" },
      ],
    });
    expect(spy.requests).toHaveLength(1);
    expect(new URL(spy.requests[0]!.url).pathname).toBe("/api/states");
  });

  it("filters by domain", async () => {
    spy.respondOnce(json(states));
    const r = await callTool("list_entities", { domain: "light" });
    expect(r.json.entities.map((e: any) => e.entity_id)).toEqual(["light.hall", "light.kitchen"]);
    expect(r.json.total).toBe(2);
  });

  it("searches entity_id and friendly name, ignoring case", async () => {
    spy.respondOnce(json(states));
    expect((await callTool("list_entities", { search: "ATTIC" })).json.entities.map((e: any) => e.entity_id)).toEqual([
      "sensor.a_temp",
    ]);
    spy.respondOnce(json(states));
    expect((await callTool("list_entities", { search: "b_temp" })).json.entities.map((e: any) => e.entity_id)).toEqual([
      "sensor.b_temp",
    ]);
  });

  it("pages with limit, offset and next_offset", async () => {
    spy.respondOnce(json(states));
    const first = await callTool("list_entities", { limit: 3 });
    expect(first.json).toMatchObject({ total: 4, offset: 0, count: 3, next_offset: 3 });
    spy.respondOnce(json(states));
    const second = await callTool("list_entities", { limit: 3, offset: first.json.next_offset });
    expect(second.json).toMatchObject({ total: 4, offset: 3, count: 1, next_offset: null });
    expect(second.json.entities[0].entity_id).toBe("sensor.b_temp");
    spy.respondOnce(json(states));
    const beyond = await callTool("list_entities", { offset: 10 });
    expect(beyond.json).toMatchObject({ total: 4, count: 0, next_offset: null, entities: [] });
  });

  it("defaults the limit to 200 and rejects limits above 500", async () => {
    const many = Array.from({ length: 650 }, (_, i) => ({
      entity_id: `sensor.s${String(i).padStart(4, "0")}`,
      state: "1",
      attributes: {},
    }));
    spy.respondOnce(json(many));
    const r = await callTool("list_entities");
    expect(r.json).toMatchObject({ total: 650, count: 200, next_offset: 200 });
    spy.respondOnce(json(many));
    expect((await callTool("list_entities", { limit: 500 })).json.count).toBe(500);

    const bad = await callTool("list_entities", { limit: 501 });
    expect(bad.isError).toBe(true);
    expect((await callTool("list_entities", { offset: -1 })).isError).toBe(true);
    expect(spy.requests).toHaveLength(2);
  });

  it("includes attributes only when asked", async () => {
    spy.respondOnce(json(states));
    const r = await callTool("list_entities", { domain: "light", include_attributes: true });
    expect(r.json.entities[1]).toEqual({
      entity_id: "light.kitchen",
      name: "Kitchen Light",
      state: "on",
      attributes: { friendly_name: "Kitchen Light", brightness: 200 },
    });
  });

  it("returns an error result carrying Home Assistant's message when the call fails", async () => {
    spy.respondOnce(() => new Response("nope", { status: 401 }));
    const r = await callTool("list_entities");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("HTTP 401");
    expect(r.text).toContain("not retried");
    expect(spy.requests).toHaveLength(1);
  });

  it("rejects an invalid domain without calling Home Assistant", async () => {
    const r = await callTool("list_entities", { domain: "../config" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Invalid domain");
    expect(spy.requests).toHaveLength(0);
  });
});

describe("get_entity", () => {
  it("returns state, attributes and timestamps", async () => {
    spy.respondOnce(
      json({
        entity_id: "light.kitchen",
        state: "on",
        attributes: { brightness: 200 },
        last_changed: "2026-10-22T10:00:00+00:00",
        last_updated: "2026-10-22T10:01:00+00:00",
        context: { id: "x" },
      }),
    );
    const r = await callTool("get_entity", { entity_id: "light.kitchen" });
    expect(r.json).toEqual({
      entity_id: "light.kitchen",
      state: "on",
      attributes: { brightness: 200 },
      last_changed: "2026-10-22T10:00:00+00:00",
      last_updated: "2026-10-22T10:01:00+00:00",
    });
    expect(new URL(spy.requests[0]!.url).pathname).toBe("/api/states/light.kitchen");
  });

  it("reports an unknown entity", async () => {
    spy.respondOnce(json({ message: "Entity not found." }, { status: 404 }));
    const r = await callTool("get_entity", { entity_id: "light.nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("HTTP 404");
    expect(r.text).toContain("Entity not found.");
  });

  it("rejects a malformed entity_id without calling Home Assistant", async () => {
    for (const entity_id of ["light", "Light.Kitchen", "../x.y", "light.kitchen/../../config"]) {
      const r = await callTool("get_entity", { entity_id });
      expect(r.isError, entity_id).toBe(true);
    }
    expect(spy.requests).toHaveLength(0);
  });
});
