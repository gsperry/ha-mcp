import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteInTwoCalls, finishDelete, lastCode, requestDelete } from "../helpers/delete";
import { installFetchSpy } from "../helpers/fetch";
import { callTool, listTools, type ToolReply } from "../helpers/mcp";

const spy = installFetchSpy();

type Json = Record<string, any>;

// ---------------------------------------------------------------------------------------------
// Timers. The call limits (10 s, 20 s) and the poll read limit (4 s) run at one twentieth of their length and the
// one-second poll gap runs at once, so a timeout takes well under a second. Every requested delay is recorded.
// A timer that is only held back would let the runtime decide the Worker had hung, so these are real timers.
// ---------------------------------------------------------------------------------------------

const SCALE = 20;

let delays: number[];

beforeEach(() => {
  const realSet = globalThis.setTimeout;
  delays = [];
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, delay = 0, ...args: unknown[]) => {
    delays.push(delay);
    const scaled = delay >= 4000 ? delay / SCALE : delay >= 1000 ? 0 : delay;
    return (realSet as (f: () => void, d: number, ...a: unknown[]) => ReturnType<typeof setTimeout>)(fn, scaled, ...args);
  }) as unknown as typeof setTimeout);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// A fake Home Assistant: the automation config endpoint, /api/states, the service endpoint and a WebSocket.
// ---------------------------------------------------------------------------------------------

type WsMode =
  | "ok"
  | "throw"
  | "no_socket"
  | "close"
  | "other_error"
  | "not_list"
  | "garbage"
  | "bad_auth_message"
  | "silence"
  | "auth_invalid"
  | "unauthorized";

interface LogEntry {
  method: string;
  path: string;
  body: unknown;
}

interface Fake {
  /** The automations.yaml entries, by id. */
  stored: Map<string, Json>;
  registry: Json[];
  /** Every state, automations and others. */
  states: Json[];
  ws: WsMode;
  log: LogEntry[];
  wsOpened: number;
  wsClosed: number;
  wsCommands: Json[];
  /** Number of /api/states reads after the first POST that must pass before a new automation is visible. */
  visibleAfterReads: number;
  /** Runs for every request before the simulation; return a Response (or a promise of one) to answer it. */
  override?: (info: { method: string; path: string; body: unknown; request: Request; nth: number }) => Response | Promise<Response> | undefined;
  /** Runs inside the POST handler before the config is stored (a concurrent writer). */
  beforePost?: (fake: Fake) => void;
  /** The WebSocket answer to automation/config, by entity id. */
  wsConfigs: Record<string, Json>;
  /** Every request path, as "METHOD /path", in order. */
  calls: () => string[];
  posts: () => unknown[];
}

const notFound = () => Response.json({ message: "Resource not found" }, { status: 404 });

function autoState(entity_id: string, id: string | null, state = "on", alias = entity_id): Json {
  return { entity_id, state, attributes: { ...(id === null ? {} : { id }), friendly_name: alias } };
}

let lastFake: Fake | undefined;

/**
 * A delete in the two calls the tool needs: the first sends the code to the phone, the second deletes. The request log and
 * the recorded timer delays are cleared between them, so a test sees the second call's own requests. Returns the second
 * reply, or the first when the first call did not get as far as a challenge.
 */
async function del(id: string): Promise<ToolReply> {
  const { first, second } = await deleteInTwoCalls(spy, id, {
    between: () => {
      lastFake?.log.splice(0);
      delays.length = 0;
    },
  });
  return second ?? first;
}

function startFake(init: Partial<Pick<Fake, "stored" | "registry" | "states" | "ws" | "visibleAfterReads">> = {}): Fake {
  let postsSeen = 0;
  let readsAfterPost = 0;
  const counts = new Map<string, number>();
  const fake: Fake = {
    stored: init.stored ?? new Map(),
    registry: init.registry ?? [],
    states: init.states ?? [{ entity_id: "light.kitchen", state: "on", attributes: {} }],
    ws: init.ws ?? "ok",
    log: [],
    wsOpened: 0,
    wsClosed: 0,
    wsCommands: [],
    visibleAfterReads: init.visibleAfterReads ?? 0,
    wsConfigs: {},
    calls: () => fake.log.map((l) => `${l.method} ${l.path}`),
    posts: () => fake.log.filter((l) => l.method === "POST").map((l) => l.body),
  };

  lastFake = fake;
  const configPrefix = "/api/config/automation/config/";
  let pending: Json | null = null;

  spy.respondAlways(async (request) => {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    const method = request.method;
    let body: unknown = undefined;
    if (method === "POST" || method === "DELETE") {
      const text = await request.clone().text();
      try {
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        body = text;
      }
    }
    fake.log.push({ method, path, body });
    const key = `${method} ${path}`;
    const nth = (counts.get(key) ?? 0) + 1;
    counts.set(key, nth);

    const custom = fake.override?.({ method, path, body, request, nth });
    if (custom !== undefined) return custom;

    if (path === "/api/websocket") return upgrade(fake);

    // The notify service that carries the delete code.
    if (path.startsWith("/api/services/notify/") && method === "POST") return Response.json([]);

    if (path.startsWith(configPrefix)) {
      const id = path.slice(configPrefix.length);
      if (method === "GET") {
        const found = fake.stored.get(id);
        return found === undefined ? notFound() : Response.json(JSON.parse(JSON.stringify(found)));
      }
      if (method === "POST") {
        postsSeen += 1;
        fake.beforePost?.(fake);
        const config: Json = { id, ...(body as Json) };
        fake.stored.set(id, config);
        const existing = fake.states.find((s) => s.attributes.id === id);
        if (!existing) {
          pending = autoState(`automation.${id.replace(/\W/g, "_")}`, id, "on", String(config.alias ?? id));
          readsAfterPost = 0;
        }
        return Response.json({ result: "ok" });
      }
      if (method === "DELETE") {
        if (!fake.stored.has(id)) return Response.json({ message: "Resource not found" }, { status: 400 });
        fake.stored.delete(id);
        fake.states = fake.states.filter((s) => s.attributes.id !== id);
        fake.registry = fake.registry.filter((e) => e.unique_id !== id);
        return Response.json({ result: "ok" });
      }
    }

    if (path === "/api/states" && method === "GET") {
      if (pending !== null) {
        readsAfterPost += 1;
        if (readsAfterPost > fake.visibleAfterReads) {
          fake.states.push(pending);
          pending = null;
        }
      }
      return Response.json(fake.states);
    }

    if (path === "/api/services/automation/reload" && method === "POST") {
      // A reload removes the entity of an id that is no longer stored; its enabled registry entry leaves an unavailable state.
      const wanted = (body as Json | undefined)?.id;
      for (const s of fake.states) {
        const id = s.attributes.id;
        if (typeof id === "string" && !fake.stored.has(id) && (wanted === undefined || wanted === id)) {
          const entry = fake.registry.find((e) => e.unique_id === id);
          s.state = "unavailable";
          if (!entry) fake.states = fake.states.filter((x) => x !== s);
        }
      }
      return Response.json([]);
    }
    void postsSeen;
    return Response.json({ message: "unmocked route" }, { status: 599 });
  });
  return fake;
}

