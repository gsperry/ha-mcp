import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFetchSpy } from "../helpers/fetch";
import { callTool } from "../helpers/mcp";
import { PLATFORMS, refusedText, startPolicyFake, type FakeOptions, type Msg } from "../helpers/policy-fake";

const spy = installFetchSpy();

const call = (domain: string, service: string, data?: Record<string, unknown>) => callTool("call_service", { domain, service, data });
const POST = (domain: string, service: string) => `POST /api/services/${domain}/${service}`;
const sets = (members: string[], extra: Msg = {}) => ({ entity_id: "x", state: "on", attributes: { entity_id: members, ...extra } });
const restart = { action: "homeassistant.restart" };

function house(extra: Partial<FakeOptions> = {}) {
  return startPolicyFake(spy, { platforms: { ...PLATFORMS }, ...extra });
}

describe("classification by platform", () => {
  it("allows a light of an ordinary platform, after one entity/source command, then sends the call", async () => {
    const fake = house();
    const r = await call("light", "turn_on", { entity_id: "light.kitchen", brightness: 100 });
    expect(r.isError, r.text).toBe(false);
    expect(fake.types()).toEqual(["entity/source"]);
    expect(fake.opened).toBe(1);
    expect(fake.closed).toBe(1);
    expect(fake.acting).toEqual([POST("light", "turn_on")]);
    expect(fake.bodies).toEqual([{ entity_id: "light.kitchen", brightness: 100 }]);
  });

  it("classifies by the platform key, not by the entity's own domain", async () => {
    // switch.shell is a template switch; only the platform says so.
    const fake = house();
    const text = refusedText(await call("switch", "turn_on", { entity_id: "switch.shell" }));
    expect(text).toContain("switch.shell");
    expect(text).toContain("template");
    expect(fake.acting).toEqual([]);
  });

  it.each(["template", "command_line", "universal", "wake_on_lan", "panasonic_viera", "hassio", "portainer", "proxmoxve"])(
    "refuses an entity of platform %s, naming the entity and the platform",
    async (platform) => {
      const fake = house({ platforms: { ...PLATFORMS, "switch.denied": platform } });
      const text = refusedText(await call("switch", "turn_off", { entity_id: "switch.denied" }));
      expect(text).toContain("switch.denied");
      expect(text).toContain(platform);
      expect(fake.acting).toEqual([]);
    },
  );

  it("refuses even a harmless call on a denied platform: the platform is the unit", async () => {
    const fake = house();
    refusedText(await call("media_player", "volume_set", { entity_id: "media_player.viera", volume_level: 0.2 }));
    refusedText(await call("switch", "turn_on", { entity_id: "switch.wol" }));
    expect(fake.acting).toEqual([]);
  });

  it("classifies a YAML-defined entity by its platform, and an entity with no source is refused", async () => {
    const fake = house({ platforms: { ...PLATFORMS, "light.yaml_only": "mqtt" } });
    expect((await call("light", "turn_on", { entity_id: "light.yaml_only" })).isError).toBe(false);
    const text = refusedText(await call("light", "turn_on", { entity_id: "light.misspelt" }));
    expect(text).toContain("light.misspelt");
    expect(text).toContain("not an entity");
    expect(fake.acting).toEqual([POST("light", "turn_on")]);
  });

  it("reads entity ids written in any case, padded, in a list or as comma text", async () => {
    for (const entity_id of ["Switch.Shell", " switch.shell ", ["light.kitchen", "SWITCH.SHELL"], "light.kitchen, Switch.Shell"]) {
      const fake = house();
      refusedText(await call("switch", "turn_on", { entity_id }));
      expect(fake.acting, JSON.stringify(entity_id)).toEqual([]);
    }
  });

  it("refuses an unknown piece of a list even when another piece is fine", async () => {
    const fake = house();
    refusedText(await call("light", "turn_on", { entity_id: ["light.kitchen", "light.nope"] }));
    expect(fake.acting).toEqual([]);
  });

  it("refuses a registry id as a target, advising the entity id", async () => {
    const fake = house();
    const text = refusedText(await call("light", "turn_on", { entity_id: "0123456789abcdef0123456789abcdef" }));
    expect(text).toContain("registry id");
    expect(text).toContain("entity id");
    expect(fake.acting).toEqual([]);
  });

  it("ignores a string that merely looks like an entity id and is not known, outside the target keys", async () => {
    const fake = house();
    const r = await call("persistent_notification", "create", { message: "light.not_real" });
    expect(r.isError, r.text).toBe(false);
    expect(fake.acting).toHaveLength(1);
    // It did make the call need the entity map (a string might be an entity).
    expect(fake.types()).toEqual(["entity/source"]);
  });

  it("classifies an entity named inside a nested string of the data, as every service may call into it", async () => {
    const fake = house();
    refusedText(await call("persistent_notification", "create", { message: "x", data: { deep: [{ x: "Switch.Shell" }] } }));
    expect(fake.acting).toEqual([]);
  });

  it("allows a call that names no entity and reaches nothing without opening the WebSocket", async () => {
    const fake = house();
    expect((await call("homeassistant", "reload_all")).isError).toBe(false);
    expect(fake.opened).toBe(0);
  });

  it("sends the acting request only after the check has passed", async () => {
    const fake = house();
    await call("light", "turn_on", { entity_id: "light.kitchen" });
    // The WebSocket upgrade is the first request; the service POST comes after it.
    expect(spy.requests.map((r) => new URL(r.url).pathname)).toEqual(["/api/websocket", "/api/services/light/turn_on"]);
    expect(fake.types()).toEqual(["entity/source"]);
  });
});

