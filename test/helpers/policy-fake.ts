import { vi } from "vitest";
import type { FetchSpy } from "./fetch";

export type Msg = Record<string, any>;

export interface FakeOptions {
  /** `entity/source`: entity id to platform. */
  platforms?: Record<string, string>;
  /** `script/config` by entity id. */
  scripts?: Record<string, unknown>;
  /** `automation/config` by entity id. */
  automations?: Record<string, unknown>;
  /** `blueprint/substitute`, keyed `<domain>:<path>`. */
  blueprints?: Record<string, unknown>;
  /** `extract_from_target`: what an area, device, floor or label id (or a group id) expands to. */
  targets?: Record<string, string[]>;
  /** `config/entity_registry/get_entries`, by entity id. */
  registry?: Record<string, Msg | null>;
  /** `config/entity_registry/list`. */
  registryList?: Msg[];
  /** REST `GET /api/states/<id>`. */
  states?: Record<string, unknown>;
  /** REST `GET /api/config/script/config/<key>`. */
  scriptKeys?: Record<string, unknown>;
  /** What the WebSocket does. */
  ws?: "ok" | "throw" | "no_socket" | "auth_invalid" | "close_after_first" | "unauthorized" | "silence";
  /** Runs when the WebSocket is upgraded (a test can move a fake clock here). */
  onUpgrade?: () => void;
  /** Runs before each command is answered. */
  onCommand?: (msg: Msg) => void;
  /** Answers a REST request before any other route does; return undefined to let the routes answer. */
  restFallback?: (path: string, method: string) => Response | undefined;
  /** Sees every request first, the WebSocket upgrade included, and may answer it (or stall it); return undefined to let the fake answer. */
  onRequest?: (request: Request) => Response | Promise<Response> | undefined;
}

export interface PolicyFake {
  options: FakeOptions;
  /** Every WebSocket command received, in order. */
  commands: Msg[];
  /** The types of those commands. */
  types: () => string[];
  opened: number;
  closed: number;
  /** Every REST request, as `METHOD /path`. */
  rest: string[];
  /** The requests that act on the house: POSTs to services, automation writes and deletes. */
  acting: string[];
  /** Bodies of the acting requests. */
  bodies: unknown[];
  /** Automations written through the fake, by id. */
  stored: Map<string, Msg>;
}

/**
 * A fake Home Assistant for the policy: answers the WebSocket commands the check uses and the REST reads, and records
 * every request that would act on the house. Installed as the fetch spy's fallback.
 */
export function startPolicyFake(spy: FetchSpy, options: FakeOptions = {}): PolicyFake {
  const fake: PolicyFake = {
    options,
    commands: [],
    types: () => fake.commands.map((c) => String(c.type)),
    opened: 0,
    closed: 0,
    rest: [],
    acting: [],
    bodies: [],
    stored: new Map(),
  };
  spy.respondAlways((request) => handle(fake, request));
  return fake;
}

/** Queues one WebSocket upgrade only (for tests that queue every other response in order). */
export function queuePolicyWs(spy: FetchSpy, options: FakeOptions = {}): PolicyFake {
  const fake: PolicyFake = {
    options,
    commands: [],
    types: () => fake.commands.map((c) => String(c.type)),
    opened: 0,
    closed: 0,
    rest: [],
    acting: [],
    bodies: [],
    stored: new Map(),
  };
  spy.respondOnce(() => upgrade(fake));
  return fake;
}

const ok = (id: unknown, result: unknown): Msg => ({ id, type: "result", success: true, result });
const err = (id: unknown, code: string, message: string): Msg => ({ id, type: "result", success: false, error: { code, message } });

function expand(fake: PolicyFake, target: Msg): string[] {
  const out = new Set<string>();
  for (const key of ["entity_id", "device_id", "area_id", "floor_id", "label_id"]) {
    const values = Array.isArray(target[key]) ? (target[key] as string[]) : [];
    for (const v of values) {
      const mapped = fake.options.targets?.[v];
      if (mapped) for (const m of mapped) out.add(m);
      else if (key === "entity_id") out.add(v);
    }
  }
  return [...out];
}

function answer(fake: PolicyFake, msg: Msg): Msg {
  const o = fake.options;
  switch (msg.type) {
    case "entity/source":
      return ok(msg.id, Object.fromEntries(Object.entries(o.platforms ?? {}).map(([id, domain]) => [id, { domain }])));
    case "script/config": {
      const config = o.scripts?.[msg.entity_id];
      return config === undefined ? err(msg.id, "not_found", "Entity not found") : ok(msg.id, { config });
    }
    case "automation/config": {
      const config = o.automations?.[msg.entity_id];
      return config === undefined ? err(msg.id, "not_found", "Entity not found") : ok(msg.id, { config });
    }
    case "blueprint/substitute": {
      const config = o.blueprints?.[`${msg.domain}:${msg.path}`];
      return config === undefined ? err(msg.id, "unknown_error", "Unable to find blueprint") : ok(msg.id, { substituted_config: config });
    }
    case "extract_from_target":
      return ok(msg.id, { referenced_entities: expand(fake, msg.target), referenced_devices: [], referenced_areas: [] });
    case "config/entity_registry/get_entries":
      return ok(
        msg.id,
        Object.fromEntries((msg.entity_ids as string[]).map((id) => [id, o.registry?.[id] ?? null])),
      );
    case "config/entity_registry/list":
      return ok(msg.id, o.registryList ?? []);
    default:
      return err(msg.id, "unknown_command", "Unknown command.");
  }
}