function upgrade(fake: Fake): Response {
  if (fake.ws === "throw") throw new TypeError("network down");
  if (fake.ws === "no_socket") return new Response("no upgrade", { status: 200 });
  fake.wsOpened += 1;
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  const send = (m: Json) => server.send(JSON.stringify(m));
  server.addEventListener("close", () => {
    fake.wsClosed += 1;
  });
  server.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data as string) as Json;
    if (msg.type === "auth") {
      if (fake.ws === "auth_invalid") return send({ type: "auth_invalid", message: "Invalid access token" });
      if (fake.ws === "bad_auth_message") return send({ type: "surprise" });
      if (fake.ws === "close") return server.close(1011, "going away");
      return send({ type: "auth_ok", ha_version: "2026.10.2" });
    }
    fake.wsCommands.push(msg);
    if (fake.ws === "silence") return;
    if (fake.ws === "unauthorized") return send({ id: msg.id, type: "result", success: false, error: { code: "unauthorized", message: "Unauthorized" } });
    if (fake.ws === "other_error") return send({ id: msg.id, type: "result", success: false, error: { code: "unknown_error", message: "boom" } });
    if (fake.ws === "garbage") return server.send("not json");
    if (msg.type === "config/entity_registry/list") {
      return send({ id: msg.id, type: "result", success: true, result: fake.ws === "not_list" ? { entries: [] } : fake.registry });
    }
    // The safety policy's reads: no entity needs classifying here, and a blueprint expands to an empty config.
    if (msg.type === "entity/source") return send({ id: msg.id, type: "result", success: true, result: {} });
    if (msg.type === "blueprint/substitute") {
      return send({ id: msg.id, type: "result", success: true, result: { substituted_config: { alias: "From blueprint", triggers: [], actions: [] } } });
    }
    if (msg.type === "automation/config") {
      const config = fake.wsConfigs[String(msg.entity_id)];
      return send({ id: msg.id, type: "result", success: true, result: { config } });
    }
    send({ id: msg.id, type: "result", success: false, error: { code: "unknown_command", message: "Unknown command." } });
  });
  queueMicrotask(() => send({ type: "auth_required", ha_version: "2026.10.2" }));
  return new Response(null, { status: 101, webSocket: client });
}

/** Waits until every socket the fake opened has been closed, then a turn so a late message would have arrived. */
async function settled(fake: Fake): Promise<void> {
  await vi.waitFor(() => expect(fake.wsClosed).toBe(fake.wsOpened));
  await new Promise((r) => setTimeout(r, 50));
}

function expectOk(r: ToolReply): ToolReply {
  expect(r.isError, r.text.slice(0, 600)).toBe(false);
  return r;
}

const regEntry = (entity_id: string, unique_id: string, extra: Json = {}): Json => ({
  entity_id,
  platform: "automation",
  unique_id,
  area_id: null,
  labels: [],
  categories: {},
  name: null,
  icon: null,
  disabled_by: null,
  hidden_by: null,
  options: {},
  ...extra,
});

const base: Json = {
  alias: "Porch light",
  description: "Turns the porch light on at sunset",
  mode: "single",
  triggers: [{ trigger: "sun", event: "sunset" }],
  conditions: [],
  // No entity is named, so the safety policy decides locally and these tests keep counting only their own connections.
  actions: [{ action: "persistent_notification.create", data: { message: "Porch light" } }],
};

const configPath = (id: string) => `/api/config/automation/config/${id}`;
const warningCodes = (r: ToolReply): string[] => r.json.warnings.map((w: Json) => w.code);

// ---------------------------------------------------------------------------------------------

describe("upsert_automation: the config reaches Home Assistant unchanged (schema is loose at every depth)", () => {
  it("sends variables, max, trace, trigger_variables and an unknown future key, and unknown keys inside a trigger, condition and action", async () => {
    const config = {
      ...base,
      variables: { threshold: 3, nested: { a: [1, 2] } },
      max: 5,
      max_exceeded: "silent",
      trace: { stored_traces: 10 },
      trigger_variables: { who: "me" },
      initial_state: true,
      hide_entity: false,
      future_key: { anything: ["goes"] },
      triggers: [{ trigger: "sun", event: "sunset", id: "dusk", brand_new_trigger_key: 1 }],
      conditions: [{ condition: "state", entity_id: "light.porch", state: "off", brand_new_condition_key: { x: 1 } }],
      actions: [{ action: "light.turn_on", metadata: { m: 1 }, brand_new_action_key: [true] }],
    };
    const fake = startFake();
    const r = expectOk(await callTool("upsert_automation", { id: "ui_new", config }));

    expect(fake.posts()).toEqual([config]);
    expect(r.json.config).toEqual({ id: "ui_new", ...config });
    expect(r.json.entity_id).toBe("automation.ui_new");
    expect(r.json.previous_config).toBeNull();
    await settled(fake);
  });

  it("accepts a single-dict trigger and action, singular keys, and a string condition, and sends them as given", async () => {
    const config = {
      alias: "Old style",
      trigger: { platform: "state", entity_id: "binary_sensor.door", to: "on" },
      condition: "{{ is_state('light.porch', 'off') }}",
      action: { service: "persistent_notification.create", data: { message: "Porch light" } },
    };
    const fake = startFake();
    expectOk(await callTool("upsert_automation", { id: "old_style", config }));
    expect(fake.posts()).toEqual([config]);
    await settled(fake);
  });

  it("accepts a condition list that mixes strings and objects, and a condition object", async () => {
    const fake = startFake();
    const mixed = { ...base, conditions: ["{{ true }}", { condition: "time", after: "18:00:00" }] };
    expectOk(await callTool("upsert_automation", { id: "mixed", config: mixed }));
    expect(fake.posts()[0]).toEqual(mixed);
    const single = { ...base, condition: { condition: "time", after: "18:00:00" } };
    expectOk(await callTool("upsert_automation", { id: "single", config: single }));
    expect(fake.posts()[1]).toEqual(single);
    await settled(fake);
  });

  it("accepts a blueprint automation with no triggers or actions", async () => {
    const config = { alias: "From blueprint", use_blueprint: { path: "motion_light.yaml", input: { sensor: "binary_sensor.hall" } } };
    const fake = startFake();
    const r = expectOk(await callTool("upsert_automation", { id: "bp", config }));
    expect(fake.posts()).toEqual([config]);
    expect(r.json.config.use_blueprint).toEqual(config.use_blueprint);
    await settled(fake);
  });

  it("accepts null triggers, conditions and actions and a numeric alias, and adds no key the caller did not send", async () => {
    const config = { alias: 42, triggers: null, conditions: null, actions: null };
    const fake = startFake();
    expectOk(await callTool("upsert_automation", { id: "nulls", config }));
    expect(fake.posts()).toEqual([config]);
    expect(Object.keys(fake.posts()[0] as object).sort()).toEqual(["actions", "alias", "conditions", "triggers"]);

    const minimal = { triggers: [], actions: [] };
    expectOk(await callTool("upsert_automation", { id: "minimal", config: minimal }));
    expect(fake.posts()[1]).toEqual(minimal);
    await settled(fake);
  });

  it("refuses a config with neither triggers nor use_blueprint, or neither actions nor use_blueprint, and sends nothing", async () => {
    startFake();
    const noTriggers = await callTool("upsert_automation", { id: "x", config: { alias: "a", actions: [] } });
    expect(noTriggers.isError).toBe(true);
    expect(noTriggers.text).toMatch(/`triggers`/);
    expect(noTriggers.text).toMatch(/Nothing was sent/);
    const noActions = await callTool("upsert_automation", { id: "x", config: { alias: "a", triggers: [] } });
    expect(noActions.isError).toBe(true);
    expect(noActions.text).toMatch(/`actions`/);
    expect(spy.requests).toHaveLength(0);
  });

  it("refuses a bad mode, a null alias and a non-object trigger item, and sends nothing", async () => {
    startFake();
    for (const config of [
      { ...base, mode: "sometimes" },
      { ...base, alias: null },
      { ...base, triggers: ["sun"] },
      { ...base, actions: [3] },
    ]) {
      const r = await callTool("upsert_automation", { id: "x", config });
      expect(r.isError).toBe(true);
    }
    expect(spy.requests).toHaveLength(0);
  });

  it("advertises open additionalProperties at the config level and in trigger, condition and action items", async () => {
    const tool = (await listTools()).find((t) => t.name === "upsert_automation")!;
    const config = tool.inputSchema.properties.config;
    expect(config.additionalProperties).toEqual({});
    const objectOf = (schema: Json): Json | undefined => (schema.anyOf as Json[] | undefined)?.find((s) => s.type === "object");
    const itemOf = (schema: Json): Json | undefined => (schema.anyOf as Json[] | undefined)?.find((s) => s.type === "array")?.items;
    for (const key of ["triggers", "trigger", "actions", "action", "conditions", "condition"]) {
      const schema = config.properties[key] as Json;
      expect(objectOf(schema)?.additionalProperties, `${key} object`).toEqual({});
      const item = itemOf(schema) as Json;
      const itemObject = item.type === "object" ? item : objectOf(item);
      expect(itemObject?.additionalProperties, `${key} item`).toEqual({});
    }
    expect(config.properties.use_blueprint.additionalProperties).toEqual({});
    expect(config.required ?? []).toEqual([]);
  });
});

