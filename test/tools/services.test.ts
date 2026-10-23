import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "../../src/index";
import { HaError } from "../../src/ha/rest";
import { registerServiceTools } from "../../src/tools/services";
import { installFetchSpy } from "../helpers/fetch";
import { callTool, json, listTools } from "../helpers/mcp";
import { queuePolicyWs } from "../helpers/policy-fake";

const spy = installFetchSpy();

// Shapes follow what Home Assistant returns: most services carry no name or description (those live in
// translations), a service may have a target, a field may be a collapsed section of fields, and
// `response` is present only for services that can return data.
const services = [
  {
    domain: "light",
    services: {
      turn_on: {
        target: { entity: [{ domain: ["light"] }] },
        fields: {
          transition: { selector: { number: { min: 0, max: 300 } } },
          brightness_pct: { description: "How bright.", example: 120, selector: { number: {} } },
          additional_fields: {
            collapsed: true,
            fields: {
              rgb_color: { example: "[255, 100, 100]", selector: { color_rgb: {} } },
              flash: { required: true, selector: { select: {} } },
            },
          },
        },
      },
      turn_off: { target: { entity: [{ domain: ["light"] }] }, fields: {} },
    },
  },
  {
    domain: "weather",
    services: {
      get_forecasts: {
        target: { entity: [{ domain: ["weather"] }] },
        fields: { type: { required: true, selector: { select: {} } } },
        response: { optional: false },
      },
    },
  },
  { domain: "script", services: { run: { name: "Run", description: "Runs it.", fields: {}, response: { optional: true } } } },
];

describe("list_services", () => {
  it("returns every domain with compact rows, flags and no invented names", async () => {
    spy.respondOnce(json(services));
    const r = await callTool("list_services");
    expect(r.isError).toBe(false);
    expect(r.json.domains.map((d: any) => d.domain)).toEqual(["light", "weather", "script"]);
    const [turnOn, turnOff] = r.json.domains[0].services;
    expect(turnOff).toEqual({ service: "turn_off", response: "none", has_target: true, fields: [] });
    expect(turnOn).not.toHaveProperty("name");
    expect(turnOn).not.toHaveProperty("description");
    expect(r.json.domains[1].services[0]).toMatchObject({ service: "get_forecasts", response: "only", has_target: true });
    expect(r.json.domains[2].services[0]).toEqual({
      service: "run",
      name: "Run",
      description: "Runs it.",
      response: "optional",
      has_target: false,
      fields: [],
    });
  });

  it("flattens section fields, tagging them with the section and keeping required flags", async () => {
    spy.respondOnce(json(services));
    const r = await callTool("list_services", { domain: "light" });
    expect(r.json.domains[0].services[0].fields).toEqual([
      { name: "transition", required: false },
      { name: "brightness_pct", required: false },
      { name: "rgb_color", required: false, section: "additional_fields" },
      { name: "flash", required: true, section: "additional_fields" },
    ]);
  });

  it("filters by domain", async () => {
    spy.respondOnce(json(services));
    const r = await callTool("list_services", { domain: "weather" });
    expect(r.json.domains).toHaveLength(1);
    spy.respondOnce(json(services));
    expect((await callTool("list_services", { domain: "nothing" })).json.domains).toEqual([]);
  });

  it("adds field details on request, including inside sections", async () => {
    spy.respondOnce(json(services));
    const r = await callTool("list_services", { domain: "light", include_field_details: true });
    const fields = r.json.domains[0].services[0].fields;
    expect(fields[1]).toEqual({
      name: "brightness_pct",
      required: false,
      description: "How bright.",
      example: 120,
      selector: { number: {} },
    });
    expect(fields[2]).toEqual({
      name: "rgb_color",
      required: false,
      section: "additional_fields",
      example: "[255, 100, 100]",
      selector: { color_rgb: {} },
    });
  });

  it("returns an error result when Home Assistant fails", async () => {
    spy.respondOnce(() => new Response("boom", { status: 500 }));
    const r = await callTool("list_services");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("HTTP 500");
  });
});

/** Answers one request and records the JSON body it carried (a body can only be read inside the handler). */
function recordBody(reply: unknown, sink: { body?: unknown }) {
  return async (request: Request): Promise<Response> => {
    sink.body = await request.json();
    return Response.json(reply);
  };
}