describe("targets Home Assistant expands", () => {
  it("expands an area with extract_from_target and expand_group true, and judges only the service's own domain", async () => {
    const fake = house({ targets: { kitchen: ["light.kitchen", "sensor.tmpl", "switch.shell"] } });
    const r = await call("light", "turn_off", { area_id: "kitchen" });
    expect(r.isError, r.text).toBe(false);
    expect(fake.types()).toEqual(["entity/source", "extract_from_target"]);
    expect(fake.commands[1]).toMatchObject({ target: { area_id: ["kitchen"] }, expand_group: true });
    expect(fake.commands[1]!.primary_entities_only).toBeUndefined();
    expect(fake.acting).toEqual([POST("light", "turn_off")]);
  });

  it.each(["area_id", "floor_id", "device_id", "label_id"])("expands %s, and a denied entity of the call's domain is refused", async (key) => {
    const fake = house({ targets: { zone: ["light.kitchen", "light.shell"] } });
    const text = refusedText(await call("light", "turn_on", { [key]: ["zone"] }));
    expect(text).toContain("light.shell");
    expect(fake.commands[1]).toMatchObject({ type: "extract_from_target", target: { [key]: ["zone"] } });
    expect(fake.acting).toEqual([]);
  });

  it("accepts the targets in a target mapping of the data and as comma text", async () => {
    const fake = house({ targets: { a: ["light.shell"] } });
    refusedText(await call("light", "turn_on", { target: { area_id: "a" } }));
    expect(fake.acting).toEqual([]);
  });

  it("acts on every resolved entity for a homeassistant call, because it forwards to each domain", async () => {
    const fake = house({ targets: { kitchen: ["light.kitchen", "switch.shell"] } });
    const text = refusedText(await call("homeassistant", "turn_off", { area_id: "kitchen" }));
    expect(text).toContain("switch.shell");
    expect(fake.acting).toEqual([]);
  });

  it("sends one extract command per call and none when the entities are plain ids", async () => {
    const fake = house({ targets: { a: ["light.kitchen"], b: ["light.desk"] } });
    await call("light", "turn_on", { area_id: ["a", "b"], floor_id: "up", entity_id: "light.kitchen" });
    expect(fake.types()).toEqual(["entity/source", "extract_from_target"]);
    expect(fake.commands[1]!.target).toEqual({ area_id: ["a", "b"], floor_id: ["up"] });
  });

  it("entity_id all means every entity of the call's domain", async () => {
    const fake = house();
    const text = refusedText(await call("switch", "turn_off", { entity_id: "all" }));
    expect(text).toContain("switch.shell");
    expect(fake.acting).toEqual([]);
    const ok = house({ platforms: { "light.a": "hue", "light.b": "hue", "switch.shell": "template" } });
    expect((await call("light", "turn_on", { entity_id: "all" })).isError).toBe(false);
    expect(ok.acting).toEqual([POST("light", "turn_on")]);
  });

  it("refuses entity_id all on a homeassistant call, as Home Assistant does, before any request", async () => {
    const fake = house();
    refusedText(await call("homeassistant", "turn_on", { entity_id: "all" }));
    expect(spy.requests).toHaveLength(0);
    expect(fake.acting).toEqual([]);
  });

  it("none acts on nothing", async () => {
    const fake = house();
    const r = await call("light", "turn_on", { entity_id: "none" });
    expect(r.isError, r.text).toBe(false);
    expect(fake.opened).toBe(0);
  });

  it("a template sensor in an area is not judged for a light call, but an old-style group is expanded by Home Assistant", async () => {
    const fake = house({
      platforms: { ...PLATFORMS, "group.rooms": "group" },
      targets: { "group.rooms": ["light.kitchen", "light.shell"] },
    });
    const text = refusedText(await call("light", "turn_on", { entity_id: "group.rooms" }));
    expect(text).toContain("light.shell");
    expect(fake.types()).toEqual(["entity/source", "extract_from_target"]);
    expect(fake.commands[1]).toMatchObject({ target: { entity_id: ["group.rooms"] }, expand_group: true });
  });

  it("filters what a named old-style group yields to the call's domain, as Home Assistant does, but not a group met in a scene", async () => {
    const options = {
      platforms: { ...PLATFORMS, "group.rooms": "group" },
      targets: { "group.rooms": ["light.kitchen", "switch.shell"] },
      states: { "scene.evening": sets(["group.rooms"]) },
    };
    const fake = house(options);
    // Home Assistant ignores the switch member of a light call, so it is not judged.
    expect((await call("light", "turn_on", { entity_id: "group.rooms" })).isError).toBe(false);
    expect(fake.acting).toEqual([POST("light", "turn_on")]);
    // A homeassistant call forwards to every member, and a scene applies every member, so the switch is judged.
    refusedText(await call("homeassistant", "turn_on", { entity_id: "group.rooms" }));
    refusedText(await call("scene", "turn_on", { entity_id: "scene.evening" }));
    expect(fake.acting).toEqual([POST("light", "turn_on")]);
  });
});