describe("upsert_automation: ids", () => {
  it("never sends a body id, keeps an id key inside a trigger, and warns only when the body id differs from the argument", async () => {
    const fake = startFake();
    // Same id as a string: no warning. A numeric body id equal to the argument: no warning either.
    const same = expectOk(await callTool("upsert_automation", { id: "1700000000001", config: { ...base, id: "1700000000001" } }));
    expect(warningCodes(same)).not.toContain("body_id_ignored");
    const numeric = expectOk(await callTool("upsert_automation", { id: "1700000000002", config: { ...base, id: 1700000000002 } }));
    expect(warningCodes(numeric)).not.toContain("body_id_ignored");

    const other = expectOk(
      await callTool("upsert_automation", {
        id: "mine",
        config: { ...base, id: "theirs", triggers: [{ trigger: "sun", event: "sunset", id: "trigger-id" }] },
      }),
    );
    expect(warningCodes(other)).toContain("body_id_ignored");
    expect(other.json.warnings.find((w: Json) => w.code === "body_id_ignored").message).toContain("mine");

    for (const body of fake.posts() as Json[]) expect(Object.hasOwn(body, "id")).toBe(false);
    expect((fake.posts()[2] as Json).triggers[0].id).toBe("trigger-id");
    expect(fake.stored.get("mine")!.id).toBe("mine");
    expect(fake.stored.has("theirs")).toBe(false);
    await settled(fake);
  });

  it("warns when a body id is sent with no id argument, names the generated id, and creates under the generated id", async () => {
    const fake = startFake();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_123);
    vi.spyOn(crypto, "getRandomValues").mockImplementation(((a: Uint32Array) => {
      a[0] = 7;
      return a;
    }) as never);
    const r = expectOk(await callTool("upsert_automation", { config: { ...base, id: "from-get-automation" } }));
    expect(r.json.id).toBe("1700000000123000007");
    expect(warningCodes(r)).toContain("body_id_ignored");
    expect(r.json.warnings.find((w: Json) => w.code === "body_id_ignored").message).toContain("1700000000123000007");
    expect(fake.stored.has("from-get-automation")).toBe(false);
    expect(Object.hasOwn(fake.posts()[0] as Json, "id")).toBe(false);
    await settled(fake);
  });

  it("builds a generated id as thirteen digits of milliseconds and six zero-padded digits, as text", async () => {
    const fake = startFake();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_123);
    vi.spyOn(crypto, "getRandomValues").mockImplementation(((a: Uint32Array) => {
      a[0] = 42;
      return a;
    }) as never);
    const r = expectOk(await callTool("upsert_automation", { config: base }));
    expect(r.json.id).toBe("1700000000123000042");
    expect(r.json.id).toHaveLength(19);
    expect(fake.calls()[0]).toBe(`GET ${configPath("1700000000123000042")}`);
    expect(fake.stored.has("1700000000123000042")).toBe(true);
    await settled(fake);
  });

  it.each([[""], ["."], [".."]])("refuses the id %j before any request", async (id) => {
    startFake();
    const r = await callTool("upsert_automation", { id, config: base });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Stage: before_write/);
    expect(spy.requests).toHaveLength(0);
  });

  it("encodes an id with unusual characters in the URL", async () => {
    const fake = startFake();
    expectOk(await callTool("upsert_automation", { id: "a b/c", config: base }));
    expect(spy.requests.some((q) => new URL(q.url).pathname === "/api/config/automation/config/a%20b%2Fc")).toBe(true);
    expect(fake.stored.has("a b/c")).toBe(true);
    await settled(fake);
  });

  it("stops without writing when the config read of a generated id answers 200, then a new call generates another id", async () => {
    const fake = startFake({ stored: new Map([["1700000000123000042", { ...base, id: "1700000000123000042" }]]) });
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_123);
    const random = vi.spyOn(crypto, "getRandomValues").mockImplementation(((a: Uint32Array) => {
      a[0] = 42;
      return a;
    }) as never);
    const r = await callTool("upsert_automation", { config: base });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/already exists/);
    expect(fake.calls()).toEqual([`GET ${configPath("1700000000123000042")}`]);
    expect(fake.posts()).toHaveLength(0);

    random.mockImplementation(((a: Uint32Array) => {
      a[0] = 43;
      return a;
    }) as never);
    expect(expectOk(await callTool("upsert_automation", { config: base })).json.id).toBe("1700000000123000043");
    await settled(fake);
  });
});

