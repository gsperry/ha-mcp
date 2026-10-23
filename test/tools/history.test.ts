import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFetchSpy } from "../helpers/fetch";
import { callTool, json } from "../helpers/mcp";

const spy = installFetchSpy();

const NOW = new Date("2026-10-22T12:00:00.000Z");

describe("get_history", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to the last 24 hours with minimal_response and no_attributes", async () => {
    spy.respondOnce(json([[{ entity_id: "sensor.t", state: "1", last_changed: "a" }, { state: "2", last_changed: "b" }]]));
    const r = await callTool("get_history", { entity_id: "sensor.t" });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      entity_id: "sensor.t",
      start: "2026-10-21T12:00:00.000Z",
      end: "2026-10-22T12:00:00.000Z",
      total: 2,
      count: 2,
      truncated: false,
    });
    const url = new URL(spy.requests[0]!.url);
    expect(decodeURIComponent(url.pathname)).toBe("/api/history/period/2026-10-21T12:00:00.000Z");
    expect(url.searchParams.get("filter_entity_id")).toBe("sensor.t");
    expect(url.searchParams.get("end_time")).toBe("2026-10-22T12:00:00.000Z");
    expect(url.searchParams.has("minimal_response")).toBe(true);
    expect(url.searchParams.has("no_attributes")).toBe(true);
  });

  it("uses the given window and omits the flags when switched off", async () => {
    spy.respondOnce(json([[]]));
    const r = await callTool("get_history", {
      entity_id: "sensor.t",
      start: "2026-10-20T00:00:00+02:00",
      end: "2026-10-21T00:00:00Z",
      minimal_response: false,
      no_attributes: false,
    });
    expect(r.json).toMatchObject({ start: "2026-10-19T22:00:00.000Z", end: "2026-10-21T00:00:00.000Z", total: 0, states: [] });
    const url = new URL(spy.requests[0]!.url);
    expect(url.searchParams.has("minimal_response")).toBe(false);
    expect(url.searchParams.has("no_attributes")).toBe(false);
  });

  it("returns an empty list when Home Assistant has no history", async () => {
    spy.respondOnce(json([]));
    const r = await callTool("get_history", { entity_id: "sensor.t" });
    expect(r.json).toMatchObject({ total: 0, count: 0, truncated: false, states: [] });
  });

  it("caps at 500 states, keeping the newest, and flags truncation", async () => {
    const all = Array.from({ length: 620 }, (_, i) => ({ state: String(i), last_changed: `t${i}` }));
    spy.respondOnce(json([all]));
    const r = await callTool("get_history", { entity_id: "sensor.t" });
    expect(r.json).toMatchObject({ total: 620, count: 500, truncated: true });
    expect(r.json.states[0].state).toBe("120");
    expect(r.json.states[499].state).toBe("619");
  });

  it("keeps the first state's identity when truncation drops it under minimal_response", async () => {
    const all = [
      { entity_id: "sensor.t", state: "0", attributes: { unit: "C" }, last_changed: "t0" },
      ...Array.from({ length: 600 }, (_, i) => ({ state: String(i + 1), last_changed: `t${i + 1}` })),
    ];
    spy.respondOnce(json([all]));
    const r = await callTool("get_history", { entity_id: "sensor.t" });
    expect(r.json).toMatchObject({ total: 601, count: 500, truncated: true });
    expect(r.json.states[0]).toEqual({ entity_id: "sensor.t", attributes: { unit: "C" }, state: "101", last_changed: "t101" });
    expect(r.json.states[1].entity_id).toBeUndefined();
  });

  it("does not flag exactly 500 states as truncated", async () => {
    const all = Array.from({ length: 500 }, (_, i) => ({ state: String(i) }));
    spy.respondOnce(json([all]));
    const r = await callTool("get_history", { entity_id: "sensor.t" });
    expect(r.json).toMatchObject({ total: 500, count: 500, truncated: false });
  });

  it("returns an error result carrying Home Assistant's message", async () => {
    spy.respondOnce(json({ message: "Invalid filter_entity_id" }, { status: 400 }));
    const r = await callTool("get_history", { entity_id: "sensor.t" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("HTTP 400");
    expect(r.text).toContain("Invalid filter_entity_id");
  });

  it("rejects bad input without calling Home Assistant", async () => {
    expect((await callTool("get_history", { entity_id: "sensor.t,sensor.u" })).isError).toBe(true);
    const badStart = await callTool("get_history", { entity_id: "sensor.t", start: "yesterday-ish" });
    expect(badStart.isError).toBe(true);
    expect(badStart.text).toContain("Invalid start");
    expect((await callTool("get_history", { entity_id: "sensor.t", end: "x" })).isError).toBe(true);
    expect(spy.requests).toHaveLength(0);
  });
});