describe("forwarding groups", () => {
  const groupHouse = (members: Record<string, string[]>, extra: Partial<FakeOptions> = {}) =>
    house({
      platforms: {
        ...PLATFORMS,
        "switch.sgroup": "group",
        "light.lgroup": "group",
        "button.bgroup": "group",
        "fan.fgroup": "group",
        "cover.cgroup": "group",
        "valve.vgroup": "group",
        "media_player.mgroup": "group",
        "lock.lock_group": "group",
        "sensor.sensor_group": "group",
        "light.outer": "group",
        "fan.a": "tuya",
        "cover.a": "tuya",
        "valve.a": "tuya",
        "lock.template": "template",
      },
      states: Object.fromEntries(Object.entries(members).map(([id, m]) => [id, sets(m)])),
      ...extra,
    });

  it.each([
    ["switch", "turn_on", "switch.sgroup"],
    ["light", "turn_on", "light.lgroup"],
    ["button", "press", "button.bgroup"],
    ["fan", "turn_on", "fan.fgroup"],
    ["cover", "open_cover", "cover.cgroup"],
    ["valve", "open_valve", "valve.vgroup"],
    ["media_player", "turn_on", "media_player.mgroup"],
    ["lock", "unlock", "lock.lock_group"],
  ])("reads the members of a %s group from its attribute and judges each, whatever its domain", async (domain, service, group) => {
    const fake = groupHouse({ [group]: ["light.kitchen", "switch.shell"] });
    const text = refusedText(await call(domain, service, { entity_id: group }));
    expect(text).toContain("switch.shell");
    expect(fake.rest).toContain(`GET /api/states/${group}`);
    expect(fake.acting).toEqual([]);
  });

  it("allows a group whose members are all fine, with one REST read", async () => {
    const fake = groupHouse({ "switch.sgroup": ["switch.plug", "light.kitchen"], "button.bgroup": ["button.garage"] });
    const r = await call("switch", "turn_on", { entity_id: "switch.sgroup" });
    expect(r.isError, r.text).toBe(false);
    expect(fake.rest).toEqual(["GET /api/states/switch.sgroup", POST("switch", "turn_on")]);
  });

  it("recurses through a group of groups", async () => {
    const fake = groupHouse({ "light.outer": ["light.lgroup"], "light.lgroup": ["switch.cmd"] });
    const text = refusedText(await call("light", "turn_on", { entity_id: "light.outer" }));
    expect(text).toContain("switch.cmd");
    expect(fake.rest).toContain("GET /api/states/light.lgroup");
    expect(fake.acting).toEqual([]);
  });

  it("reads only light groups of an area for a light call, never the switch or sensor groups it also holds", async () => {
    const fake = groupHouse(
      { "light.lgroup": ["light.kitchen"] },
      { targets: { kitchen: ["light.lgroup", "switch.sgroup", "sensor.sensor_group"] } },
    );
    const r = await call("light", "turn_on", { area_id: "kitchen" });
    expect(r.isError, r.text).toBe(false);
    expect(fake.rest.filter((x) => x.startsWith("GET"))).toEqual(["GET /api/states/light.lgroup"]);
  });

  it("never reads a sensor group, even when named", async () => {
    const fake = groupHouse({});
    const r = await call("persistent_notification", "create", { message: "x", entity_id: "sensor.sensor_group" });
    expect(r.isError, r.text).toBe(false);
    expect(fake.rest.filter((x) => x.startsWith("GET"))).toEqual([]);
  });

  it("refuses a group whose attribute is missing, malformed or unreadable", async () => {
    for (const states of [
      {},
      { "switch.sgroup": { entity_id: "switch.sgroup", state: "on", attributes: {} } },
      { "switch.sgroup": { state: "on", attributes: { entity_id: "switch.plug" } } },
      { "switch.sgroup": { state: "on", attributes: { entity_id: ["switch.plug", 5] } } },
      { "switch.sgroup": { state: "on", attributes: { entity_id: ["not an id"] } } },
    ]) {
      const fake = groupHouse({}, { states });
      const text = refusedText(await call("switch", "turn_on", { entity_id: "switch.sgroup" }));
      expect(text, JSON.stringify(states)).toMatch(/could not be read|unread|members/);
      expect(fake.acting).toEqual([]);
    }
    const down = groupHouse({}, { restFallback: () => undefined });
    down.options.states = undefined;
    refusedText(await call("switch", "turn_on", { entity_id: "switch.sgroup" }));
  });

  it("refuses a group that is not in the entity map", async () => {
    const fake = house();
    refusedText(await call("switch", "turn_on", { entity_id: "switch.ghost_group" }));
    expect(fake.acting).toEqual([]);
  });

  it("refuses a member that is unknown to the entity map", async () => {
    const fake = groupHouse({ "switch.sgroup": ["switch.removed"] });
    const text = refusedText(await call("switch", "turn_on", { entity_id: "switch.sgroup" }));
    expect(text).toContain("switch.removed");
    expect(fake.acting).toEqual([]);
  });

  it("expands an old-style group named as a member of a group's service data", async () => {
    const fake = groupHouse(
      { "switch.sgroup": ["group.old"] },
      { targets: { "group.old": ["switch.shell"] }, platforms: { ...PLATFORMS, "group.old": "group", "switch.sgroup": "group" } },
    );
    refusedText(await call("switch", "turn_on", { entity_id: "switch.sgroup" }));
    expect(fake.types()).toEqual(["entity/source", "extract_from_target"]);
    expect(fake.acting).toEqual([]);
  });

  it("a group of a template lock is refused by naming the member", async () => {
    const fake = groupHouse({ "lock.lock_group": ["lock.template"] });
    const text = refusedText(await call("lock", "lock", { entity_id: "lock.lock_group" }));
    expect(text).toContain("lock.template");
    expect(fake.acting).toEqual([]);
  });
});

describe("inline entities and media-player fields", () => {
  const mp = (extra: Partial<FakeOptions> = {}) =>
    house({ platforms: { ...PLATFORMS, "media_player.a": "cast", "media_player.b": "sonos" }, ...extra });

  it("reads scene.apply entities keys strictly, in any case", async () => {
    const fake = house();
    refusedText(await call("scene", "apply", { entities: { "Switch.Shell": "on" } }));
    refusedText(await call("scene", "apply", { entities: { "light.kitchen": "on", "light.unknown": "on" } }));
    expect(fake.acting).toEqual([]);
    const ok = house();
    expect((await call("scene", "apply", { entities: { "light.kitchen": { state: "on" } } })).isError).toBe(false);
    expect(ok.acting).toEqual([POST("scene", "apply")]);
  });

  it("reads media_player.join members from comma text, strictly", async () => {
    const fake = mp();
    const text = refusedText(await call("media_player", "join", { entity_id: "media_player.a", group_members: "media_player.b, Switch.Shell" }));
    expect(text).toContain("switch.shell");
    refusedText(await call("media_player", "join", { entity_id: "media_player.a", group_members: ["media_player.b", "media_player.nope"] }));
    expect(fake.acting).toEqual([]);
    const ok = mp();
    expect((await call("media_player", "join", { entity_id: "media_player.a", group_members: "media_player.b" })).isError).toBe(false);
    expect(ok.acting).toEqual([POST("media_player", "join")]);
  });

  it("refuses tts.speak with a universal player, a template player, and a denied entity in the field", async () => {
    const fake = mp();
    for (const field of ["media_player.tv", "Media_Player.TV", " media_player.tv ", "media_player.a, media_player.tv", ["media_player.tv"], "switch.shell"]) {
      const text = refusedText(await call("tts", "speak", { entity_id: "tts.cloud", media_player_entity_id: field, message: "hi" }));
      expect(text, JSON.stringify(field)).toMatch(/media_player.tv|switch.shell/);
    }
    expect(fake.acting).toEqual([]);
  });

  it("allows tts.speak with an ordinary player, none, and a templated message in a direct call", async () => {
    const fake = mp();
    for (const field of ["media_player.a", "none"]) {
      const r = await call("tts", "speak", { entity_id: "tts.cloud", media_player_entity_id: field, message: "Hello {{ name }}" });
      expect(r.isError, `${field}: ${r.text}`).toBe(false);
    }
    expect(fake.acting).toHaveLength(2);
  });

  it("reads all in a media-player field as every media player, each classified", async () => {
    const fake = mp();
    const text = refusedText(await call("tts", "speak", { entity_id: "tts.cloud", media_player_entity_id: "all", message: "hi" }));
    expect(text).toContain("media_player.tv");
    expect(text).toContain("universal");
    expect(fake.acting).toEqual([]);
    const clean = house({ platforms: { "media_player.a": "cast", "media_player.b": "sonos", "tts.cloud": "cloud", "switch.shell": "template" } });
    expect((await call("tts", "speak", { entity_id: "tts.cloud", media_player_entity_id: "all", message: "hi" })).isError).toBe(false);
    expect(clean.acting).toHaveLength(1);
  });

  it("reads entity_id of a legacy tts say service as every media player, not the tts entities", async () => {
    const fake = mp();
    for (const data of [{ entity_id: "all", message: "x" }, { entity_id: "ALL", message: "x" }, { target: { entity_id: "all" }, message: "x" }]) {
      const text = refusedText(await call("tts", "cloud_say", data));
      expect(text, JSON.stringify(data)).toContain("media_player.tv");
    }
    expect(fake.acting).toEqual([]);
    const clean = house({ platforms: { "media_player.a": "cast", "tts.cloud": "cloud" } });
    expect((await call("tts", "cloud_say", { entity_id: "all", message: "x" })).isError).toBe(false);
    expect(clean.acting).toHaveLength(1);
  });

  it("trims the media-player field as Python does, so a trailing control character does not hide the player", async () => {
    mp();
    for (const tail of ["\x1c", "\x85", "\v", "\xa0", " "]) {
      refusedText(await call("tts", "speak", { entity_id: "tts.cloud", media_player_entity_id: `media_player.tv${tail}`, message: "x" }));
      refusedText(await call("camera", "play_stream", { entity_id: "camera.x", media_player: `media_player.tv${tail}` }));
    }
  });

  it("reads camera.play_stream's media_player strictly: the id, all, an unknown piece", async () => {
    const fake = mp();
    refusedText(await call("camera", "play_stream", { entity_id: "camera.x", media_player: "media_player.tv" }));
    refusedText(await call("camera", "play_stream", { entity_id: "camera.x", media_player: "all" }));
    refusedText(await call("camera", "play_stream", { entity_id: "camera.x", media_player: "media_player.nope" }));
    expect(fake.acting).toEqual([]);
    const ok = mp();
    expect((await call("camera", "play_stream", { media_player: "media_player.a" })).isError).toBe(false);
    expect(ok.acting).toEqual([POST("camera", "play_stream")]);
  });
});

