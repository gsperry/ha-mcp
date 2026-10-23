import { describe, expect, it, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import { installFetchSpy } from "../helpers/fetch";
import { callTool, listTools, type ToolReply } from "../helpers/mcp";

type Msg = Record<string, unknown>;
type Reply = Msg | "silence";

const spy = installFetchSpy();

const ok = (id: unknown, result: unknown = null): Msg => ({ id, type: "result", success: true, result });
const fail = (id: unknown, code: string, message: string): Msg => ({
  id,
  type: "result",
  success: false,
  error: { code, message },
});

const item = (url_path: string, mode: string | null = "storage"): Msg => ({
  id: url_path.replace(/-/g, "_"),
  url_path,
  title: url_path,
  icon: "mdi:view-dashboard",
  show_in_sidebar: true,
  require_admin: false,
  ...(mode === null ? {} : { mode }),
});

interface Ha {
  /** Everything the server under test sent, parsed, in order. */
  received: Msg[];
  /** Commands only (no auth message). */
  commands: () => Msg[];
  closed: () => boolean;
  reply: (m: Msg) => void;
  /** Sends a message after a delay, from inside the server's own context (the test's context cannot use the socket). */
  later: (m: Msg, ms: number) => void;
  /** Closes the server end of the socket, as Home Assistant going away would. */
  close: () => void;
  /** The simulated stored configs, by dashboard key (`default` for the unlisted default). */
  stored: Record<string, unknown>;
}

interface HaOptions {
  dashboards?: Msg[];
  stored?: Record<string, unknown>;
  authReply?: Msg;
  /** Makes the server under test's own `send` throw for a message it matches, as a closing socket does. */
  throwOnSend?: (msg: Msg) => boolean;
  /** Answers a command before the simulation does; return undefined to fall through. */
  onCommand?: (msg: Msg, ha: Ha) => Reply | Reply[] | undefined;
}

/**
 * Queues one fetch response that upgrades to a simulated Home Assistant. The socket pair is built when the
 * Worker asks for it. The simulation resolves a dashboard like Home Assistant does: a null path is `lovelace`
 * if listed, else the default; an unlisted string path answers "Unknown config specified"; nothing stored
 * answers "No config found."; a save replaces the stored config and answers an empty success.
 */
function startHa(opts: HaOptions = {}): Ha {
  const dashboards = opts.dashboards ?? [item("dashboard-kitchen")];
  const ha: Ha = {
    received: [],
    commands: () => ha.received.filter((m) => m["type"] !== "auth"),
    closed: () => false,
    reply: () => undefined,
    later: () => undefined,
    close: () => undefined,
    stored: { ...(opts.stored ?? {}) },
  };
  const keyOf = (msg: Msg): { key: string; unknown: boolean } => {
    const path = typeof msg["url_path"] === "string" ? msg["url_path"] : null;
    if (path === null) return { key: dashboards.some((d) => d["url_path"] === "lovelace") ? "lovelace" : "default", unknown: false };
    return { key: path, unknown: !dashboards.some((d) => d["url_path"] === path) };
  };

  spy.respondOnce(() => {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    let closed = false;
    const send = (m: Msg) => server.send(JSON.stringify(m));
    ha.closed = () => closed;
    ha.reply = send;
    ha.later = (m, ms) => void setTimeout(() => send(m), ms);
    ha.close = () => server.close(1011, "going away");
    server.addEventListener("close", () => {
      closed = true;
    });
    server.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data as string) as Msg;
      ha.received.push(msg);
      if (msg["type"] === "auth") {
        send(opts.authReply ?? { type: "auth_ok", ha_version: "2026.10.2" });
        return;
      }
      const custom = opts.onCommand?.(msg, ha);
      if (custom !== undefined) {
        for (const r of Array.isArray(custom) ? custom : [custom]) if (r !== "silence") send(r);
        return;
      }
      const id = msg["id"];
      if (msg["type"] === "lovelace/dashboards/list") return send(ok(id, dashboards));
      const { key, unknown } = keyOf(msg);
      if (msg["type"] === "lovelace/config") {
        if (unknown) return send(fail(id, "config_not_found", `Unknown config specified: ${String(msg["url_path"])}`));
        if (!(key in ha.stored)) return send(fail(id, "config_not_found", "No config found."));
        return send(ok(id, JSON.parse(JSON.stringify(ha.stored[key]))));
      }
      if (msg["type"] === "lovelace/config/save") {
        ha.stored[key] = msg["config"];
        return send(ok(id));
      }
      send(fail(id, "unknown_command", "Unknown command."));
    });
    queueMicrotask(() => send({ type: "auth_required", ha_version: "2026.10.2" }));
    if (opts.throwOnSend) {
      const original = client.send.bind(client);
      client.send = (data: string | ArrayBuffer | ArrayBufferView) => {
        if (typeof data === "string" && opts.throwOnSend!(JSON.parse(data) as Msg)) throw new TypeError("socket is closing");
        original(data);
      };
    }
    return new Response(null, { status: 101, webSocket: client });
  });
  return ha;
}