describe("upsert_automation: the collision guard", () => {
  it("refuses an enabled package id (registry entry and state) before any POST", async () => {
    const fake = startFake({
      registry: [regEntry("automation.garage_pkg", "pkg_garage")],
      states: [autoState("automation.garage_pkg", "pkg_garage")],
    });
    const r = await callTool("upsert_automation", { id: "pkg_garage", config: base });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("automation.garage_pkg");
    expect(r.text).toMatch(/YAML package/);
    expect(r.text).toMatch(/Omit `id`|omit `id`/);
    expect(r.text).toMatch(/leftover registry entry/);
    expect(fake.posts()).toHaveLength(0);
    await settled(fake);
  });

  it("refuses a registry-disabled package id (registry entry, no state) before the states read and any POST", async () => {
    const fake = startFake({ registry: [regEntry("automation.hidden_pkg", "pkg_hidden", { disabled_by: "user" })] });
    const r = await callTool("upsert_automation", { id: "pkg_hidden", config: base });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("automation.hidden_pkg");
    expect(fake.calls()).toEqual([`GET ${configPath("pkg_hidden")}`, "GET /api/websocket"]);
    await settled(fake);
  });

  it("refuses an id that only a loaded state carries (registry empty), before any POST", async () => {
    const fake = startFake({ states: [autoState("automation.someone", "pkg_state_only")] });
    const r = await callTool("upsert_automation", { id: "pkg_state_only", config: base });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("automation.someone");
    expect(fake.posts()).toHaveLength(0);
    await settled(fake);
  });

  it("refuses an orphaned registry entry and says it can be a leftover of a removed UI automation", async () => {
    const fake = startFake({ registry: [regEntry("automation.removed_by_hand", "orphan_1")] });
    const r = await callTool("upsert_automation", { id: "orphan_1", config: base });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/leftover registry entry of a UI automation that was removed from automations.yaml by hand/);
    expect(r.text).toMatch(/false positive/);
    expect(fake.posts()).toHaveLength(0);
    await settled(fake);
  });

  it("does not treat an entry of another platform, or another domain, as a match", async () => {
    const fake = startFake({
      registry: [
        { ...regEntry("automation.looks_like", "shared_id"), platform: "template" },
        { ...regEntry("light.odd", "shared_id") },
      ],
    });
    expectOk(await callTool("upsert_automation", { id: "shared_id", config: base }));
    expect(fake.posts()).toHaveLength(1);
    await settled(fake);
  });

  it("makes no registry or states read when the config read of the id answers 200 (an edit)", async () => {
    const fake = startFake({ stored: new Map([["ui_1", { ...base, id: "ui_1", alias: "Old" }]]) });
    const r = expectOk(await callTool("upsert_automation", { id: "ui_1", config: base }));
    expect(fake.calls()).toEqual([`GET ${configPath("ui_1")}`, `POST ${configPath("ui_1")}`, `GET ${configPath("ui_1")}`]);
    expect(fake.wsOpened).toBe(0);
    expect(r.json.previous_config).toMatchObject({ alias: "Old" });
    expect(r.json.entity_id).toBeNull();
    expect(r.json.state).toBeNull();
  });

  it("stops before the POST when the states read fails", async () => {
    const fake = startFake();
    fake.override = ({ path }) => (path === "/api/states" ? Response.json({ message: "down" }, { status: 502 }) : undefined);
    const r = await callTool("upsert_automation", { id: "new_one", config: base });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Stage: before_write/);
    expect(r.text).toMatch(/Nothing was changed/);
    expect(fake.posts()).toHaveLength(0);
    await settled(fake);
  });
});

describe("registry read failures: the narrow fallback", () => {
  const transportKinds: WsMode[] = ["throw", "no_socket", "close", "other_error", "not_list", "garbage", "bad_auth_message", "silence"];

  /** Runs a call; a silent socket ends when the (compressed) 10 s limit passes. */
  async function run<T>(fake: Fake, call: () => Promise<T>): Promise<T> {
    return call();
  }

  it.each(transportKinds)("edit succeeds with no WebSocket opened (%s)", async (ws) => {
    const fake = startFake({ ws, stored: new Map([["ui_1", { ...base, id: "ui_1" }]]) });
    const r = expectOk(await callTool("upsert_automation", { id: "ui_1", config: base }));
    expect(fake.wsOpened).toBe(0);
    expect(warningCodes(r)).not.toContain("registry_check_unavailable");
  });

  it.each(transportKinds)("a new caller-supplied id is refused with no POST and no states read (%s)", async (ws) => {
    const fake = startFake({ ws });
    const r = await run(fake, () => callTool("upsert_automation", { id: "brand_new", config: base }));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("registry_check_unavailable");
    expect(r.text).toMatch(/omit `id` to create a new automation/i);
    expect(r.text).toMatch(/get_automation/);
    expect(r.text).toMatch(/Stage: before_write/);
    await settled(fake);
    expect(fake.posts()).toHaveLength(0);
    expect(fake.calls()).not.toContain("GET /api/states");
  });

  it.each(transportKinds)("a generated id succeeds on the states check alone, with the warning (%s)", async (ws) => {
    const fake = startFake({ ws });
    const r = expectOk(await run(fake, () => callTool("upsert_automation", { config: base })));
    expect(warningCodes(r)).toContain("registry_check_unavailable");
    expect(r.json.entity_id).toMatch(/^automation\./);
    expect(fake.posts()).toHaveLength(1);
    expect(fake.calls()).toContain("GET /api/states");
    await settled(fake);
  });

  it.each(transportKinds)("a delete succeeds with lost_registry_metadata null and the warning (%s)", async (ws) => {
    const fake = startFake({ ws, stored: new Map([["ui_1", { ...base, id: "ui_1" }]]), registry: [regEntry("automation.x", "ui_1", { area_id: "kitchen" })] });
    const r = expectOk(await run(fake, () => del("ui_1")));
    expect(r.json.lost_registry_metadata).toBeNull();
    expect(warningCodes(r)).toContain("registry_check_unavailable");
    expect(r.json.deleted_config).toMatchObject({ alias: "Porch light" });
    expect(fake.calls().filter((c) => c.startsWith("DELETE"))).toHaveLength(1);
    await settled(fake);
  });

  it("opens exactly one WebSocket per create, one per call of a delete (two), and none per update", async () => {
    const fake = startFake({ stored: new Map([["ui_1", { ...base, id: "ui_1" }]]) });
    expectOk(await callTool("upsert_automation", { id: "ui_1", config: base }));
    expect(fake.wsOpened).toBe(0);
    expectOk(await callTool("upsert_automation", { config: base }));
    expect(fake.wsOpened).toBe(1);
    expectOk(await del("ui_1"));
    expect(fake.wsOpened).toBe(3);
    await settled(fake);
  });

  describe.each<WsMode>(["auth_invalid", "unauthorized"])("%s fails closed", (ws) => {
    it("in a create with a caller-supplied id", async () => {
      const fake = startFake({ ws });
      const r = await callTool("upsert_automation", { id: "brand_new", config: base });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/revoked/);
      expect(r.text).toMatch(/administrator/);
      expect(r.text).toMatch(/local-only/);
      expect(r.text).toMatch(/Nothing was retried/);
      await settled(fake);
      expect(fake.posts()).toHaveLength(0);
      expect(fake.wsOpened).toBe(1);
      expect(fake.calls().filter((c) => c === "GET /api/websocket")).toHaveLength(1);
    });

    it("in a create with a generated id", async () => {
      const fake = startFake({ ws });
      const r = await callTool("upsert_automation", { config: base });
      expect(r.isError).toBe(true);
      await settled(fake);
      expect(fake.posts()).toHaveLength(0);
      expect(fake.calls()).not.toContain("GET /api/states");
      expect(fake.calls().filter((c) => c === "GET /api/websocket")).toHaveLength(1);
    });

    it("in a delete: no DELETE is sent", async () => {
      const fake = startFake({ ws, stored: new Map([["ui_1", { ...base, id: "ui_1" }]]) });
      const r = await del("ui_1");
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Stage: before_delete/);
      await settled(fake);
      expect(fake.calls().some((c) => c.startsWith("DELETE"))).toBe(false);
      expect(fake.stored.has("ui_1")).toBe(true);
      expect(fake.calls().filter((c) => c === "GET /api/websocket")).toHaveLength(1);
    });
  });
});