describe("scripts, automations and scenes run by a call", () => {
  const script = (...steps: unknown[]) => ({ sequence: steps });
  const lights = { action: "light.turn_on", target: { entity_id: "light.kitchen" } };

  it("walks script.turn_on: a script that only turns on an ordinary light still runs", async () => {
    const fake = house({ scripts: { "script.lights": script(lights) } });
    const r = await call("script", "turn_on", { entity_id: "script.lights" });
    expect(r.isError, r.text).toBe(false);
    expect(fake.types()).toEqual(["entity/source", "script/config"]);
    expect(fake.commands[1]).toEqual({ type: "script/config", entity_id: "script.lights", id: 2 });
    expect(fake.acting).toEqual([POST("script", "turn_on")]);
  });

  it.each([
    ["turn_on", "script", "turn_on"],
    ["toggle", "script", "toggle"],
    ["turn_on", "homeassistant", "turn_on"],
    ["toggle", "homeassistant", "toggle"],
  ])("refuses a script that restarts Home Assistant on %s via %s", async (service, domain) => {
    const fake = house({ scripts: { "script.restart": script(restart) } });
    const text = refusedText(await call(domain, service, { entity_id: "script.restart" }));
    expect(text).toContain("homeassistant.restart");
    expect(fake.acting).toEqual([]);
  });

  it("does not walk a script that is only turned off or reloaded", async () => {
    const fake = house({ scripts: { "script.restart": script(restart) } });
    expect((await call("script", "turn_off", { entity_id: "script.restart" })).isError).toBe(false);
    expect((await call("script", "reload")).isError).toBe(false);
    expect(fake.commands.filter((c) => c.type === "script/config")).toEqual([]);
  });

  it("walks nested forms inside the script", async () => {
    const fake = house({ scripts: { "script.restart": script({ choose: [{ conditions: [], sequence: [{ if: [], then: [{ parallel: [{ sequence: [{ service: "shell_command.x" }] }] }] }] }] }) } });
    expect(refusedText(await call("script", "turn_on", { entity_id: "script.restart" }))).toContain("shell_command.x");
    expect(fake.acting).toEqual([]);
  });

  it("refuses a script that calls a template switch, naming the entity and platform", async () => {
    const fake = house({ scripts: { "script.shell": script({ action: "switch.turn_on", target: { entity_id: "switch.shell" } }) } });
    const text = refusedText(await call("script", "turn_on", { entity_id: "script.shell" }));
    expect(text).toContain("switch.shell");
    expect(text).toContain("template");
    expect(fake.acting).toEqual([]);
  });

  it("follows scripts that call scripts, ends a cycle, and allows what is harmless", async () => {
    const fake = house({
      platforms: { ...PLATFORMS, "script.a": "script", "script.b": "script" },
      scripts: {
        "script.a": script({ action: "script.turn_on", target: { entity_id: "script.b" } }, lights),
        "script.b": script({ action: "script.turn_on", target: { entity_id: "script.a" } }),
      },
    });
    const r = await call("script", "turn_on", { entity_id: "script.a" });
    expect(r.isError, r.text).toBe(false);
    expect(fake.types()).toEqual(["entity/source", "script/config", "script/config"]);
    expect(fake.acting).toEqual([POST("script", "turn_on")]);
  });

  it("refuses a chain of six scripts as too deep and allows five", async () => {
    const platforms: Record<string, string> = { ...PLATFORMS };
    const scripts: Record<string, unknown> = {};
    for (let i = 1; i <= 6; i++) {
      platforms[`script.s${i}`] = "script";
      scripts[`script.s${i}`] = script(i < 6 ? { action: "script.turn_on", target: { entity_id: `script.s${i + 1}` } } : lights);
    }
    const fake = house({ platforms, scripts });
    expect((await call("script", "turn_on", { entity_id: "script.s2" })).isError).toBe(false);
    const text = refusedText(await call("script", "turn_on", { entity_id: "script.s1" }));
    expect(text).toContain("too deep");
    expect(fake.acting).toEqual([POST("script", "turn_on")]);
  });

  it("refuses more than 20 distinct nodes, naming the bound, including entity_id all on 21 scripts", async () => {
    const platforms: Record<string, string> = { "light.kitchen": "hue" };
    const scripts: Record<string, unknown> = {};
    for (let i = 0; i < 21; i++) {
      platforms[`script.n${i}`] = "script";
      scripts[`script.n${i}`] = script(lights);
    }
    const fake = house({ platforms, scripts });
    const text = refusedText(await call("script", "turn_on", { entity_id: "all" }));
    expect(text).toContain("more than 20");
    expect(fake.acting).toEqual([]);
    delete platforms["script.n20"];
    const ok = house({ platforms, scripts });
    expect((await call("script", "turn_on", { entity_id: "all" })).isError).toBe(false);
    expect(ok.acting).toHaveLength(1);
  });

  it("refuses a script that cannot be read", async () => {
    const fake = house({ scripts: {} });
    const text = refusedText(await call("script", "turn_on", { entity_id: "script.lights" }));
    expect(text).toContain("script.lights");
    expect(fake.acting).toEqual([]);
  });

  it("refuses a script whose read-back still holds use_blueprint", async () => {
    const fake = house({ scripts: { "script.lights": { use_blueprint: { path: "x.yaml", input: {} } } } });
    expect(refusedText(await call("script", "turn_on", { entity_id: "script.lights" }))).toContain("use_blueprint");
    expect(fake.acting).toEqual([]);
  });

  it("walks a blueprint script as read back, including an action input", async () => {
    const fake = house({ scripts: { "script.lights": script({ action: "shell_command.x" }) } });
    refusedText(await call("script", "turn_on", { entity_id: "script.lights" }));
    expect(fake.acting).toEqual([]);
  });

  it("reads script.<key> by key over REST from inside a check, on the open connection", async () => {
    const fake = house({ scriptKeys: { my_key: script(lights) } });
    const r = await call("script", "my_key", { x: 1 });
    expect(r.isError, r.text).toBe(false);
    expect(fake.types()).toEqual(["entity/source"]);
    expect(fake.rest).toEqual(["GET /api/config/script/config/my_key", POST("script", "my_key")]);
    // The REST read comes after the WebSocket upgrade: the connection is opened first.
    expect(spy.requests[0]!.url).toContain("/api/websocket");
    expect(spy.requests[1]!.url).toContain("/api/config/script/config/my_key");
  });

  it("refuses script.<key> that holds a blocked call, and one that is not in the scripts file, with advice", async () => {
    const fake = house({ scriptKeys: { bad: script(restart) } });
    expect(refusedText(await call("script", "bad"))).toContain("homeassistant.restart");
    const missing = refusedText(await call("script", "package_script"));
    expect(missing).toContain("script.turn_on");
    expect(missing).toContain("entity id");
    expect(fake.acting).toEqual([]);
  });

  it("expands a blueprint script read by key and lays the instance's own sequence over it", async () => {
    const fake = house({
      scriptKeys: { bp: { use_blueprint: { path: "p.yaml", input: { a: 1 } }, sequence: [{ action: "shell_command.x" }] } },
      blueprints: { "script:p.yaml": { sequence: [lights], alias: "bp" } },
    });
    const text = refusedText(await call("script", "bp"));
    expect(text).toContain("shell_command.x");
    expect(fake.commands[1]).toMatchObject({ type: "blueprint/substitute", domain: "script", path: "p.yaml", input: { a: 1 } });
    expect(fake.acting).toEqual([]);
    // Without its own keys the blueprint's side is walked and is fine.
    const clean = house({
      scriptKeys: { bp: { use_blueprint: { path: "p.yaml", input: {} } } },
      blueprints: { "script:p.yaml": { sequence: [lights] } },
    });
    expect((await call("script", "bp")).isError).toBe(false);
    expect(clean.acting).toHaveLength(1);
  });

  it("walks automation.trigger's target, from automation/config, and refuses a blocked action", async () => {
    const fake = house({ automations: { "automation.bad": { triggers: [], actions: [{ action: "shell_command.x" }] }, "automation.ok": { triggers: [], actions: [lights] } } });
    expect(refusedText(await call("automation", "trigger", { entity_id: "automation.bad" }))).toContain("shell_command.x");
    const r = await call("automation", "trigger", { entity_id: "automation.ok" });
    expect(r.isError, r.text).toBe(false);
    expect(fake.commands.filter((c) => c.type === "automation/config").map((c) => c.entity_id)).toEqual(["automation.bad", "automation.ok"]);
    expect(fake.acting).toEqual([POST("automation", "trigger")]);
  });

  it("does not walk automation.turn_on, turn_off, toggle or a forwarded homeassistant call", async () => {
    const fake = house({ automations: { "automation.bad": { triggers: [], actions: [{ action: "shell_command.x" }] } } });
    for (const [domain, service] of [["automation", "turn_on"], ["automation", "turn_off"], ["automation", "toggle"], ["homeassistant", "turn_on"], ["homeassistant", "toggle"]]) {
      const r = await call(domain!, service!, { entity_id: "automation.bad" });
      expect(r.isError, `${domain}.${service}: ${r.text}`).toBe(false);
    }
    expect(fake.commands.filter((c) => c.type === "automation/config")).toEqual([]);
  });

  it("reads a package or blueprint automation by entity id, as Home Assistant merged it", async () => {
    const fake = house({ automations: { "automation.bad": { alias: "merged", triggers: [], actions: [{ action: "homeassistant.stop" }] } } });
    expect(refusedText(await call("automation", "trigger", { entity_id: "automation.bad" }))).toContain("homeassistant.stop");
    expect(fake.acting).toEqual([]);
  });

  it("refuses automation.trigger with entity_id all past 20 automations, and walks fewer", async () => {
    const platforms: Record<string, string> = {};
    const automations: Record<string, unknown> = {};
    for (let i = 0; i < 21; i++) {
      platforms[`automation.n${i}`] = "automation";
      automations[`automation.n${i}`] = { triggers: [], actions: [] };
    }
    house({ platforms, automations });
    expect(refusedText(await call("automation", "trigger", { entity_id: "all" }))).toContain("more than 20");
  });

  it("walks a scene's members, read from its state, and a script among them as if turned on", async () => {
    const fake = house({
      states: { "scene.evening": sets(["light.kitchen", "script.restart"]) },
      scripts: { "script.restart": script(restart) },
    });
    const text = refusedText(await call("scene", "turn_on", { entity_id: "scene.evening" }));
    expect(text).toContain("homeassistant.restart");
    expect(fake.rest).toContain("GET /api/states/scene.evening");
    expect(fake.acting).toEqual([]);
  });

  it("refuses a scene with a template member or a group that holds one, and allows an ordinary scene", async () => {
    const bad = house({ states: { "scene.evening": sets(["light.kitchen", "switch.shell"]) } });
    expect(refusedText(await call("scene", "turn_on", { entity_id: "scene.evening" }))).toContain("switch.shell");
    expect(bad.acting).toEqual([]);
    const viaGroup = house({
      platforms: { ...PLATFORMS, "group.rooms": "group" },
      states: { "scene.evening": sets(["group.rooms"]) },
      targets: { "group.rooms": ["switch.cmd"] },
    });
    expect(refusedText(await call("scene", "turn_on", { entity_id: "scene.evening" }))).toContain("switch.cmd");
    expect(viaGroup.acting).toEqual([]);
    const ok = house({ states: { "scene.evening": sets(["light.kitchen", "light.desk"]) } });
    expect((await call("scene", "turn_on", { entity_id: "scene.evening" })).isError).toBe(false);
    expect(ok.acting).toEqual([POST("scene", "turn_on")]);
  });

  it("forwards homeassistant.turn_on on a scene and on a script", async () => {
    house({ states: { "scene.evening": sets(["switch.shell"]) } });
    refusedText(await call("homeassistant", "turn_on", { entity_id: "scene.evening" }));
  });

  it("classifies a scene of another platform like any entity, without reading members", async () => {
    const fake = house({ platforms: { ...PLATFORMS, "scene.hue": "hue" } });
    expect((await call("scene", "turn_on", { entity_id: "scene.hue" })).isError).toBe(false);
    expect(fake.rest).toEqual([POST("scene", "turn_on")]);
  });

  it("refuses a scene whose state cannot be read", async () => {
    house({ states: {} });
    expect(refusedText(await call("scene", "turn_on", { entity_id: "scene.evening" }))).toContain("scene.evening");
  });

  it("refuses more than 10 REST reads of scenes, scripts and groups", async () => {
    const platforms: Record<string, string> = { "light.kitchen": "hue" };
    const states: Record<string, unknown> = {};
    for (let i = 0; i < 11; i++) {
      platforms[`scene.s${i}`] = "homeassistant";
      states[`scene.s${i}`] = sets(["light.kitchen"]);
    }
    house({ platforms, states });
    const ids = Array.from({ length: 11 }, (_, i) => `scene.s${i}`);
    expect(refusedText(await call("scene", "turn_on", { entity_id: ids }))).toContain("more than 10");
    house({ platforms, states });
    expect((await call("scene", "turn_on", { entity_id: ids.slice(0, 10) })).isError).toBe(false);
  });

  it("refuses more than 40 commands", async () => {
    const platforms: Record<string, string> = { "light.kitchen": "hue" };
    const targets: Record<string, string[]> = {};
    const scripts: Record<string, unknown> = {};
    for (let i = 0; i < 19; i++) {
      platforms[`script.c${i}`] = "script";
      targets[`area${i}`] = ["light.kitchen"];
      scripts[`script.c${i}`] = script({ action: "light.turn_on", target: { area_id: `area${i}` } }, { action: "button.press", target: { entity_id: "button.garage" } });
    }
    platforms["button.garage"] = "esphome";
    house({ platforms, scripts, targets, registry: { "button.garage": { entity_category: null } } });
    const ids = Array.from({ length: 19 }, (_, i) => `script.c${i}`);
    expect(refusedText(await call("script", "turn_on", { entity_id: ids }))).toContain("more than 40");
  });
});