/** Waits for the simulated server to see the close, then a turn of the event loop so a late message would have arrived. */
async function settled(ha: Ha): Promise<void> {
  await vi.waitFor(() => expect(ha.closed()).toBe(true));
  await new Promise((r) => setTimeout(r, 50));
}

const types = (ha: Ha) => ha.commands().map((m) => m["type"]);

/** A success-path assertion that shows the tool's own message when it fails. */
function expectOk(r: ToolReply): ToolReply {
  expect(r.isError, r.text.slice(0, 500)).toBe(false);
  return r;
}

const original = { views: [{ title: "Old", path: "old", cards: [{ type: "markdown", content: "old" }] }] };
const replacement = {
  views: [
    {
      title: "Home",
      path: "home",
      cards: [{ type: "entities", entities: ["light.kitchen"], card_mod: { style: "ha-card { color: red; }" } }],
    },
  ],
};

describe("save_dashboard: target resolution and refusals", () => {
  it("saves a null path to the listed lovelace storage dashboard, sending no url_path, in order with ids 1 to 4", async () => {
    const ha = startHa({ dashboards: [item("lovelace"), item("dashboard-kitchen")], stored: { lovelace: original, "dashboard-kitchen": { views: [] } } });
    const r = expectOk(await callTool("save_dashboard", { config: replacement }));

    expect(ha.commands()).toEqual([
      { type: "lovelace/dashboards/list", id: 1 },
      { type: "lovelace/config", id: 2 },
      { type: "lovelace/config/save", id: 3, config: replacement },
      { type: "lovelace/config", id: 4 },
    ]);
    expect(ha.stored.lovelace).toEqual(replacement);
    expect(ha.stored["dashboard-kitchen"]).toEqual({ views: [] });
    expect(r.json.previous_config).toEqual(original);
    expect(r.json.config).toEqual(replacement);
    await settled(ha);
  });

  it("treats an explicit null path like an omitted one", async () => {
    const ha = startHa({ dashboards: [item("lovelace")], stored: { lovelace: original } });
    expectOk(await callTool("save_dashboard", { url_path: null, config: replacement }));
    expect(ha.commands().every((m) => !("url_path" in m))).toBe(true);
    expect(ha.stored.lovelace).toEqual(replacement);
  });

  it("saves a null path to the storage default when no lovelace item is listed", async () => {
    const ha = startHa({ dashboards: [item("dashboard-kitchen")], stored: { default: original } });
    const r = expectOk(await callTool("save_dashboard", { config: replacement }));
    expect(types(ha)).toEqual(["lovelace/dashboards/list", "lovelace/config", "lovelace/config/save", "lovelace/config"]);
    expect(ha.stored.default).toEqual(replacement);
    expect(r.json.previous_config).toEqual(original);
  });

  it("saves to a listed storage dashboard by its url_path, carrying it on every later command", async () => {
    const ha = startHa({ stored: { "dashboard-kitchen": original } });
    expectOk(await callTool("save_dashboard", { url_path: "dashboard-kitchen", config: replacement }));
    expect(ha.commands().slice(1).map((m) => m["url_path"])).toEqual(["dashboard-kitchen", "dashboard-kitchen", "dashboard-kitchen"]);
    expect(ha.stored["dashboard-kitchen"]).toEqual(replacement);
  });

  it.each([
    ["an unlisted path", "no-such-board"],
    ["the empty string", ""],
    ["lovelace when only the default exists", "lovelace"],
  ])("refuses %s as an unknown dashboard and sends nothing after the list", async (_name, url_path) => {
    const ha = startHa({ dashboards: [item("dashboard-kitchen"), item("dashboard-wall")], stored: {} });
    const r = await callTool("save_dashboard", { url_path, config: replacement });

    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Unknown dashboard/);
    expect(r.text).toContain('"dashboard-kitchen"');
    expect(r.text).toContain('"dashboard-wall"');
    expect(r.text).toMatch(/omitting url_path/);
    expect(r.text).toMatch(/before_save/);
    await settled(ha);
    expect(types(ha)).toEqual(["lovelace/dashboards/list"]);
  });

  it.each([
    ["a named yaml dashboard", "dashboard-wall", [item("dashboard-wall", "yaml")]],
    ["the legacy yaml lovelace item reached by a null path", undefined, [item("lovelace", "yaml")]],
    ["an item with an unexpected mode", "dashboard-wall", [item("dashboard-wall", "something")]],
    ["an item with no mode", "dashboard-wall", [item("dashboard-wall", null)]],
  ])("refuses %s and sends nothing after the list", async (_name, url_path, dashboards) => {
    const ha = startHa({ dashboards, stored: {} });
    const r = await callTool("save_dashboard", { ...(url_path === undefined ? {} : { url_path }), config: replacement });

    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/defined in a file/);
    expect(r.text).toMatch(/before_save/);
    await settled(ha);
    expect(types(ha)).toEqual(["lovelace/dashboards/list"]);
    expect(ha.stored).toEqual({});
  });

  it("refuses when the dashboard list is not an array of objects, and sends nothing more", async () => {
    const ha = startHa({ onCommand: (m) => (m["id"] === 1 ? ok(1, { not: "a list" }) : undefined) });
    const r = await callTool("save_dashboard", { config: replacement });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unexpected dashboard list/);
    await settled(ha);
    expect(types(ha)).toEqual(["lovelace/dashboards/list"]);

    const ha2 = startHa({ onCommand: (m) => (m["id"] === 1 ? ok(1, [item("dashboard-kitchen"), 7]) : undefined) });
    expect((await callTool("save_dashboard", { config: replacement })).isError).toBe(true);
    await settled(ha2);
    expect(types(ha2)).toEqual(["lovelace/dashboards/list"]);
  });

  it("refuses a string path whose previous read answers Unknown config specified, without sending the save", async () => {
    // The dashboard was listed, then removed before the read.
    const ha = startHa({
      onCommand: (m) => (m["id"] === 2 ? fail(2, "config_not_found", "Unknown config specified: dashboard-kitchen") : undefined),
    });
    const r = await callTool("save_dashboard", { url_path: "dashboard-kitchen", config: replacement });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no longer exists/);
    expect(r.text).toMatch(/Stage: before_save/);
    await settled(ha);
    expect(types(ha)).toEqual(["lovelace/dashboards/list", "lovelace/config"]);
  });

  it("proceeds to the save for a string path whose previous read answers No config found. (a dashboard created and never saved)", async () => {
    const ha = startHa({ stored: {} });
    const r = expectOk(await callTool("save_dashboard", { url_path: "dashboard-kitchen", config: replacement }));
    expect(types(ha)).toEqual(["lovelace/dashboards/list", "lovelace/config", "lovelace/config/save", "lovelace/config"]);
    expect(ha.stored["dashboard-kitchen"]).toEqual(replacement);
    expect(r.json.previous_config).toBeNull();
    expect(r.json.notes.join(" ")).toMatch(/never saved/);
  });
});