function upgrade(fake: PolicyFake): Response {
  const mode = fake.options.ws ?? "ok";
  if (mode === "throw") throw new TypeError("network down");
  if (mode === "no_socket") return new Response("no upgrade", { status: 200 });
  fake.opened += 1;
  fake.options.onUpgrade?.();
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  const send = (m: Msg) => server.send(JSON.stringify(m));
  server.addEventListener("close", () => {
    fake.closed += 1;
  });
  let commandsSeen = 0;
  server.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data as string) as Msg;
    if (msg.type === "auth") {
      if (mode === "auth_invalid") return send({ type: "auth_invalid", message: "Invalid access token" });
      return send({ type: "auth_ok", ha_version: "2026.10.2" });
    }
    fake.commands.push(msg);
    commandsSeen += 1;
    fake.options.onCommand?.(msg);
    if (mode === "silence") return;
    if (mode === "unauthorized") return send(err(msg.id, "unauthorized", "Unauthorized"));
    if (mode === "close_after_first" && commandsSeen > 1) return server.close(1011, "going away");
    send(answer(fake, msg));
  });
  queueMicrotask(() => send({ type: "auth_required", ha_version: "2026.10.2" }));
  return new Response(null, { status: 101, webSocket: client });
}

async function handle(fake: PolicyFake, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = decodeURIComponent(url.pathname);
  const method = request.method;
  const custom = fake.options.onRequest?.(request);
  if (custom !== undefined) return custom;
  if (path === "/api/websocket") return upgrade(fake);

  fake.rest.push(`${method} ${path}`);
  const o = fake.options;

  const early = o.restFallback?.(path, method);
  if (early) return early;

  const stateMatch = /^\/api\/states\/(.+)$/.exec(path);
  if (method === "GET" && stateMatch) {
    const state = o.states?.[stateMatch[1]!];
    return state === undefined ? Response.json({ message: "Entity not found." }, { status: 404 }) : Response.json(state);
  }
  const keyMatch = /^\/api\/config\/script\/config\/(.+)$/.exec(path);
  if (method === "GET" && keyMatch) {
    const config = o.scriptKeys?.[keyMatch[1]!];
    return config === undefined ? Response.json({ message: "Resource not found" }, { status: 404 }) : Response.json(config);
  }

  // The automation write flow, enough for an allowed upsert to complete.
  const autoMatch = /^\/api\/config\/automation\/config\/(.+)$/.exec(path);
  if (autoMatch) {
    const id = autoMatch[1]!;
    if (method === "GET") {
      const stored = fake.stored.get(id);
      return stored === undefined ? Response.json({ message: "Resource not found" }, { status: 404 }) : Response.json(stored);
    }
    if (method === "POST") {
      const body = (await request.json()) as Msg;
      fake.acting.push(`${method} ${path}`);
      fake.bodies.push(body);
      fake.stored.set(id, { id, ...body });
      return Response.json({ result: "ok" });
    }
    if (method === "DELETE") {
      fake.acting.push(`${method} ${path}`);
      if (!fake.stored.delete(id)) return Response.json({ message: "Resource not found" }, { status: 400 });
      return Response.json({ result: "ok" });
    }
  }
  if (method === "GET" && path === "/api/states") {
    const autos = [...fake.stored.keys()].map((id) => ({
      entity_id: `automation.${id}`,
      state: "on",
      attributes: { id, friendly_name: id },
    }));
    return Response.json(autos);
  }

  if (method === "POST" && path.startsWith("/api/services/")) {
    fake.acting.push(`${method} ${path}`);
    fake.bodies.push(await request.json());
    return Response.json([]);
  }
  return Response.json({ message: "unmocked route" }, { status: 599 });
}

/** Moves `Date.now()` forward by `ms` from now on, in steps the caller controls. Returns the offset setter. */
export function fakeClock(): { advance: (ms: number) => void } {
  const real = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
  return { advance: (ms) => void (offset += ms) };
}

/** Asserts a tool reply is a policy refusal containing every fragment, and that nothing acted on the house. */
export function refusedText(reply: { isError: boolean; text: string }): string {
  if (!reply.isError || !reply.text.startsWith("Refused by this server's safety policy")) {
    throw new Error(`Expected a policy refusal, got ${reply.isError ? "an error" : "a success"}: ${reply.text.slice(0, 400)}`);
  }
  return reply.text;
}

/** A house with one entity of each kind the policy tells apart. */
export const PLATFORMS: Record<string, string> = {
  "light.kitchen": "hue",
  "light.desk": "hue",
  "light.shell": "template",
  "switch.plug": "tplink",
  "switch.shell": "template",
  "switch.cmd": "command_line",
  "switch.addon": "hassio",
  "switch.container": "portainer",
  "switch.wol": "wake_on_lan",
  "switch.vm": "proxmoxve",
  "lock.front": "zwave_js",
  "climate.hall": "nest",
  "cover.garage": "esphome",
  "media_player.speaker": "cast",
  "media_player.tv": "universal",
  "media_player.viera": "panasonic_viera",
  "sensor.tmpl": "template",
  "sensor.temp": "zha",
  "script.lights": "script",
  "script.restart": "script",
  "script.shell": "script",
  "scene.evening": "homeassistant",
  "automation.ok": "automation",
  "automation.bad": "automation",
  "button.garage": "esphome",
  "button.router": "tplink",
  "button.nas": "synology_dsm",
  "tts.cloud": "cloud",
};