describe("buttons", () => {
  const reg = (extra: Msg) => ({ entity_category: null, device_class: null, original_device_class: null, ...extra });

  it("refuses a config-category button, a restart-class button and a button with no registry entry; allows an ordinary one", async () => {
    const options = {
      registry: {
        "button.garage": reg({}),
        "button.router": reg({ device_class: "restart" }),
        "button.nas": reg({ entity_category: "config" }),
      },
    };
    const fake = house(options);
    expect((await call("button", "press", { entity_id: "button.garage" })).isError).toBe(false);
    expect(fake.commands.at(-1)).toMatchObject({ type: "config/entity_registry/get_entries", entity_ids: ["button.garage"] });
    expect(refusedText(await call("button", "press", { entity_id: "button.router" }))).toContain("restart");
    expect(refusedText(await call("button", "press", { entity_id: "button.nas" }))).toContain("config category");
    house({ ...options, registry: {} });
    expect(refusedText(await call("button", "press", { entity_id: "button.garage" }))).toContain("no entity registry entry");
  });

  it("also reads original_device_class", async () => {
    house({ registry: { "button.router": reg({ original_device_class: "restart" }) } });
    expect(refusedText(await call("button", "press", { entity_id: "button.router" }))).toContain("restart");
  });

  it("judges a button reached by a label, which reaches config-category entities directly", async () => {
    house({ targets: { reboots: ["button.nas"] }, registry: { "button.nas": reg({ entity_category: "config" }) } });
    expect(refusedText(await call("button", "press", { label_id: "reboots" }))).toContain("button.nas");
  });

  it("judges a button that is a group member and a scene member", async () => {
    const platforms = { ...PLATFORMS, "button.bgroup": "group" };
    house({ platforms, states: { "button.bgroup": sets(["button.nas"]) }, registry: { "button.nas": reg({ entity_category: "config" }) } });
    expect(refusedText(await call("button", "press", { entity_id: "button.bgroup" }))).toContain("button.nas");
    house({ states: { "scene.evening": sets(["button.nas"]) }, registry: { "button.nas": reg({ entity_category: "config" }) } });
    expect(refusedText(await call("scene", "turn_on", { entity_id: "scene.evening" }))).toContain("button.nas");
  });

  it("judges a button in a script", async () => {
    house({
      scripts: { "script.lights": { sequence: [{ action: "button.press", target: { entity_id: "button.nas" } }] } },
      registry: { "button.nas": reg({ entity_category: "config" }) },
    });
    expect(refusedText(await call("script", "turn_on", { entity_id: "script.lights" }))).toContain("button.nas");
  });
});