describe("save_dashboard: what counts as a dashboard config", () => {
  const view = { title: "A", cards: [] };
  it.each([
    ["an empty object", {}],
    ["an object with neither views nor strategy", { title: "x" }],
    ["views that is a string", { views: "a" }],
    ["views holding a non-object", { views: [1] }],
    ["a null strategy", { strategy: null }],
    ["a string strategy", { strategy: "x" }],
    ["an array strategy", { strategy: [] }],
    ["a string", "just text"],
    ["an array", [view]],
    ["views beside a null strategy", { views: [view], strategy: null }],
    ["a null views beside a valid strategy", { views: null, strategy: { type: "original-states" } }],
  ])("refuses %s before opening any connection", async (_name, config) => {
    const r = await callTool("save_dashboard", { config });
    expect(r.isError).toBe(true);
    expect(spy.requests).toHaveLength(0);
  });

  it("names the requirement when neither key is present", async () => {
    const r = await callTool("save_dashboard", { config: { title: "x" } });
    expect(r.text).toMatch(/`views` array of objects, or a `strategy` object/);
    expect(r.text).toMatch(/Nothing was sent/);
  });

  it.each([
    ["views only", { views: [view] }],
    ["an empty views array", { views: [] }],
    ["strategy only", { strategy: { type: "original-states" } }],
    ["both", { views: [view], strategy: { type: "x" } }],
  ])("accepts %s", async (_name, config) => {
    const ha = startHa({ stored: { default: original } });
    expectOk(await callTool("save_dashboard", { config }));
    expect(ha.stored.default).toEqual(config);
  });
});