describe("call_service", () => {
  it("posts the data unchanged, including keys no schema declares", async () => {
    const sent: { body?: unknown } = {};
    // The safety policy classifies the light first, over the WebSocket.
    queuePolicyWs(spy, { platforms: { "light.kitchen": "hue" } });
    spy.respondOnce(recordBody([{ entity_id: "light.kitchen", state: "on", attributes: { x: 1 } }], sent));
    const data = { entity_id: "light.kitchen", brightness: 100, transition: { nested: [1, { deep: true }] }, vendor_key: "kept" };
    const r = await callTool("call_service", { domain: "light", service: "turn_on", data });
    expect(r.isError).toBe(false);
    expect(r.json).toEqual({ changed_states: [{ entity_id: "light.kitchen", state: "on" }] });
    const req = spy.requests[1]!;
    expect(req.method).toBe("POST");
    const url = new URL(req.url);
    expect(url.pathname).toBe("/api/services/light/turn_on");
    expect(url.search).toBe("");
    expect(sent.body).toEqual(data);
  });

  it("sends an empty object when there is no data", async () => {
    const sent: { body?: unknown } = {};
    spy.respondOnce(recordBody([], sent));
    const r = await callTool("call_service", { domain: "homeassistant", service: "check_config" });
    expect(r.json).toEqual({ changed_states: [] });
    expect(sent.body).toEqual({});
  });

  it("adds ?return_response and returns the service response", async () => {
    spy.respondOnce(
      json({ changed_states: [], service_response: { "weather.home": { forecast: [{ temperature: 12 }] } } }),
    );
    const r = await callTool("call_service", { domain: "weather", service: "get_forecasts", data: { type: "daily" }, return_response: true });
    expect(new URL(spy.requests[0]!.url).search).toBe("?return_response");
    expect(r.json).toEqual({
      changed_states: [],
      service_response: { "weather.home": { forecast: [{ temperature: 12 }] } },
    });
  });

  it("surfaces Home Assistant's explanation when the service rejects the call", async () => {
    spy.respondOnce(
      json(
        { message: "Service call requires responses but caller did not ask for responses. Add ?return_response to query parameters." },
        { status: 400 },
      ),
    );
    const r = await callTool("call_service", { domain: "weather", service: "get_forecasts" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("HTTP 400");
    expect(r.text).toContain("return_response");
  });

  it("tells the model a timed-out or unreachable call may still have run", async () => {
    queuePolicyWs(spy, { platforms: { "lock.front": "zwave_js" } });
    spy.respondOnce(() => {
      throw new TypeError("connection reset");
    });
    const r = await callTool("call_service", { domain: "lock", service: "unlock", data: { entity_id: "lock.front" } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("could not reach Home Assistant");
    expect(r.text).toContain("may still have run");
  });

  it("does not claim the call may have run when nothing was sent", async () => {
    // The shared test env has a valid HA_URL, so register the tools by hand against an unusable one.
    let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
    const fakeServer = {
      registerTool: (name: string, _config: unknown, h: typeof handler) => {
        if (name === "call_service") handler = h;
      },
    } as unknown as McpServer;
    registerServiceTools(fakeServer, { ...(env as unknown as Env), HA_URL: "not a url" });

    const error = await handler!({ domain: "lock", service: "unlock", return_response: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HaError);
    expect((error as HaError).message).toContain("HA_URL is not a valid URL");
    expect((error as HaError).message).not.toContain("may still have run");
    expect(spy.requests).toHaveLength(0);
  });

  it("describes the empty result of a service whose work runs in another context", async () => {
    const tools = await listTools();
    const description = tools.find((t) => t.name === "call_service")!.description ?? "";
    expect(description).toContain("automation.trigger");
    expect(description).toMatch(/empty list/);
  });

  it("rejects bad domain or service names without calling Home Assistant", async () => {
    expect((await callTool("call_service", { domain: "light/../config", service: "turn_on" })).isError).toBe(true);
    expect((await callTool("call_service", { domain: "light", service: "Turn On" })).isError).toBe(true);
    expect((await callTool("call_service", { domain: "light", service: "turn_on", data: "text" })).isError).toBe(true);
    expect(spy.requests).toHaveLength(0);
  });
});