describe("device steps in a walked script", () => {
  const run = (step: Msg, options: Partial<FakeOptions> = {}) =>
    house({ scripts: { "script.lights": { sequence: [step] } }, ...options });

  it("classifies a light device step by its entity, and resolves a registry id from the registry list", async () => {
    const fake = run(
      { device_id: "d1", domain: "light", type: "turn_on", entity_id: "abc123" },
      { registryList: [{ id: "abc123", entity_id: "light.kitchen" }] },
    );
    const r = await call("script", "turn_on", { entity_id: "script.lights" });
    expect(r.isError, r.text).toBe(false);
    expect(fake.types()).toEqual(["entity/source", "script/config", "config/entity_registry/list"]);
  });

  it("refuses a registry id that is not in the registry, and a device step whose entity is of another domain", async () => {
    run({ device_id: "d1", domain: "light", type: "turn_on", entity_id: "abc123" }, { registryList: [] });
    expect(refusedText(await call("script", "turn_on", { entity_id: "script.lights" }))).toContain("abc123");
    run({ device_id: "d1", domain: "light", type: "turn_on", entity_id: "switch.plug" });
    expect(refusedText(await call("script", "turn_on", { entity_id: "script.lights" }))).toContain("of domain switch");
  });

  it("refuses a device step on a denied platform", async () => {
    run({ device_id: "d1", domain: "light", type: "turn_on", entity_id: "light.shell" });
    expect(refusedText(await call("script", "turn_on", { entity_id: "script.lights" }))).toContain("template");
  });

  it("applies the button rule to a button device step", async () => {
    run({ device_id: "d1", domain: "button", type: "press", entity_id: "button.nas" }, { registry: { "button.nas": { entity_category: "config" } } });
    expect(refusedText(await call("script", "turn_on", { entity_id: "script.lights" }))).toContain("config category");
  });

  it("refuses an unknown device domain and a step with no entity", async () => {
    for (const step of [
      { device_id: "d1", domain: "zha", type: "x", entity_id: "light.kitchen" },
      { device_id: "d1", domain: "mobile_app", type: "notify" },
      { device_id: "d1", domain: "light", type: "turn_on" },
    ]) {
      run(step);
      expect(refusedText(await call("script", "turn_on", { entity_id: "script.lights" }))).toContain("cannot be determined");
    }
  });
});