describe("save_dashboard: nothing is stripped", () => {
  const rich = {
    views: [
      {
        title: "Home",
        future_view_key: { nested: [1, 2, { deep: true }] },
        badges: ["person.guy"],
        sections: [{ type: "grid", cards: [{ type: "heading", heading: "x", extra_heading_key: 1 }] }],
        cards: [
          {
            type: "custom:fancy-card",
            card_mod: { style: "ha-card { color: red; }" },
            entities: [{ entity: "light.kitchen", unknown_row_key: "keep" }],
            card: { type: "entity", unknown_inner: { a: [null, 0, false, ""] } },
          },
        ],
      },
    ],
    background: "var(--x)",
    strategy: { type: "custom:my-strategy", options: { anything: [1, "two"], nested: { flag: true } } },
    top_level_future_key: { k: "v" },
  };

  it("sends unknown keys at every level to Home Assistant unchanged and returns them in previous_config and config", async () => {
    const ha = startHa({ stored: { default: rich } });
    const r = expectOk(await callTool("save_dashboard", { config: rich }));

    const save = ha.commands().find((m) => m["type"] === "lovelace/config/save")!;
    expect(save["config"]).toEqual(rich);
    expect(ha.stored.default).toEqual(rich);
    expect(r.json.previous_config).toEqual(rich);
    expect(r.json.config).toEqual(rich);
    expect(r.json.notes).toBeUndefined();
  });

  it("keeps a strategy-only config unchanged, with no views added", async () => {
    const strategyOnly = { strategy: { type: "original-states", hide_entities: ["light.x"], future: { a: 1 } }, extra: "keep" };
    const ha = startHa({ stored: { default: strategyOnly } });
    const r = expectOk(await callTool("save_dashboard", { config: strategyOnly }));
    expect(ha.stored.default).toEqual(strategyOnly);
    expect("views" in (ha.stored.default as object)).toBe(false);
    expect(r.json.previous_config).toEqual(strategyOnly);
    expect(r.json.config).toEqual(strategyOnly);
  });

  it("leaves additionalProperties open at every level of the advertised input schema", async () => {
    const tool = (await listTools()).find((t) => t.name === "save_dashboard")!;
    const closed: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${path}[${i}]`));
      else if (node !== null && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (k === "additionalProperties" && v === false) closed.push(path);
          walk(v, `${path}.${k}`);
        }
      }
    };
    walk(tool.inputSchema, "inputSchema");
    expect(closed).toEqual([]);
    // The config itself must accept other keys, not merely avoid forbidding them.
    const config = tool.inputSchema.properties.config;
    expect(config.type).toBe("object");
    // Loose objects advertise additionalProperties as {} (any value); a plain object leaves it unset.
    expect(config.additionalProperties).toEqual({});
    expect(config.properties.views.items.additionalProperties).toEqual({});
  });
});

describe("save_dashboard: result", () => {
  it("returns compact JSON with previous_config first and no notes when nothing needs saying", async () => {
    startHa({ stored: { default: original } });
    const r = expectOk(await callTool("save_dashboard", { config: replacement }));
    expect(r.text.startsWith('{"previous_config":')).toBe(true);
    expect(Object.keys(r.json)).toEqual(["previous_config", "config"]);
    expect(r.text).toBe(JSON.stringify(r.json));
    expect(r.text).not.toMatch(/\n| {2}/);
  });

  it("notes that no stored version exists when previous_config is null", async () => {
    startHa({ stored: {} });
    const r = expectOk(await callTool("save_dashboard", { config: replacement }));
    expect(r.json.previous_config).toBeNull();
    expect(r.json.config).toEqual(replacement);
    expect(r.json.notes).toHaveLength(1);
    const note: string = r.json.notes[0];
    for (const word of ["never saved", "missing", "corrupt", ".corrupt.", "no tool restores"]) expect(note.toLowerCase()).toContain(word.toLowerCase());
  });

  it("adds a note when the read-back config differs from what was sent", async () => {
    const edited = { views: [{ title: "Someone else edited this" }] };
    startHa({ stored: { default: original }, onCommand: (m) => (m["id"] === 4 ? ok(4, edited) : undefined) });
    const r = expectOk(await callTool("save_dashboard", { config: replacement }));
    expect(r.json.config).toEqual(edited);
    expect(r.json.previous_config).toEqual(original);
    expect(r.json.notes.join(" ")).toMatch(/not identical/);
  });

  it("reports plain success when Home Assistant answers success but kept the old file (a failed disk write is not detectable)", async () => {
    // After a failed write Home Assistant still answers success and serves the new config from memory.
    startHa({ stored: { default: original } });
    const r = expectOk(await callTool("save_dashboard", { config: replacement }));
    expect(r.json.config).toEqual(replacement);
    expect(r.json.notes).toBeUndefined();
  });

  it("returns a save's previous_config so that a second save restores the original", async () => {
    const ha = startHa({ stored: { default: original } });
    const first = expectOk(await callTool("save_dashboard", { config: replacement }));
    expect(ha.stored.default).toEqual(replacement);

    const ha2 = startHa({ stored: { default: ha.stored.default } });
    const second = expectOk(await callTool("save_dashboard", { config: first.json.previous_config }));
    expect(ha2.stored.default).toEqual(original);
    expect(second.json.previous_config).toEqual(replacement);
    expect(second.json.config).toEqual(original);
  });

  it("tells the caller to keep a copy, never rebuild from a truncated read, and treat a missing result as possibly applied", async () => {
    const tool = (await listTools()).find((t) => t.name === "save_dashboard")!;
    expect(tool.description).toMatch(/Keep your own get_dashboard copy until the save is confirmed/);
    expect(tool.description).toMatch(/never rebuild a config from a read that looks truncated/);
    expect(tool.description).toMatch(/treat a missing result as possibly applied/);
    expect(tool.description).toMatch(/4 MiB/);
    expect(tool.description).toMatch(/Last write wins/);
  });
});

describe("save_dashboard: ordering", () => {
  it("does not send the save until the previous read's result arrives", async () => {
    const ha = startHa({
      stored: { default: original },
      onCommand: (m, h) => {
        if (m["id"] !== 2) return undefined;
        // Home Assistant is slow to answer the previous read.
        h.later(ok(2, original), 400);
        return "silence";
      },
    });
    const pending = callTool("save_dashboard", { config: replacement });
    await vi.waitFor(() => expect(ha.commands()).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 200));
    expect(types(ha)).toEqual(["lovelace/dashboards/list", "lovelace/config"]);

    expectOk(await pending);
    expect(types(ha)).toEqual(["lovelace/dashboards/list", "lovelace/config", "lovelace/config/save", "lovelace/config"]);
  });

  it("carries on after config_not_found on the previous read", async () => {
    const ha = startHa({ stored: {} });
    expectOk(await callTool("save_dashboard", { config: replacement }));
    expect(types(ha)).toEqual(["lovelace/dashboards/list", "lovelace/config", "lovelace/config/save", "lovelace/config"]);
  });

  it("stops at a config_not_found answer to the save and does not re-read", async () => {
    const ha = startHa({
      stored: { default: original },
      onCommand: (m) => (m["id"] === 3 ? fail(3, "config_not_found", "Unknown config specified: x") : undefined),
    });
    const r = await callTool("save_dashboard", { config: replacement });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Stage: save_in_flight/);
    expect(r.text).toMatch(/nothing was changed/);
    await settled(ha);
    expect(types(ha)).toEqual(["lovelace/dashboards/list", "lovelace/config", "lovelace/config/save"]);
  });
});

describe("save_dashboard: failures say how far the call got", () => {
  const previousJson = JSON.stringify(original);

  it("reports auth_invalid as before_save, names the causes, and sends no command", async () => {
    const ha = startHa({ authReply: { type: "auth_invalid", message: "Invalid access token" } });
    const r = await callTool("save_dashboard", { config: replacement });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/revoked/);
    expect(r.text).toMatch(/local-only/);
    expect(r.text).toMatch(/Stage: before_save/);
    expect(r.text).not.toContain((env as unknown as { HA_TOKEN: string }).HA_TOKEN);
    await settled(ha);
    expect(ha.commands()).toHaveLength(0);
    expect(spy.requests).toHaveLength(1);
  });

  it("reports a failed upgrade as before_save", async () => {
    spy.respondOnce(() => new Response("nope", { status: 502 }));
    const r = await callTool("save_dashboard", { config: replacement });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/did not upgrade/);
    expect(r.text).toMatch(/Stage: before_save/);
  });

  it("reports a list failure with unknown_command as before_save and hints at recovery mode", async () => {
    const ha = startHa({ onCommand: (m) => (m["id"] === 1 ? fail(1, "unknown_command", "Unknown command.") : undefined) });
    const r = await callTool("save_dashboard", { config: replacement });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown_command/);
    expect(r.text).toMatch(/recovery mode/);
    expect(r.text).toMatch(/Stage: before_save/);
    await settled(ha);
    expect(types(ha)).toEqual(["lovelace/dashboards/list"]);
  });

  it("reports a previous-read error other than config_not_found as before_save, without sending the save", async () => {
    const ha = startHa({ onCommand: (m) => (m["id"] === 2 ? fail(2, "error", "disk on fire") : undefined) });
    const r = await callTool("save_dashboard", { config: replacement });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("disk on fire");
    expect(r.text).toMatch(/Stage: before_save/);
    await settled(ha);
    expect(types(ha)).toEqual(["lovelace/dashboards/list", "lovelace/config"]);
  });

  it("reports a timeout during the previous read as before_save and sends no save", async () => {
    const ha = startHa({ stored: { default: original }, onCommand: (m) => (m["id"] === 2 ? "silence" : undefined) });
    const r = await callTool("save_dashboard", { config: replacement });

    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/timed out/);
    expect(r.text).toMatch(/Stage: before_save/);
    expect(r.text).toMatch(/no save was sent/);
    await settled(ha);
    expect(types(ha)).toEqual(["lovelace/dashboards/list", "lovelace/config"]);
  }, 20_000);

  it("reports unauthorized on the save as save_in_flight, nothing changed, with the previous config and no re-read", async () => {
    const ha = startHa({
      stored: { default: original },
      onCommand: (m) => (m["id"] === 3 ? fail(3, "unauthorized", "Unauthorized") : undefined),
    });
    const r = await callTool("save_dashboard", { config: replacement });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Unauthorized");
    expect(r.text).toMatch(/administrator/);
    expect(r.text).toMatch(/Stage: save_in_flight/);
    expect(r.text).toMatch(/nothing was changed/);
    expect(r.text).toContain(previousJson);
    await settled(ha);
    expect(types(ha)).toEqual(["lovelace/dashboards/list", "lovelace/config", "lovelace/config/save"]);
    expect(ha.stored.default).toEqual(original);
  });

  it("reports another error answer to the save as unknown outcome, with Home Assistant's message and the previous config", async () => {
    const ha = startHa({
      stored: { default: original },
      onCommand: (m) => (m["id"] === 3 ? fail(3, "error", "Something odd happened") : undefined),
    });
    const r = await callTool("save_dashboard", { config: replacement });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Something odd happened");
    expect(r.text).toMatch(/Stage: save_in_flight/);
    expect(r.text).toMatch(/not known/);
    expect(r.text).toMatch(/get_dashboard/);
    expect(r.text).toContain(previousJson);
    await settled(ha);
    expect(types(ha)).toHaveLength(3);
  });

  it("says no config was stored when the save fails after a previous read of config_not_found", async () => {
    startHa({ stored: {}, onCommand: (m) => (m["id"] === 3 ? fail(3, "error", "bad") : undefined) });
    const r = await callTool("save_dashboard", { config: replacement });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/No config was stored for this dashboard before the save/);
  });

  it("reports a timeout after the previous read as save_in_flight, unknown whether applied, sending the save once", async () => {
    const ha = startHa({ stored: { default: original }, onCommand: (m) => (m["id"] === 3 ? "silence" : undefined) });
    const r = await callTool("save_dashboard", { config: replacement });

    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/timed out/);
    expect(r.text).toMatch(/Stage: save_in_flight/);
    expect(r.text).toMatch(/unknown/);
    expect(r.text).toContain(previousJson);
    await settled(ha);
    expect(types(ha)).toEqual(["lovelace/dashboards/list", "lovelace/config", "lovelace/config/save"]);
  }, 20_000);

  it("reports a save that cannot be sent as save_in_flight, promptly, unknown whether applied, with the previous config", async () => {
    const ha = startHa({ stored: { default: original }, throwOnSend: (m) => m["type"] === "lovelace/config/save" });
    const started = Date.now();
    const r = await callTool("save_dashboard", { config: replacement });

    // Well under the 10 s time limit.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Sending to the Home Assistant WebSocket failed/);
    expect(r.text).toMatch(/Stage: save_in_flight/);
    expect(r.text).toMatch(/unknown/);
    expect(r.text).toContain(previousJson);
    await settled(ha);
    expect(types(ha)).toEqual(["lovelace/dashboards/list", "lovelace/config"]);
    expect(ha.stored["default"]).toEqual(original);
  }, 20_000);

  it("reports a close after the previous read as save_in_flight with the previous config, without a second attempt", async () => {
    const ha = startHa({
      stored: { default: original },
      onCommand: (m, h) => {
        if (m["id"] !== 3) return undefined;
        h.close();
        return "silence";
      },
    });
    const r = await callTool("save_dashboard", { config: replacement });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/closed the WebSocket/);
    expect(r.text).toMatch(/Stage: save_in_flight/);
    expect(r.text).toMatch(/unknown/);
    expect(r.text).toContain(previousJson);
    await settled(ha);
    expect(types(ha)).toEqual(["lovelace/dashboards/list", "lovelace/config", "lovelace/config/save"]);
  });

  it("reports a failed re-read as saved, with the previous config", async () => {
    const ha = startHa({
      stored: { default: original },
      onCommand: (m) => (m["id"] === 4 ? fail(4, "error", "cannot read back") : undefined),
    });
    const r = await callTool("save_dashboard", { config: replacement });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("cannot read back");
    expect(r.text).toMatch(/Stage: saved/);
    expect(r.text).toMatch(/probably holds the new config/);
    expect(r.text).toContain(previousJson);
    expect(ha.stored.default).toEqual(replacement);
    await settled(ha);
    expect(types(ha)).toHaveLength(4);
  });
});

describe("save_dashboard: size", () => {
  const bigView = (bytes: number) => ({ views: [{ title: "Big", padding: "x".repeat(bytes) }] });

  it("saves a config just under the 4 MiB request cap through the request path", async () => {
    const config = bigView(3_900_000);
    const ha = startHa({ stored: { default: original } });
    const res = await SELF.fetch("https://worker.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${(env as unknown as { MCP_BEARER_TOKEN: string }).MCP_BEARER_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "save_dashboard", arguments: { config } } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(body.result.isError).not.toBe(true);
    expect(body.result.content[0]!.text.startsWith('{"previous_config":')).toBe(true);
    expect((ha.stored.default as any).views[0].padding).toHaveLength(3_900_000);
  }, 30_000);

  it("answers 413 for a body over the cap and runs no tool", async () => {
    const config = bigView(4_300_000);
    const res = await SELF.fetch("https://worker.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${(env as unknown as { MCP_BEARER_TOKEN: string }).MCP_BEARER_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "save_dashboard", arguments: { config } } }),
    });
    expect(res.status).toBe(413);
    expect(spy.requests).toHaveLength(0);
  });
});

describe("get_dashboard", () => {
  it("returns a strategy-only config exactly as stored, with no views added", async () => {
    const strategyOnly = { strategy: { type: "original-states", future: [1, { a: null }] }, x_key: "keep" };
    const ha = startHa({ stored: { default: strategyOnly } });
    const r = expectOk(await callTool("get_dashboard"));
    expect(r.json).toEqual(strategyOnly);
    expect(ha.commands()).toEqual([{ type: "lovelace/config", id: 1 }]);
    await settled(ha);
  });

  it("returns a views config with unknown keys unchanged and sends a string url_path", async () => {
    const ha = startHa({ stored: { "dashboard-kitchen": replacement } });
    const r = expectOk(await callTool("get_dashboard", { url_path: "dashboard-kitchen" }));
    expect(r.json).toEqual(replacement);
    expect(ha.commands()).toEqual([{ type: "lovelace/config", id: 1, url_path: "dashboard-kitchen" }]);
  });

  it("maps config_not_found to a message naming every cause", async () => {
    startHa({ stored: {} });
    const r = await callTool("get_dashboard");
    expect(r.isError).toBe(true);
    for (const cause of ["does not exist", "never saved", "auto-generated", "YAML file is missing", "corrupt", "recovery mode"]) {
      expect(r.text).toContain(cause);
    }
  });

  it("surfaces another Home Assistant error with its code and message", async () => {
    startHa({ onCommand: (m) => fail(m["id"], "home_assistant_error", "Lovelace is unhappy") });
    const r = await callTool("get_dashboard");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("home_assistant_error");
    expect(r.text).toContain("Lovelace is unhappy");
  });
});

describe("list_dashboards", () => {
  it("returns the list items as they are, with the default-dashboard note", async () => {
    const items = [item("dashboard-kitchen"), item("dashboard-wall", "yaml")];
    const ha = startHa({ dashboards: items });
    const r = expectOk(await callTool("list_dashboards"));
    expect(r.json.dashboards).toEqual(items);
    expect(r.json.note).toMatch(/default dashboard is listed only once it has a stored config/);
    expect(ha.commands()).toEqual([{ type: "lovelace/dashboards/list", id: 1 }]);
  });

  it("surfaces a Home Assistant error with its message", async () => {
    startHa({ onCommand: (m) => fail(m["id"], "unknown_command", "Unknown command.") });
    const r = await callTool("list_dashboards");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("unknown_command");
    expect(r.text).toContain("Unknown command.");
  });

  it("reports a list that is not an array", async () => {
    startHa({ onCommand: (m) => ok(m["id"], { nope: 1 }) });
    const r = await callTool("list_dashboards");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/something other than a list/);
  });
});

describe("save_dashboard: Home Assistant error answer", () => {
  it("surfaces Home Assistant's message when the save is refused", async () => {
    startHa({
      stored: { default: original },
      onCommand: (m) => (m["id"] === 3 ? fail(3, "error", "Config has views the frontend cannot parse") : undefined),
    });
    const r = await callTool("save_dashboard", { config: replacement });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Config has views the frontend cannot parse");
  });
});