describe("upsert_automation: failures by stage", () => {
  const prev = { ...base, id: "ui_1", alias: "Previous alias" };
  const prevJson = JSON.stringify(prev);

  it("a 401 on the first config read stops the call with the credentials hint and no further request", async () => {
    const fake = startFake();
    fake.override = () => Response.json({ message: "Unauthorized" }, { status: 401 });
    const r = await callTool("upsert_automation", { id: "ui_1", config: base });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/HTTP 401/);
    expect(r.text).toMatch(/administrator/);
    expect(r.text).toMatch(/Stage: before_write/);
    expect(spy.requests).toHaveLength(1);
  });

  it.each([[500], [503]])("any other config read status (%i) stops before the write, with HA's status", async (status) => {
    const fake = startFake();
    fake.override = () => Response.json({ message: "corrupt automations.yaml" }, { status });
    const r = await callTool("upsert_automation", { id: "ui_1", config: base });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`HTTP ${status}`);
    expect(r.text).toMatch(/Nothing was changed/);
    expect(spy.requests).toHaveLength(1);
  });

  it("a config read timeout is before_write and sends nothing else", async () => {
    const fake = startFake();
    fake.override = ({ request }) => new Promise<Response>((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const r = await callTool("upsert_automation", { id: "ui_1", config: base });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/did not answer within 10 s/);
    expect(r.text).toMatch(/Stage: before_write/);
    expect(fake.log).toHaveLength(1);
  });

  it("surfaces Home Assistant's own message on a 400 from the POST, as refused, with the previous config", async () => {
    const fake = startFake({ stored: new Map([["ui_1", prev]]) });
    fake.override = ({ method }) =>
      method === "POST" ? Response.json({ message: "Message malformed: extra keys not allowed @ data['bogus']" }, { status: 400 }) : undefined;
    const r = await callTool("upsert_automation", { id: "ui_1", config: { ...base, bogus: 1 } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("extra keys not allowed @ data['bogus']");
    expect(r.text).toMatch(/Stage: write_in_flight, refused/);
    expect(r.text).toMatch(/nothing was stored/);
    expect(r.text).toContain(prevJson);
    expect(fake.calls().filter((c) => c.startsWith("POST"))).toHaveLength(1);
    expect(fake.calls().filter((c) => c.startsWith("GET /api/config")).length).toBe(1);
    expect(fake.stored.get("ui_1")).toEqual(prev);
  });

  it("a 401 at the POST is refused, carries the previous config and is not retried", async () => {
    const fake = startFake({ stored: new Map([["ui_1", prev]]) });
    fake.override = ({ method }) => (method === "POST" ? Response.json({ message: "Unauthorized" }, { status: 401 }) : undefined);
    const r = await callTool("upsert_automation", { id: "ui_1", config: base });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Stage: write_in_flight, refused/);
    expect(r.text).toMatch(/administrator/);
    expect(r.text).toContain(prevJson);
    expect(fake.calls().filter((c) => c.startsWith("POST"))).toHaveLength(1);
  });

  it("a 500 at the POST (a failed file write) is unknown outcome with the previous config, the wait text, and the update branch", async () => {
    const fake = startFake({ stored: new Map([["ui_1", prev]]) });
    fake.override = ({ method }) =>
      method === "POST" ? Response.json({ message: "WriteError: No space left on device" }, { status: 500 }) : undefined;
    const r = await callTool("upsert_automation", { id: "ui_1", config: base });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("WriteError");
    expect(r.text).toMatch(/Stage: write_in_flight, outcome unknown/);
    expect(r.text).toMatch(/wait at least 30 seconds/);
    expect(r.text).toMatch(/rule of thumb, not a guarantee/);
    expect(r.text).toMatch(/get_automation/);
    expect(r.text).toMatch(/same id and config/);
    expect(r.text).toMatch(/still returns the previous config, the write did not land and the same call is safe/);
    expect(r.text).toContain(prevJson);
    expect(fake.calls().filter((c) => c.startsWith("POST"))).toHaveLength(1);
    expect(fake.calls()).toHaveLength(2);
  });

  it("a proxy 502 at the POST for a create tells the caller to create again with the same id, or without when the registry is down", async () => {
    const fake = startFake();
    fake.override = ({ method }) => (method === "POST" ? new Response("bad gateway", { status: 502 }) : undefined);
    const r = await callTool("upsert_automation", { id: "brand_new", config: base });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/outcome unknown/);
    expect(r.text).toMatch(/There was no previous config/);
    expect(r.text).toMatch(/create it again with the same id when the entity registry can be read/);
    expect(r.text).toMatch(/without `id`/);
    expect(r.text).toMatch(/Do not omit `id` before waiting and looking/);
    expect(fake.calls().filter((c) => c.startsWith("POST"))).toHaveLength(1);
    await settled(fake);
  });

  it("a timeout with the POST in flight uses the 20 s limit, reports unknown with the id and previous config, and sends nothing after", async () => {
    const fake = startFake({ stored: new Map([["ui_1", prev]]) });
    fake.override = ({ method, request }) =>
      method === "POST" ? new Promise<Response>((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted")))) : undefined;
    const r = await callTool("upsert_automation", { id: "ui_1", config: base });
    // the config read asked for 10 s, the POST for 20 s
    expect(delays.filter((d) => d >= 4000)).toEqual([10_000, 20_000]);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/did not answer within 20 s/);
    expect(r.text).toMatch(/outcome unknown for id ui_1/);
    expect(r.text).toContain(prevJson);
    expect(fake.calls()).toEqual([`GET ${configPath("ui_1")}`, `POST ${configPath("ui_1")}`]);
  });

  it("every call other than the POST uses the 10 s limit", async () => {
    startFake({ stored: new Map([["ui_1", prev]]) });
    expectOk(await callTool("upsert_automation", { id: "ui_1", config: base }));
    expect(delays.filter((d) => d >= 4000).sort()).toEqual([10_000, 10_000, 20_000]);
  });

  it("a failing re-read after the POST is write_acknowledged with the previous config and no repeat", async () => {
    const fake = startFake({ stored: new Map([["ui_1", prev]]) });
    fake.override = ({ method, nth, path }) =>
      method === "GET" && path === configPath("ui_1") && nth === 2 ? Response.json({ message: "gone" }, { status: 500 }) : undefined;
    const r = await callTool("upsert_automation", { id: "ui_1", config: base });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Stage: write_acknowledged/);
    expect(r.text).toMatch(/probably stored/);
    expect(r.text).toContain(prevJson);
    expect(fake.calls().filter((c) => c.startsWith("POST"))).toHaveLength(1);
  });

  it("a 404 re-read after the POST is write_acknowledged with the previous config", async () => {
    const fake = startFake({ stored: new Map([["ui_1", prev]]) });
    fake.override = ({ method, nth, path }) => (method === "GET" && path === configPath("ui_1") && nth === 2 ? notFound() : undefined);
    const r = await callTool("upsert_automation", { id: "ui_1", config: base });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Stage: write_acknowledged/);
    expect(r.text).toMatch(/deleted it or it is stored under another key/);
    expect(r.text).toContain(prevJson);
  });
});