describe("walked steps: what cannot be told is refused", () => {
  const run = (step: unknown) => house({ scripts: { "script.lights": { sequence: [step] } } });
  const turnOn = () => call("script", "turn_on", { entity_id: "script.lights" });

  it.each([
    ["a templated service name", { action: "{{ svc }}" }],
    ["a templated target", { action: "light.turn_on", target: "{{ t }}" }],
    ["a templated entity_id", { action: "light.turn_on", target: { entity_id: "{{ e }}" } }],
    ["a templated area_id", { action: "light.turn_on", data: { area_id: "{{ a }}" } }],
    ["a templated step-level entity_id", { action: "light.turn_on", entity_id: "{{ e }}" }],
    ["a templated whole data", { action: "light.turn_on", data: "{{ d }}" }],
    ["a templated mapping key", { action: "light.turn_on", data: { "{{ k }}": 1 } }],
    ["a templated event type", { event: "{{ t }}" }],
    ["a reserved event type", { event: "homeassistant_stop" }],
    ["a step with no type", { alias: "x" }],
    ["a step that is not a mapping", "x"],
    ["a whole data text that is not a mapping", { action: "light.turn_on", data: "not a mapping" }],
    ["a whole data text with a duplicate key", { action: "light.turn_on", data: "{'entity_id': 'light.a', 'entity_id': 'switch.shell'}" }],
  ])("refuses %s", async (_name, step) => {
    const fake = run(step);
    refusedText(await turnOn());
    expect(fake.acting).toEqual([]);
  });

  it("allows a plain event, a templated brightness and a templated message in a script", async () => {
    const fake = run({ sequence: [{ event: "my_event" }, { action: "light.turn_on", data: { brightness: "{{ b }}" } }, { action: "persistent_notification.create", data: { message: "Hi {{ name }}" } }] });
    const r = await turnOn();
    expect(r.isError, r.text).toBe(false);
    expect(fake.acting).toHaveLength(1);
  });

  it("reads a whole data string as the mapping Home Assistant makes of it", async () => {
    const fake = run({ action: "switch.turn_on", data: "{'entity_id': 'Switch.Shell'}" });
    expect(refusedText(await turnOn())).toContain("switch.shell");
    expect(fake.acting).toEqual([]);
    const dt = run({ action: "switch.turn_on", data_template: "{'entity_id': 'switch.shell'}" });
    refusedText(await turnOn());
    expect(dt.acting).toEqual([]);
  });

  it.each(["# x\n{'entity_id': 'switch.shell'}", "\\\n{'entity_id': 'switch.shell'}", " # x\n{'entity_id': 'switch.shell'}", "\v{'entity_id': 'switch.shell'}"])(
    "refuses a whole data string with a comment, continuation or Python-only whitespace first (%j), in data and in data_template",
    async (text) => {
      for (const key of ["data", "data_template"]) {
        run({ action: "switch.turn_on", [key]: text });
        refusedText(await turnOn());
      }
    },
  );

  it("leaves nested plain strings as text: [Door] open and #1 priority are not refused", async () => {
    const fake = house({
      platforms: { ...PLATFORMS },
      scripts: { "script.lights": { sequence: [{ action: "persistent_notification.create", data: { message: "[Door] open", title: "#1 priority", raw: "a\\b", lit: "{'switch.x': 'on'}" } }] } },
    });
    const r = await turnOn();
    expect(r.isError, r.text).toBe(false);
    expect(fake.acting).toHaveLength(1);
  });

  it("finds an exact entity id or comma pieces inside a nested string of the data", async () => {
    for (const message of ["Switch.Shell", "hello, switch.shell"]) {
      run({ action: "persistent_notification.create", data: { message } });
      refusedText(await turnOn());
    }
  });

  it("refuses a templated value anywhere in scene.apply and media_player.join data, but not in an ordinary service", async () => {
    run({ action: "scene.apply", data: { entities: { "light.kitchen": { brightness: "{{ b }}" } } } });
    refusedText(await turnOn());
    run({ action: "media_player.join", data: { entity_id: "media_player.a", group_members: "{{ m }}" } });
    refusedText(await turnOn());
  });

  it("refuses a templated media-player field in a walked step, and allows a templated message next to a plain player", async () => {
    const platforms = { ...PLATFORMS, "media_player.a": "cast" };
    house({ platforms, scripts: { "script.lights": { sequence: [{ action: "tts.speak", data: { entity_id: "tts.cloud", media_player_entity_id: "{{ 'media_player.tv' }}", message: "x" } }] } } });
    expect(refusedText(await turnOn())).toContain("media-player field");
    const ok = house({ platforms, scripts: { "script.lights": { sequence: [{ action: "tts.speak", data: { entity_id: "tts.cloud", media_player_entity_id: "media_player.a", message: "Hi {{ name }}" } }] } } });
    expect((await turnOn()).isError).toBe(false);
    expect(ok.acting).toHaveLength(1);
  });

  it("refuses group.set, scene.create and the other blocked services wherever the walker meets them", async () => {
    for (const service of ["group.set", "scene.create", "media_extractor.play_media", "portainer.recreate_container", "synology_dsm.reboot", "system_bridge.power_command", "sql.query", "conversation.process", "alexa_devices.send_text_command", "hassio.host_reboot", "debugpy.start"]) {
      run({ action: service });
      expect(refusedText(await turnOn()), service).toContain(service);
    }
  });

  it("refuses a legacy notify service not on the allowlist, inside a script run by the model", async () => {
    run({ action: "notify.notify", data: { message: "x" } });
    const text = refusedText(await turnOn());
    expect(text).toContain("notify.notify");
    run({ action: "notify.persistent_notification", data: { message: "x" } });
    refusedText(await turnOn());
  });
});

describe("failure: Home Assistant or the WebSocket cannot be reached", () => {
  it.each(["throw", "no_socket"] as const)("refuses a call that names an entity when the WebSocket cannot be opened (%s), sending nothing", async (ws) => {
    const fake = house({ ws });
    const text = refusedText(await call("light", "turn_on", { entity_id: "light.kitchen" }));
    expect(text).toContain("could not be completed");
    expect(text).toContain("Nothing was sent");
    expect(fake.acting).toEqual([]);
  });

  it("allows calls that need nothing from Home Assistant while the WebSocket is down", async () => {
    const fake = house({ ws: "throw" });
    expect((await call("homeassistant", "reload_all")).isError).toBe(false);
    expect((await call("persistent_notification", "create", { message: "x" })).isError).toBe(false);
    expect(fake.acting).toHaveLength(2);
    const text = refusedText(await call("light", "turn_on", { entity_id: "light.kitchen" }));
    expect(text).toBeTruthy();
  });

  it("does not retry after a login failure and carries the revoked-token hint", async () => {
    const fake = house({ ws: "auth_invalid" });
    const text = refusedText(await call("light", "turn_on", { entity_id: "light.kitchen" }));
    expect(text).toContain("auth_invalid");
    expect(text).toContain("revoked");
    expect(text).toContain("local-only");
    expect(spy.requests).toHaveLength(1);
    expect(fake.commands).toEqual([]);
    expect(fake.acting).toEqual([]);
  });

  it("refuses when a command is refused as unauthorised, naming the administrator rights, with no retry", async () => {
    const fake = house({ ws: "unauthorized" });
    const text = refusedText(await call("light", "turn_on", { entity_id: "light.kitchen" }));
    expect(text).toContain("administrator");
    expect(spy.requests).toHaveLength(1);
    expect(fake.acting).toEqual([]);
  });

  it("refuses when the socket closes half way through the walk, and nothing acting was sent", async () => {
    const fake = house({ ws: "close_after_first", scripts: { "script.lights": { sequence: [] } } });
    const text = refusedText(await call("script", "turn_on", { entity_id: "script.lights" }));
    expect(text).toContain("closed the WebSocket");
    expect(fake.acting).toEqual([]);
    expect(spy.requests.filter((r) => r.url.includes("/api/websocket"))).toHaveLength(1);
  });

  it("refuses when a REST read of the walk fails, and nothing acting was sent", async () => {
    const fake = house({ restFallback: (path) => (path.startsWith("/api/states/") ? new Response("boom", { status: 500 }) : undefined) });
    refusedText(await call("scene", "turn_on", { entity_id: "scene.evening" }));
    expect(fake.acting).toEqual([]);
    expect(fake.rest.filter((r) => r.startsWith("GET /api/states"))).toHaveLength(1);
  });

  it("refuses with 401 from a REST read without a retry", async () => {
    const fake = house({ restFallback: (path) => (path.startsWith("/api/states/") ? new Response("no", { status: 401 }) : undefined) });
    const text = refusedText(await call("scene", "turn_on", { entity_id: "scene.evening" }));
    expect(text).toContain("401");
    expect(fake.rest.filter((r) => r.startsWith("GET /api/states"))).toHaveLength(1);
  });
});

describe("failure: the walk runs out of time", () => {
  beforeEach(() => {
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, delay = 0, ...args: unknown[]) =>
      (real as (f: () => void, d: number, ...a: unknown[]) => ReturnType<typeof setTimeout>)(fn, delay >= 4000 ? delay / 20 : delay, ...args)) as unknown as typeof setTimeout);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a walk that Home Assistant stalls, saying the check ran out of time and nothing was sent", async () => {
    const fake = house({ ws: "silence" });
    const text = refusedText(await call("light", "turn_on", { entity_id: "light.kitchen" }));
    expect(text).toContain("ran out of time");
    expect(text).toContain("Nothing was sent");
    expect(fake.acting).toEqual([]);
  });
});

describe("more routes and bounds", () => {
  const sets2 = (members: string[]) => ({ entity_id: "x", state: "on", attributes: { entity_id: members } });

  it("reads a group named as a scene.apply key, forwarding or old-style, and judges its members", async () => {
    const fake = house({
      platforms: { ...PLATFORMS, "switch.sgroup": "group", "group.old": "group" },
      states: { "switch.sgroup": sets2(["switch.cmd"]) },
      targets: { "group.old": ["switch.shell"] },
    });
    expect(refusedText(await call("scene", "apply", { entities: { "switch.sgroup": "on" } }))).toContain("switch.cmd");
    expect(refusedText(await call("scene", "apply", { entities: { "group.old": "on" } }))).toContain("switch.shell");
    expect(fake.acting).toEqual([]);
  });

  it("refuses a chain of forwarding groups that is too deep, and counts each group read against the REST bound", async () => {
    const platforms: Record<string, string> = { ...PLATFORMS };
    const states: Record<string, unknown> = {};
    for (let i = 1; i <= 6; i++) {
      platforms[`light.g${i}`] = "group";
      states[`light.g${i}`] = sets2(i < 6 ? [`light.g${i + 1}`] : ["light.kitchen"]);
    }
    house({ platforms, states });
    expect(refusedText(await call("light", "turn_on", { entity_id: "light.g1" }))).toContain("too deep");
    house({ platforms, states });
    expect((await call("light", "turn_on", { entity_id: "light.g2" })).isError).toBe(false);

    const many: Record<string, string> = { "light.kitchen": "hue" };
    const manyStates: Record<string, unknown> = {};
    for (let i = 0; i < 11; i++) {
      many[`light.m${i}`] = "group";
      manyStates[`light.m${i}`] = sets2(["light.kitchen"]);
    }
    const ids = Array.from({ length: 11 }, (_, i) => `light.m${i}`);
    house({ platforms: many, states: manyStates });
    expect(refusedText(await call("light", "turn_on", { entity_id: ids }))).toContain("more than 10");
  });

  it("reads each whitespace character the parser skips before a whole data string, and refuses the ones Python strips and the parser does not", async () => {
    for (const lead of [" ", "\t", "\n", "\r", "\f"]) {
      house({ scripts: { "script.lights": { sequence: [{ action: "switch.turn_on", data: `${lead}{'entity_id': 'switch.shell'}` }] } } });
      expect(refusedText(await call("script", "turn_on", { entity_id: "script.lights" })), JSON.stringify(lead)).toContain("switch.shell");
    }
    for (const lead of ["\v", "\x1c", "\x85"]) {
      house({ scripts: { "script.lights": { sequence: [{ action: "switch.turn_on", data: `${lead}{'entity_id': 'switch.shell'}` }] } } });
      expect(refusedText(await call("script", "turn_on", { entity_id: "script.lights" })), JSON.stringify(lead)).toContain("cannot read as a mapping");
    }
  });

  it("leaves the read tools alone: they open no WebSocket and meet no policy", async () => {
    const fake = house({
      restFallback: (path, method) =>
        method === "GET" && path === "/api/states" ? Response.json([]) : method === "POST" && path === "/api/config/core/check_config" ? Response.json({ result: "valid" }) : undefined,
    });
    expect((await callTool("list_entities")).isError).toBe(false);
    expect((await callTool("check_config")).isError).toBe(false);
    expect(fake.opened).toBe(0);
  });
});