describe("upsert_automation: confirmation", () => {
  it("returns the re-read config, not the sent one", async () => {
    const fake = startFake();
    fake.override = ({ method, nth, path }) =>
      method === "GET" && path === configPath("ui_1") && nth === 2 ? Response.json({ alias: "As stored", triggers: [], actions: [], id: "ui_1" }) : undefined;
    const r = expectOk(await callTool("upsert_automation", { id: "ui_1", config: base }));
    expect(r.json.config).toEqual({ alias: "As stored", triggers: [], actions: [], id: "ui_1" });
    await settled(fake);
  });

  it("finds a new automation on the third poll read", async () => {
    const fake = startFake({ visibleAfterReads: 2 });
    const r = expectOk(await callTool("upsert_automation", { id: "slow", config: base }));
    expect(r.json.entity_id).toBe("automation.slow");
    expect(r.json.state).toBe("on");
    expect(warningCodes(r)).toEqual(["automations_file_rewritten"]);
    // guard read + three poll reads
    expect(fake.calls().filter((c) => c === "GET /api/states")).toHaveLength(4);
    expect(delays).toContain(4000);
    await settled(fake);
  });

  it("warns `unavailable` when the new entity loaded as unavailable", async () => {
    const fake = startFake();
    fake.override = ({ path, nth }) =>
      path === "/api/states" && nth >= 2
        ? Response.json([autoState("automation.bp_missing2", "bp_missing2", "unavailable")])
        : undefined;
    const r2 = expectOk(await callTool("upsert_automation", { id: "bp_missing2", config: { alias: "x", use_blueprint: { path: "m.yaml", input: {} } } }));
    expect(r2.json.state).toBe("unavailable");
    expect(r2.json.entity_id).toBe("automation.bp_missing2");
    expect(warningCodes(r2)).toContain("unavailable");
    await settled(fake);
  });

  it("after six reads with no match reports entity_not_found, the stored note, and keeps the result a success", async () => {
    const fake = startFake({ visibleAfterReads: 99 });
    const r = expectOk(await callTool("upsert_automation", { id: "never", config: base }));
    expect(r.json.entity_id).toBeNull();
    expect(r.json.state).toBeNull();
    expect(warningCodes(r)).toContain("entity_not_found");
    expect(r.json.note).toContain("The automation is stored; do not create it again");
    expect(r.json.note).toContain("check_config");
    expect(r.json.note).toMatch(/not\s+included by Home Assistant's configuration/);
    expect(r.json.note).toContain("a configuration error elsewhere can stop the reload");
    // guard read + six poll reads, and no seventh
    expect(fake.calls().filter((c) => c === "GET /api/states")).toHaveLength(7);
    // five one-second gaps between the six poll reads, so the reads are not back to back
    expect(delays.filter((d) => d === 1000)).toHaveLength(5);
    await settled(fake);
  });

  it.each([
    ["a 502", () => Response.json({ message: "bad gateway" }, { status: 502 }), /HTTP 502/],
    ["a 401", () => Response.json({ message: "Unauthorized" }, { status: 401 }), /HTTP 401/],
    ["a network failure", () => { throw new TypeError("connection reset"); }, /could not reach Home Assistant/],
  ])("a poll read failing with %s gives state_unconfirmed and no further read", async (_name, answer, text) => {
    const fake = startFake();
    fake.override = ({ path, nth }) => (path === "/api/states" && nth >= 2 ? (answer as () => Response)() : undefined);
    const r = expectOk(await callTool("upsert_automation", { id: "polled", config: base }));
    expect(r.json.entity_id).toBeNull();
    expect(warningCodes(r)).toContain("state_unconfirmed");
    expect(r.json.warnings.find((w: Json) => w.code === "state_unconfirmed").message).toMatch(text);
    expect(fake.calls().filter((c) => c === "GET /api/states")).toHaveLength(2);
    expect(fake.stored.has("polled")).toBe(true);
    await settled(fake);
  });

  it("an update makes no states read and carries the reload note", async () => {
    const fake = startFake({ stored: new Map([["ui_1", { ...base, id: "ui_1" }]]) });
    const r = expectOk(await callTool("upsert_automation", { id: "ui_1", config: base }));
    expect(fake.calls()).not.toContain("GET /api/states");
    expect(r.json.note).toContain("a configuration error elsewhere can stop the reload");
    expect(r.json.note).toContain("check_config");
    expect(r.json.note).toMatch(/list_automations/);
  });

  it("limits the steps after an acknowledged write to the overall budget, shortening the re-read", async () => {
    const fake = startFake({ stored: new Map([["ui_1", { ...base, id: "ui_1" }]]) });
    let clock = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    fake.beforePost = () => {
      clock += 50_000; // a slow pre-write phase and POST
    };
    expectOk(await callTool("upsert_automation", { id: "ui_1", config: base }));
    expect(delays.filter((d) => d >= 4000)).toEqual([10_000, 20_000, 5_000]);
  });

  it("starts no poll read more than 5 s after the first, however slow the reads are, and reports not found", async () => {
    const fake = startFake({ visibleAfterReads: 99 });
    let clock = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    // each poll read succeeds but takes 3.5 s (the guard's read is the first states read)
    fake.override = ({ path, nth }) => {
      if (path === "/api/states" && nth >= 2) clock += 3_500;
      return undefined;
    };
    const r = expectOk(await callTool("upsert_automation", { id: "slowpoll", config: base }));
    // the mocked clock advances only during reads, so reads start at 0 s and 3.5 s; the third would start at 7 s, after the 5 s window
    expect(fake.calls().filter((c) => c === "GET /api/states")).toHaveLength(1 + 2);
    expect(warningCodes(r)).toContain("entity_not_found");
    expect(r.json.note).toContain("do not create it again");
    await settled(fake);
  });

  it("gives each poll read the smaller of 4 s and the time left in the budget", async () => {
    const fake = startFake({ visibleAfterReads: 99 });
    let clock = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    fake.beforePost = () => {
      clock += 52_500; // 2.5 s of the 55 s budget left
    };
    const before = delays.length;
    expectOk(await callTool("upsert_automation", { id: "tight", config: base }));
    const after = delays.slice(before);
    expect(after.filter((d) => d === 2_500).length).toBeGreaterThanOrEqual(2); // the re-read and each poll read
    expect(after).not.toContain(4_000);
    await settled(fake);
  });

  it("adds a note when the poll ends as state_unconfirmed", async () => {
    const fake = startFake();
    fake.override = ({ path, nth }) => (path === "/api/states" && nth >= 2 ? Response.json({ message: "bad gateway" }, { status: 502 }) : undefined);
    const r = expectOk(await callTool("upsert_automation", { id: "unconf", config: base }));
    expect(warningCodes(r)).toContain("state_unconfirmed");
    expect(r.json.note).toMatch(/stored; do not create it again/);
    expect(r.json.entity_id).toBeNull();
    await settled(fake);
  });

  it("skips the poll, reporting state_unconfirmed, when the budget is used up after the write", async () => {
    const fake = startFake();
    let clock = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    fake.beforePost = () => {
      clock += 56_000;
    };
    const r = expectOk(await callTool("upsert_automation", { id: "late", config: base }));
    expect(r.json.entity_id).toBeNull();
    expect(warningCodes(r)).toContain("state_unconfirmed");
    // the guard's read is the only states read; the re-read got the minimum step
    expect(fake.calls().filter((c) => c === "GET /api/states")).toHaveLength(1);
    expect(delays).toContain(1_000);
    await settled(fake);
  });
});

describe("upsert_automation: results and undo", () => {
  it("returns compact JSON with keys in the documented order, previous_config before config, and the rewrite warning", async () => {
    const fake = startFake({ stored: new Map([["ui_1", { ...base, id: "ui_1", alias: "Before" }]]) });
    const r = expectOk(await callTool("upsert_automation", { id: "ui_1", config: base }));
    expect(Object.keys(r.json)).toEqual(["id", "previous_config", "config", "entity_id", "state", "warnings", "note"]);
    expect(r.text).toBe(JSON.stringify(r.json));
    expect(r.text.indexOf('"previous_config"')).toBeLessThan(r.text.indexOf('"config"'));
    expect(warningCodes(r)).toContain("automations_file_rewritten");
    expect(fake.stored.get("ui_1")).toMatchObject({ alias: "Porch light" });
  });

  it("undoes an update by sending previous_config with the same id, and a create by delete_automation", async () => {
    const original = { ...base, id: "ui_1", alias: "Original" };
    const fake = startFake({ stored: new Map([["ui_1", original]]) });
    const first = expectOk(await callTool("upsert_automation", { id: "ui_1", config: { ...base, alias: "Changed" } }));
    expect(fake.stored.get("ui_1")!.alias).toBe("Changed");
    expectOk(await callTool("upsert_automation", { id: "ui_1", config: first.json.previous_config }));
    expect(fake.stored.get("ui_1")).toEqual(original);

    const created = expectOk(await callTool("upsert_automation", { config: base }));
    expect(fake.stored.has(created.json.id)).toBe(true);
    const deleted = expectOk(await del(created.json.id));
    expect(fake.stored.has(created.json.id)).toBe(false);
    expect(deleted.json.deleted_config).toEqual(created.json.config);
    await settled(fake);
  });

  it("makes saves of different ids independent", async () => {
    const fake = startFake({ stored: new Map([["a", { ...base, id: "a", alias: "A" }], ["b", { ...base, id: "b", alias: "B" }]]) });
    expectOk(await callTool("upsert_automation", { id: "a", config: { ...base, alias: "Alias two" } }));
    expect(fake.stored.get("b")!.alias).toBe("B");
    expect(fake.stored.get("a")!.alias).toBe("Alias two");
  });

  it("documents the limit: an edit made between the first read and the POST is overwritten and appears in no result", async () => {
    const fake = startFake({ stored: new Map([["ui_1", { ...base, id: "ui_1", alias: "First read" }]]) });
    fake.beforePost = (f) => void f.stored.set("ui_1", { ...base, id: "ui_1", alias: "Edited in the UI meanwhile" });
    const r = expectOk(await callTool("upsert_automation", { id: "ui_1", config: { ...base, alias: "Mine" } }));
    expect(r.json.previous_config.alias).toBe("First read");
    expect(fake.stored.get("ui_1")!.alias).toBe("Mine");
    expect(r.text).not.toContain("Edited in the UI meanwhile");
  });

  it("counts subrequests per flow: eleven for a create with the poll at full length, three for an update, three for each call of a delete", async () => {
    const fake = startFake({ visibleAfterReads: 99, registry: [regEntry("automation.ui_1", "ui_1")], stored: new Map([["ui_1", { ...base, id: "ui_1" }]]) });
    spy.requests.length = 0;
    expectOk(await callTool("upsert_automation", { id: "fresh", config: base }));
    expect(spy.requests).toHaveLength(11);
    spy.requests.length = 0;
    expectOk(await callTool("upsert_automation", { id: "ui_1", config: base }));
    expect(spy.requests).toHaveLength(3);
    spy.requests.length = 0;
    const first = await requestDelete("ui_1");
    expect(first.json.status).toBe("confirmation_required");
    expect(spy.requests).toHaveLength(3);
    const code = await lastCode(spy);
    spy.requests.length = 0;
    expectOk(await finishDelete("ui_1", first.json.challenge, code));
    expect(spy.requests).toHaveLength(3);
    await settled(fake);
  });

  it("makes the calls in the documented order for create, update and delete", async () => {
    const fake = startFake({ stored: new Map([["ui_1", { ...base, id: "ui_1" }]]), registry: [regEntry("automation.ui_1", "ui_1")] });
    expectOk(await callTool("upsert_automation", { id: "fresh", config: base }));
    expect(fake.calls()).toEqual([
      `GET ${configPath("fresh")}`,
      "GET /api/websocket",
      "GET /api/states",
      `POST ${configPath("fresh")}`,
      `GET ${configPath("fresh")}`,
      "GET /api/states",
    ]);
    fake.log.length = 0;
    const first = await requestDelete("ui_1");
    expect(fake.calls()).toEqual([`GET ${configPath("ui_1")}`, "GET /api/websocket", "POST /api/services/notify/mobile_app_phone"]);
    const code = await lastCode(spy);
    fake.log.length = 0;
    expectOk(await finishDelete("ui_1", first.json.challenge, code));
    expect(fake.calls()).toEqual([`GET ${configPath("ui_1")}`, "GET /api/websocket", `DELETE ${configPath("ui_1")}`]);
    await settled(fake);
  });
});

describe("delete_automation", () => {
  const stored: Json = { ...base, id: "ui_1" };

  it("answers a missing id with an error naming it, and sends no DELETE and opens no WebSocket", async () => {
    const fake = startFake();
    const r = await del("ghost");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("ghost");
    expect(r.text).toMatch(/not stored|No config with id/);
    expect(r.text).toMatch(/list_automations/);
    expect(fake.calls()).toEqual([`GET ${configPath("ghost")}`]);
  });

  it("returns the deleted config and every lost registry field when the entry exists", async () => {
    const entry = regEntry("automation.porch_light", "ui_1", {
      area_id: "porch",
      labels: ["outdoor"],
      categories: { automation: "cat1" },
      name: "Porch",
      icon: "mdi:lightbulb",
      disabled_by: null,
      hidden_by: "user",
      options: { conversation: { should_expose: true } },
    });
    const fake = startFake({ stored: new Map([["ui_1", stored]]), registry: [entry, regEntry("automation.other", "ui_2")] });
    const r = expectOk(await del("ui_1"));
    expect(Object.keys(r.json)).toEqual(["id", "deleted_config", "lost_registry_metadata", "warnings", "note"]);
    expect(r.json.deleted_config).toEqual(stored);
    expect(r.json.lost_registry_metadata).toEqual({
      entity_id: "automation.porch_light",
      area_id: "porch",
      labels: ["outdoor"],
      categories: { automation: "cat1" },
      name: "Porch",
      icon: "mdi:lightbulb",
      disabled_by: null,
      hidden_by: "user",
      options: { conversation: { should_expose: true } },
    });
    expect(r.json.lost_registry_metadata).not.toHaveProperty("aliases");
    expect(warningCodes(r)).toEqual(["automations_file_rewritten"]);
    expect(r.json.note).toMatch(/background/);
    expect(fake.stored.has("ui_1")).toBe(false);
    await settled(fake);
  });

  it("reports aliases only when the registry list carries them", async () => {
    startFake({ stored: new Map([["ui_1", stored]]), registry: [regEntry("automation.porch_light", "ui_1", { aliases: ["porch"] })] });
    const r = expectOk(await del("ui_1"));
    expect(r.json.lost_registry_metadata.aliases).toEqual(["porch"]);
  });

  it("reports null and a note when the automation has no registry entry", async () => {
    const fake = startFake({ stored: new Map([["ui_1", stored]]), registry: [regEntry("automation.someone_else", "ui_9")] });
    const r = expectOk(await del("ui_1"));
    expect(r.json.lost_registry_metadata).toBeNull();
    expect(r.json.note).toMatch(/no entity registry entry/);
    expect(warningCodes(r)).not.toContain("registry_check_unavailable");
    await settled(fake);
  });

  it("a 400 at the DELETE says the entry was already gone and that this call deleted nothing", async () => {
    const fake = startFake({ stored: new Map([["ui_1", stored]]) });
    fake.override = ({ method }) => (method === "DELETE" ? Response.json({ message: "Resource not found" }, { status: 400 }) : undefined);
    const r = await del("ui_1");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/already gone/);
    expect(r.text).toMatch(/deleted nothing/);
    expect(fake.calls().filter((c) => c.startsWith("DELETE"))).toHaveLength(1);
    await settled(fake);
  });

  it("a timeout at the DELETE uses the 20 s limit and gives the interrupted-delete text with deleted_config and the registry metadata", async () => {
    const fake = startFake({ stored: new Map([["ui_1", stored]]), registry: [regEntry("automation.porch_light", "ui_1", { area_id: "porch" })] });
    fake.override = ({ method, request }) =>
      method === "DELETE" ? new Promise<Response>((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted")))) : undefined;
    const r = await del("ui_1");
    // the config read and the registry read asked for 10 s, the DELETE for 20 s
    expect(delays.filter((d) => d >= 4000)).toEqual([10_000, 10_000, 20_000]);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/outcome unknown for id ui_1/);
    expect(r.text).toMatch(/wait at least 30 seconds/);
    expect(r.text).toMatch(/rule of thumb, not a guarantee/);
    expect(r.text).toContain("get_automation");
    expect(r.text).toMatch(/editable true, the delete did not happen/);
    expect(r.text).toMatch(/delete completed and nothing more is needed/);
    expect(r.text).toMatch(/restoring the deleted config is only for undoing the delete/);
    expect(r.text).toContain('automation.reload and data {"id": "ui_1"}');
    expect(r.text).toMatch(/run check_config, fix what it reports and reload again/);
    expect(r.text).toMatch(/do not reload again/);
    expect(r.text).toMatch(/registry entry/);
    expect(r.text).toMatch(/without `id`/);
    expect(r.text).toContain(JSON.stringify(stored));
    expect(r.text).toContain('"area_id":"porch"');
    expect(fake.calls().filter((c) => c.startsWith("DELETE"))).toHaveLength(1);
    await settled(fake);
  });

  it("a 500 at the DELETE is the same unknown-outcome error; a 401 is refused", async () => {
    const fake = startFake({ stored: new Map([["ui_1", stored]]) });
    fake.override = ({ method }) => (method === "DELETE" ? new Response("boom", { status: 500 }) : undefined);
    const r = await del("ui_1");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/outcome unknown/);
    expect(r.text).toContain(JSON.stringify(stored));

    fake.override = ({ method }) => (method === "DELETE" ? Response.json({ message: "Unauthorized" }, { status: 401 }) : undefined);
    const r2 = await del("ui_1");
    expect(r2.isError).toBe(true);
    expect(r2.text).toMatch(/delete_in_flight, refused/);
    expect(r2.text).toMatch(/administrator/);
    await settled(fake);
  });

  it("a 401 on the config read stops the call: one request, no WebSocket, no DELETE", async () => {
    const fake = startFake();
    fake.override = () => Response.json({ message: "Unauthorized" }, { status: 401 });
    const r = await del("ui_1");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/HTTP 401/);
    expect(r.text).toMatch(/Stage: before_delete/);
    expect(fake.log).toHaveLength(1);
  });

  describe.each<WsMode>(["auth_invalid", "unauthorized"])("call 2 with a registry read answering %s", (ws) => {
    it("is refused before the DELETE, with the credentials hint", async () => {
      const fake = startFake({ stored: new Map([["ui_1", stored]]) });
      const { first, second } = await deleteInTwoCalls(spy, "ui_1", {
        between: () => {
          fake.log.splice(0);
          delays.length = 0;
          fake.ws = ws;
        },
      });
      expect(first.json?.status).toBe("confirmation_required");
      expect(second?.isError).toBe(true);
      expect(second?.text).toMatch(/Stage: before_delete/);
      expect(second?.text).toMatch(/revoked/);
      expect(second?.text).toMatch(/administrator/);
      expect(second?.text).toMatch(/local-only/);
      await settled(fake);
      expect(fake.calls().some((c) => c.startsWith("DELETE"))).toBe(false);
      expect(fake.stored.has("ui_1")).toBe(true);
      expect(fake.calls().filter((c) => c === "GET /api/websocket")).toHaveLength(1);
    });
  });

  it("a 401 on the config read in call 2 is refused with the credentials hint: no WebSocket, no DELETE", async () => {
    const fake = startFake({ stored: new Map([["ui_1", stored]]) });
    const { first, second } = await deleteInTwoCalls(spy, "ui_1", {
      between: () => {
        fake.log.splice(0);
        delays.length = 0;
        fake.override = () => Response.json({ message: "Unauthorized" }, { status: 401 });
      },
    });
    expect(first.json?.status).toBe("confirmation_required");
    expect(second?.isError).toBe(true);
    expect(second?.text).toMatch(/HTTP 401/);
    expect(second?.text).toMatch(/administrator/);
    expect(second?.text).toMatch(/Stage: before_delete/);
    expect(fake.log).toHaveLength(1);
    expect(fake.calls().some((c) => c.startsWith("DELETE") || c === "GET /api/websocket")).toBe(false);
    expect(fake.stored.has("ui_1")).toBe(true);
  });

  it("the interrupted-delete steps work against a fake that finished the file write but never ran the hook", async () => {
    const fake = startFake({
      stored: new Map([["ui_1", stored]]),
      registry: [regEntry("automation.porch_light", "ui_1", { area_id: "porch" })],
      states: [autoState("automation.porch_light", "ui_1")],
    });
    fake.wsConfigs["automation.porch_light"] = stored;
    fake.override = ({ method, request }) => {
      if (method === "DELETE") {
        // The file write lands, then the handler is cancelled: no answer, no hook.
        fake.stored.delete("ui_1");
        return new Promise<Response>((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      return undefined;
    };
    const failed = await del("ui_1");
    expect(failed.isError).toBe(true);
    fake.override = undefined;

    // get_automation: no file entry, but the entity is still listed, so editable false.
    const read = expectOk(await callTool("get_automation", { id: "ui_1" }));
    expect(read.json.editable).toBe(false);
    // A same-id restore is refused while the registry entry and the state remain.
    const refused = await callTool("upsert_automation", { id: "ui_1", config: stored });
    expect(refused.isError).toBe(true);
    // The reload with the id stops it; the registry entry leaves an unavailable state.
    expectOk(await callTool("call_service", { domain: "automation", service: "reload", data: { id: "ui_1" } }));
    expect(fake.states.find((s) => s.attributes.id === "ui_1")!.state).toBe("unavailable");
    // A restore without an id creates a copy under a new id.
    const copy = expectOk(await callTool("upsert_automation", { config: stored }));
    expect(copy.json.id).not.toBe("ui_1");
    expect(fake.stored.has(copy.json.id)).toBe(true);
    await settled(fake);
  });
});

describe("registration", () => {
  it("registers both tools as destructive and not read-only, with the documented description text", async () => {
    const tools = await listTools();
    const upsert = tools.find((t) => t.name === "upsert_automation")!;
    const del = tools.find((t) => t.name === "delete_automation")!;
    for (const t of [upsert, del]) {
      expect(t.annotations?.destructiveHint).toBe(true);
      expect(t.annotations?.readOnlyHint).toBe(false);
      expect(t.annotations?.openWorldHint).toBe(false);
    }
    expect(upsert.description).toMatch(/omit `id` to create a new\s+automation/);
    expect(upsert.description).toMatch(/REPLACES/);
    expect(upsert.description).toMatch(/previous_config/);
    expect(upsert.description).toMatch(/Undo an update/);
    expect(upsert.description).toMatch(/YAML packages/);
    expect(upsert.description).toMatch(/wait, read the automation with\s+get_automation/);
    expect(del.description).toMatch(/area, labels, categories, name, voice-assistant options, aliases/);
    expect(del.description).toMatch(/30 days/);
    expect(del.description).toMatch(/lost_registry_metadata/);
  });

  it("lists exactly fifteen tools", async () => {
    expect(await listTools()).toHaveLength(15);
  });
});
