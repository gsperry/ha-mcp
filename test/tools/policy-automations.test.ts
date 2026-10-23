import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteInTwoCalls } from "../helpers/delete";
import { installFetchSpy } from "../helpers/fetch";
import { callTool, callToolWithEnv } from "../helpers/mcp";
import { fakeClock, PLATFORMS, refusedText, startPolicyFake, type FakeOptions, type Msg } from "../helpers/policy-fake";

const spy = installFetchSpy();

beforeEach(() => {
  // The poll after a create waits between reads; run those waits at once.
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, delay = 0, ...args: unknown[]) =>
    (real as (f: () => void, d: number, ...a: unknown[]) => ReturnType<typeof setTimeout>)(fn, delay >= 1000 ? 0 : delay, ...args)) as unknown as typeof setTimeout);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const house = (extra: Partial<FakeOptions> = {}) => startPolicyFake(spy, { platforms: { ...PLATFORMS }, ...extra });
const upsert = (config: Msg, id = "new_one") => callTool("upsert_automation", { id, config });
const trigger = { trigger: "state", entity_id: "binary_sensor.garage_door", to: "on" };
const config = (actions: unknown, extra: Msg = {}): Msg => ({ alias: "t", triggers: [trigger], conditions: [], actions, ...extra });
const restartLegacy = { service: "homeassistant.stop" };
const lights = { action: "light.turn_on", target: { entity_id: "light.kitchen" } };

/** A refused write: nothing acted, and no request of the existing flow (config read, registry, states) was made. */
function expectNothingWritten(fake: ReturnType<typeof house>): void {
  expect(fake.acting).toEqual([]);
  expect(fake.rest).toEqual([]);
}

describe("upsert_automation: nested actions", () => {
  const forms: [string, unknown][] = [
    ["a plain list", [restartLegacy]],
    ["a single action", restartLegacy],
    ["choose default", [{ choose: [{ conditions: [], sequence: [] }], default: [restartLegacy] }]],
    ["choose option sequence", [{ choose: [{ conditions: [], sequence: [restartLegacy] }] }]],
    ["if then", [{ if: [], then: [restartLegacy] }]],
    ["if else", [{ if: [], then: [], else: [restartLegacy] }]],
    ["repeat sequence", [{ repeat: { count: 2, sequence: [restartLegacy] } }]],
    ["parallel", [{ parallel: [restartLegacy] }]],
    ["parallel sequence", [{ parallel: [{ sequence: [restartLegacy] }] }]],
    ["sequence", [{ sequence: [restartLegacy] }]],
    ["deep mix", [{ sequence: [{ if: [], then: [{ choose: [{ sequence: [{ repeat: { sequence: [{ parallel: [restartLegacy] }] } }] }] }] }] }]],
    ["a service_template key", [{ service_template: "homeassistant.stop" }]],
    ["an action key with another type first", [{ delay: 1, action: "homeassistant.stop" }]],
    ["several action keys", [{ event: "x", action: "homeassistant.stop" }]],
    ["a disabled step", [{ enabled: false, action: "homeassistant.stop" }]],
  ];

  it.each(forms)("refuses homeassistant.stop in %s, before any Home Assistant request", async (_name, actions) => {
    const fake = house();
    const text = refusedText(await upsert(config(actions)));
    expect(text).toContain("homeassistant.stop");
    expect(text).toContain("Nothing was sent");
    expectNothingWritten(fake);
    expect(fake.opened).toBe(0);
    expect(spy.requests).toHaveLength(0);
  });

  it("reads actions and action when both are present, and the singular key form", async () => {
    const fake = house();
    refusedText(await upsert({ alias: "t", trigger, action: [restartLegacy], actions: [] }));
    refusedText(await upsert({ alias: "t", trigger, action: [], actions: [restartLegacy] }));
    expect(spy.requests).toHaveLength(0);
    expect(fake.acting).toEqual([]);
  });

  it.each([
    ["a templated name", [{ action: "{{ svc }}" }]],
    ["a templated target", [{ action: "light.turn_on", target: "{{ t }}" }]],
    ["a templated entity", [{ action: "light.turn_on", target: { entity_id: "{{ e }}" } }]],
    ["a templated whole data", [{ action: "light.turn_on", data: "{{ d }}" }]],
    ["a reserved event", [{ event: "homeassistant_stop" }]],
    ["a templated event", [{ event: "{{ e }}" }]],
    ["a step with no type", [{ alias: "x" }]],
    ["a whole data text that is not a mapping", [{ action: "light.turn_on", data: "text" }]],
    ["a templated mapping key", [{ action: "persistent_notification.create", data: { "{{ k }}": 1 } }]],
    ["group.set with members", [{ action: "group.set", data: { object_id: "lights", entities: "light.a, switch.shell" } }, { action: "switch.turn_on", target: { entity_id: "group.lights" } }]],
    ["scene.create", [{ action: "scene.create", data: { scene_id: "x", entities: "'switch.shell'," } }]],
    ["a legacy notify service", [{ action: "notify.notify", data: { message: "x" } }]],
    ["a dispatch service", [{ action: "conversation.process", data: { text: "x" } }]],
  ])("refuses %s, with nothing written and no request", async (_name, actions) => {
    const fake = house();
    refusedText(await upsert(config(actions)));
    expectNothingWritten(fake);
    expect(spy.requests).toHaveLength(0);
  });

  it("allows an event step, a templated brightness and a templated message", async () => {
    const fake = house();
    const r = await upsert(config([{ event: "my_event" }, { action: "persistent_notification.create", data: { message: "Hi {{ name }}", brightness: "{{ b }}" } }]));
    expect(r.isError, r.text).toBe(false);
    expect(fake.acting).toEqual(["POST /api/config/automation/config/new_one"]);
    expect(fake.opened).toBe(1); // the write record's own registry read, none for the policy
    expect(fake.types()).toEqual(["config/entity_registry/list"]);
  });
});

describe("upsert_automation: classification", () => {
  it("allows the phone-test automation: a garage-door trigger and a porch light, with the policy check first", async () => {
    const fake = house({ platforms: { ...PLATFORMS, "light.porch": "hue" } });
    const r = await upsert(config([{ action: "light.turn_on", target: { entity_id: "light.porch" } }]));
    expect(r.isError, r.text).toBe(false);
    // The first request of the call is the policy's WebSocket, before the config read.
    expect(new URL(spy.requests[0]!.url).pathname).toBe("/api/websocket");
    expect(fake.types()).toEqual(["entity/source", "config/entity_registry/list"]);
    expect(fake.rest[0]).toBe("GET /api/config/automation/config/new_one");
    expect(fake.acting).toEqual(["POST /api/config/automation/config/new_one"]);
  });

  it("sends unknown keys of triggers, conditions and actions unchanged, and does not rewrite the config", async () => {
    const fake = house();
    const sent = config(
      [{ action: "light.turn_on", metadata: { m: 1 }, brand_new_action_key: [true], target: { entity_id: "light.kitchen" } }],
      { variables: { x: 1 }, future_key: { a: [1, 2] }, triggers: [{ ...trigger, brand_new_trigger_key: 1 }] },
    );
    const copy = JSON.parse(JSON.stringify(sent));
    const r = await upsert(sent);
    expect(r.isError, r.text).toBe(false);
    expect(fake.bodies).toEqual([copy]);
  });

  it("refuses an action on a template switch or an unknown entity, naming it, and writes nothing", async () => {
    const fake = house();
    expect(refusedText(await upsert(config([{ action: "switch.turn_on", target: { entity_id: "switch.shell" } }])))).toContain("switch.shell");
    expect(refusedText(await upsert(config([{ action: "light.turn_on", target: { entity_id: "light.nope" } }])))).toContain("light.nope");
    expect(fake.acting).toEqual([]);
    expect(fake.rest).toEqual([]);
  });

  it("walks a script the automation runs, and a scene step, and refuses what they hold", async () => {
    const fake = house({
      scripts: { "script.restart": { sequence: [{ action: "homeassistant.restart" }] }, "script.lights": { sequence: [lights] } },
      states: { "scene.evening": { state: "on", attributes: { entity_id: ["switch.shell"] } } },
    });
    expect(refusedText(await upsert(config([{ action: "script.turn_on", target: { entity_id: "script.restart" } }])))).toContain("homeassistant.restart");
    expect(refusedText(await upsert(config([{ scene: "scene.evening" }])))).toContain("switch.shell");
    expect(fake.acting).toEqual([]);
    const ok = await upsert(config([{ action: "script.turn_on", target: { entity_id: "script.lights" } }]));
    expect(ok.isError, ok.text).toBe(false);
  });

  it("refuses an action that triggers an existing automation which restarts Home Assistant", async () => {
    const fake = house({ automations: { "automation.bad": { triggers: [], actions: [{ action: "homeassistant.restart" }] } } });
    const text = refusedText(await upsert(config([{ action: "automation.trigger", target: { entity_id: "automation.bad" } }])));
    expect(text).toContain("homeassistant.restart");
    expectNothingWritten(fake);
  });

  it("classifies device steps, including a registry id, and refuses an unknown device domain", async () => {
    const fake = house({ registryList: [{ id: "abc", entity_id: "light.kitchen" }] });
    const ok = await upsert(config([{ device_id: "d1", domain: "light", type: "turn_on", entity_id: "abc" }]));
    expect(ok.isError, ok.text).toBe(false);
    expect(fake.types()).toContain("config/entity_registry/list");
    refusedText(await upsert(config([{ device_id: "d1", domain: "zha", type: "x", entity_id: "light.kitchen" }]), "other"));
    expect(fake.acting).toHaveLength(1);
  });

  it("refuses when the WebSocket is down and the actions name an entity; writes one that names none", async () => {
    const fake = house({ ws: "throw" });
    const text = refusedText(await upsert(config([lights])));
    expect(text).toContain("could not be completed");
    expect(fake.acting).toEqual([]);
    // A generated id: a caller-supplied new id also needs the registry over the WebSocket, which the write record requires.
    const free = await callTool("upsert_automation", { config: config([{ action: "persistent_notification.create", data: { message: "x" } }]) });
    expect(free.isError, free.text).toBe(false);
    expect(fake.acting).toHaveLength(1);
  });

  it("writes an automation whose only action is an allowlisted notify service, with the WebSocket down", async () => {
    const fake = house({ ws: "throw" });
    const r = await callToolWithEnv({ ALLOWED_NOTIFY_SERVICES: "mobile_app_phone" }, "upsert_automation", {
      config: config([{ action: "notify.mobile_app_phone", data: { message: "[Door] open" } }]),
    });
    expect(r.isError, r.text).toBe(false);
    expect(fake.opened).toBe(0);
    expect(fake.acting).toHaveLength(1);
  });

  it("refuses a config that holds a blocked call even when the rest of it is fine, in a create", async () => {
    const fake = house();
    refusedText(await callTool("upsert_automation", { config: config([lights, restartLegacy]) }));
    expectNothingWritten(fake);
  });
});

describe("upsert_automation: bounds", () => {
  it("refuses a config of more than 1000 steps, naming the bound", async () => {
    const fake = house();
    const actions = Array.from({ length: 1001 }, () => ({ delay: 1 }));
    expect(refusedText(await upsert(config(actions)))).toContain("more than 1000 steps");
    expectNothingWritten(fake);
    expect((await upsert(config(actions.slice(0, 1000)), "ok_size")).isError).toBe(false);
  });

  it("refuses nesting deeper than 20 levels", async () => {
    house();
    let step: Msg = { delay: 1 };
    for (let i = 0; i < 22; i++) step = { sequence: [step] };
    expect(refusedText(await upsert(config([step])))).toContain("20 levels");
  });
});

describe("upsert_automation: blueprints", () => {
  const bp = (extra: Msg = {}): Msg => ({ alias: "bp", use_blueprint: { path: "motion.yaml", input: { a: 1 } }, ...extra });
  const substituted = (actions: unknown, triggers: unknown = [trigger]) => ({ "automation:motion.yaml": { triggers, actions } });

  it("expands the blueprint with blueprint/substitute and refuses a blocked action from an input", async () => {
    const fake = house({ blueprints: substituted([{ action: "homeassistant.restart" }]) });
    expect(refusedText(await upsert(bp()))).toContain("homeassistant.restart");
    expect(fake.types()).toEqual(["entity/source", "blueprint/substitute"]);
    expect(fake.commands[1]).toMatchObject({ domain: "automation", path: "motion.yaml", input: { a: 1 } });
    expectNothingWritten(fake);
  });

  it("allows a blueprint whose expansion is fine, and sends the instance unchanged", async () => {
    const fake = house({ blueprints: substituted([lights]) });
    const r = await upsert(bp());
    expect(r.isError, r.text).toBe(false);
    expect(fake.bodies).toEqual([bp()]);
  });

  it("lays the instance's own actions over the blueprint's, as Home Assistant does", async () => {
    const fake = house({ blueprints: substituted([lights]) });
    refusedText(await upsert(bp({ actions: [{ action: "shell_command.x" }] })));
    expectNothingWritten(fake);
    // The own key replaces the blueprint's whole key: a blocked blueprint action that the instance overrides is not run.
    const clean = house({ blueprints: substituted([{ action: "homeassistant.restart" }]) });
    const r = await upsert(bp({ actions: [lights] }), "own");
    expect(r.isError, r.text).toBe(false);
    expect(clean.acting).toHaveLength(1);
  });

  it("lays the instance's own triggers over the blueprint's, and refuses a capture trigger in either", async () => {
    const capture = { trigger: "event", event_type: "call_service" };
    house({ blueprints: substituted([lights]) });
    refusedText(await upsert(bp({ triggers: [capture] })));
    house({ blueprints: substituted([lights], [capture]) });
    refusedText(await upsert(bp()));
    house({ blueprints: substituted([lights], [capture]) });
    expect((await upsert(bp({ trigger: [trigger] }), "own_trigger_key")).isError).toBe(true);
  });

  it("drops use_blueprint and blueprint from the merge, and an instance with only those keys is the blueprint's side", async () => {
    house({ blueprints: substituted([lights]) });
    expect((await upsert(bp({ blueprint: { x: 1 } }), "z")).isError).toBe(false);
  });

  it("refuses a blueprint that cannot be expanded, and one with no readable path", async () => {
    const fake = house({ blueprints: {} });
    expect(refusedText(await upsert(bp()))).toContain("could not be expanded");
    refusedText(await upsert({ alias: "x", use_blueprint: { input: {} } }, "y"));
    expect(fake.acting).toEqual([]);
  });

  it("refuses a blueprint instance when the WebSocket is down, as unverifiable", async () => {
    const fake = house({ ws: "throw", blueprints: substituted([lights]) });
    refusedText(await upsert(bp()));
    expectNothingWritten(fake);
  });
});

describe("upsert_automation: the capture rule", () => {
  const event = (event_type: unknown, extra: Msg = {}) => ({ trigger: "event", event_type, ...extra });
  const forms: [string, unknown][] = [
    ["call_service", event("call_service")],
    ["the wildcard", event("*")],
    ["a list that contains call_service", event(["my_event", "call_service"])],
    ["a templated type", event("{{ 'call_' ~ 'service' }}")],
    ["a type in any case with padding", event(" Call_Service ")],
    ["a type under options", { trigger: "event", options: { event_type: "call_service" } }],
    ["a kind replaced under options", { trigger: "state", entity_id: "light.kitchen", options: { platform: "event", event_type: "call_service" } }],
    ["a trigger key replaced under options", { trigger: "state", options: { trigger: "event", event_type: "*" } }],
    ["options that is not a mapping", { trigger: "event", event_type: "x", options: "nope" }],
    ["a key set in both places", event("a", { options: { event_type: "call_service" } })],
    ["both trigger and platform", { trigger: "state", platform: "event", event_type: "x" }],
    ["the older platform key", { platform: "event", event_type: "*" }],
    ["a nested triggers list", { triggers: [event("call_service")] }],
    ["mobile_app_notification_received", event("mobile_app_notification_received")],
    ["mobile_app_notification_cleared in a list", event(["my_event", "mobile_app_notification_cleared"])],
    ["mobile_app_notification_action under options", { trigger: "event", options: { event_type: "mobile_app_notification_action" } }],
    ["a mixed-case, padded notification type", event(" Mobile_App_Notification_Foo ")],
  ];

  it.each(forms)("refuses an own trigger with %s, with the block on", async (_name, t) => {
    const fake = house();
    const text = refusedText(await upsert(config([lights], { triggers: [t] })));
    expect(text).toContain("capture");
    expectNothingWritten(fake);
    expect(spy.requests).toHaveLength(0);
  });

  it.each(forms)("refuses an own trigger with %s, with the block off", async (_name, t) => {
    const fake = house();
    const r = await callToolWithEnv({ ALLOW_SYSTEM_ACTIONS: "true" }, "upsert_automation", { id: "x", config: config([lights], { triggers: [t] }) });
    refusedText(r);
    expectNothingWritten(fake);
  });

  it("refuses a wait_for_trigger step at depth, inside repeat and parallel, with any of these forms", async () => {
    for (const [, t] of forms.slice(0, 11)) {
      const fake = house();
      refusedText(await upsert(config([{ repeat: { count: 2, sequence: [{ wait_for_trigger: [t] }] } }])));
      refusedText(await upsert(config([{ parallel: [{ sequence: [{ wait_for_trigger: t }] }] }])));
      expect(fake.acting).toEqual([]);
    }
  });

  const appEvents = [
    "mobile_app_notification_received",
    "mobile_app_notification_cleared",
    "mobile_app_notification_action",
    " Mobile_App_Notification_Foo ",
    ["x", "mobile_app_notification_received"],
  ];

  it.each(appEvents)("refuses the companion app notification event %j as a wait_for_trigger step at depth, in choose and in sequence", async (type) => {
    const fake = house();
    const wait = { wait_for_trigger: [event(type)] };
    for (const actions of [
      [{ choose: [{ conditions: [], sequence: [wait] }] }],
      [{ sequence: [{ if: [], then: [wait] }] }],
      [{ repeat: { count: 2, sequence: [{ parallel: [{ sequence: [wait] }] }] } }],
    ]) {
      expect(refusedText(await upsert(config(actions)))).toContain("capture");
    }
    expect(fake.acting).toEqual([]);
  });

  it.each(appEvents)("refuses the companion app notification event %j in a blueprint expansion, and with the block off", async (type) => {
    const capture = event(type);
    const fake = house({ blueprints: { "automation:motion.yaml": { triggers: [capture], actions: [] } } });
    refusedText(await upsert({ alias: "bp", use_blueprint: { path: "motion.yaml", input: {} } }));
    expect(fake.acting).toEqual([]);
    refusedText(await callToolWithEnv({ ALLOW_SYSTEM_ACTIONS: "true" }, "upsert_automation", { id: "x", config: config([lights], { triggers: [capture] }) }));
  });

  it("allows event types that only resemble the companion app prefix", async () => {
    house();
    for (const type of ["mobile_app_other", "mobile_app", "mobile_app_notificatio", "my_mobile_app_notification"]) {
      const r = await upsert(config([{ action: "persistent_notification.create", data: { message: "x" } }], { triggers: [event(type)] }), `ok_${type}`);
      expect(r.isError, `${type}: ${r.text.slice(0, 200)}`).toBe(false);
    }
  });

  it("refuses a wait_for_trigger step with the block off as well", async () => {
    house();
    const r = await callToolWithEnv({ ALLOW_SYSTEM_ACTIONS: "true" }, "upsert_automation", {
      id: "x",
      config: config([{ wait_for_trigger: [event("*")] }]),
    });
    refusedText(r);
  });

  it("allows ordinary event triggers, other trigger kinds, and options that only carry fields", async () => {
    house();
    const ok = config([{ action: "persistent_notification.create", data: { message: "x" } }], {
      triggers: [event("my_event"), { trigger: "mqtt", topic: "x" }, { trigger: "state", options: { entity_id: "light.kitchen" } }, { triggers: [event("fine")] }],
    });
    expect((await upsert(ok)).isError).toBe(false);
  });

  it("with the block off, a blueprint's expansion and the instance's own keys are still examined, with one blueprint/substitute and no entity map", async () => {
    const capture = { trigger: "event", event_type: "call_service" };
    const fake = house({ blueprints: { "automation:motion.yaml": { triggers: [capture], actions: [] } } });
    const r = await callToolWithEnv({ ALLOW_SYSTEM_ACTIONS: "true" }, "upsert_automation", {
      id: "x",
      config: { alias: "bp", use_blueprint: { path: "motion.yaml", input: {} } },
    });
    refusedText(r);
    expect(fake.types()).toEqual(["blueprint/substitute"]);
    const own = house({ blueprints: { "automation:motion.yaml": { triggers: [trigger], actions: [] } } });
    refusedText(
      await callToolWithEnv({ ALLOW_SYSTEM_ACTIONS: "true" }, "upsert_automation", {
        id: "x",
        config: { alias: "bp", use_blueprint: { path: "motion.yaml", input: {} }, triggers: [capture] },
      }),
    );
    expect(own.acting).toEqual([]);
  });

  it("with the block off, scripts and automations the config merely calls are not read", async () => {
    const fake = house({ scripts: { "script.restart": { sequence: [{ action: "homeassistant.restart" }, { wait_for_trigger: [event("*")] }] } } });
    const r = await callToolWithEnv({ ALLOW_SYSTEM_ACTIONS: "true" }, "upsert_automation", {
      id: "x",
      config: config([{ action: "script.turn_on", target: { entity_id: "script.restart" } }, { action: "homeassistant.restart" }]),
    });
    expect(r.isError, r.text).toBe(false);
    expect(fake.commands.filter((c: Msg) => c.type === "script/config")).toEqual([]);
    expect(fake.acting).toHaveLength(1);
  });

  it("with the block on, a script that waits for call_service cannot be run through the server", async () => {
    house({ scripts: { "script.lights": { sequence: [{ wait_for_trigger: [event("call_service")] }] } } });
    refusedText(await callTool("call_service", { domain: "script", service: "turn_on", data: { entity_id: "script.lights" } }));
  });

  it("with the block off, the legacy notify rule still applies to the config's own calls", async () => {
    const fake = house();
    const r = await callToolWithEnv({ ALLOW_SYSTEM_ACTIONS: "true" }, "upsert_automation", {
      id: "x",
      config: config([{ action: "notify.shell_alert", data: { message: "x" } }]),
    });
    expect(refusedText(r)).toContain("notify.shell_alert");
    expect(fake.acting).toEqual([]);
  });

  it("with the block off, the block's own refusals are skipped for the config", async () => {
    const fake = house();
    const r = await callToolWithEnv({ ALLOW_SYSTEM_ACTIONS: "true" }, "upsert_automation", {
      id: "x",
      config: config([{ action: "shell_command.x" }, { action: "{{ svc }}" }, { event: "homeassistant_stop" }]),
    });
    expect(r.isError, r.text).toBe(false);
    expect(fake.acting).toHaveLength(1);
  });
});

describe("upsert_automation: the time before the write", () => {
  it("refuses, with nothing written, when more than 30 s have passed before the POST", async () => {
    const clock = fakeClock();
    const fake = house({ onUpgrade: () => clock.advance(31_000) });
    const text = (await upsert(config([lights]))).text;
    expect(text).toContain("more than 30 seconds");
    expect(text).toContain("Nothing was written");
    expect(fake.acting).toEqual([]);
  });

  it("writes when 29 s have passed, the boundary being strictly more than 30 s", async () => {
    const clock = fakeClock();
    let upgrades = 0;
    // Only the policy's own connection takes the time; the write record's registry read comes after it.
    const fake = house({ onUpgrade: () => void (upgrades++ === 0 && clock.advance(29_000)) });
    const r = await upsert(config([lights]));
    expect(r.isError, r.text).toBe(false);
    expect(fake.acting).toHaveLength(1);
  });

  it("sends no POST after the limit fires, even when every earlier step passed", async () => {
    const clock = fakeClock();
    const fake = house({ onUpgrade: () => clock.advance(30_500) });
    const r = await upsert(config([lights]));
    expect(r.isError).toBe(true);
    expect(fake.rest.filter((x) => x.startsWith("POST"))).toEqual([]);
  });
});

describe("trigger_automation", () => {
  const stateOf = (id: string) => ({ [id]: { entity_id: id, state: "on", attributes: { last_triggered: null } } });
  const run = (entity_id = "automation.bad") => callTool("trigger_automation", { entity_id });
  const POSTS = "POST /api/services/automation/trigger";

  it("reads the automation's config, walks it and refuses a blocked call deep inside, before the POST", async () => {
    const fake = house({
      states: stateOf("automation.bad"),
      automations: { "automation.bad": { triggers: [], actions: [{ choose: [{ sequence: [{ if: [], then: [{ action: "shell_command.x" }] }] }] }] } },
    });
    expect(refusedText(await run())).toContain("shell_command.x");
    expect(fake.acting).toEqual([]);
    expect(fake.rest).toEqual(["GET /api/states/automation.bad"]);
    expect(fake.types()).toEqual(["entity/source", "automation/config"]);
  });

  it("sends the trigger after the state read and the check, and still works for an ordinary automation", async () => {
    const fake = house({ states: stateOf("automation.ok"), automations: { "automation.ok": { triggers: [], actions: [lights] } } });
    const r = await run("automation.ok");
    expect(r.isError, r.text).toBe(false);
    expect(spy.requests.map((q) => new URL(q.url).pathname)).toEqual([
      "/api/states/automation.ok",
      "/api/websocket",
      "/api/services/automation/trigger",
      "/api/states/automation.ok",
    ]);
    expect(fake.acting).toEqual([POSTS]);
  });

  it("refuses an action on a template switch, a script that restarts, and a legacy notify service", async () => {
    for (const actions of [
      [{ action: "switch.turn_on", target: { entity_id: "switch.shell" } }],
      [{ action: "script.turn_on", target: { entity_id: "script.restart" } }],
      [{ action: "notify.shell_alert", data: { message: "x" } }],
    ]) {
      const fake = house({
        states: stateOf("automation.bad"),
        automations: { "automation.bad": { triggers: [], actions } },
        scripts: { "script.restart": { sequence: [{ action: "homeassistant.restart" }] } },
      });
      refusedText(await run());
      expect(fake.acting, JSON.stringify(actions)).toEqual([]);
    }
  });

  it("walks the merged config of a blueprint automation as read back, and refuses one that still holds use_blueprint", async () => {
    house({ states: stateOf("automation.bad"), automations: { "automation.bad": { alias: "merged", triggers: [], actions: [{ action: "homeassistant.stop" }] } } });
    expect(refusedText(await run())).toContain("homeassistant.stop");
    house({ states: stateOf("automation.bad"), automations: { "automation.bad": { use_blueprint: { path: "x.yaml", input: {} } } } });
    expect(refusedText(await run())).toContain("use_blueprint");
  });

  it("does not examine the automation's own triggers for this route", async () => {
    house({
      states: stateOf("automation.ok"),
      automations: { "automation.ok": { triggers: [{ trigger: "event", event_type: "call_service" }], actions: [lights] } },
    });
    expect((await run("automation.ok")).isError).toBe(false);
  });

  it("refuses an automation whose config cannot be read", async () => {
    const fake = house({ states: stateOf("automation.bad"), automations: {} });
    expect(refusedText(await run())).toContain("automation.bad");
    expect(fake.acting).toEqual([]);
  });

  it("refuses when the WebSocket is down, and sends no trigger", async () => {
    const fake = house({ ws: "throw", states: stateOf("automation.ok") });
    refusedText(await run("automation.ok"));
    expect(fake.acting).toEqual([]);
  });

  it("with the block off, nothing is read and the trigger is sent", async () => {
    const fake = house({ states: stateOf("automation.bad"), automations: { "automation.bad": { triggers: [], actions: [{ action: "shell_command.x" }] } } });
    const r = await callToolWithEnv({ ALLOW_SYSTEM_ACTIONS: "true" }, "trigger_automation", { entity_id: "automation.bad" });
    expect(r.isError, r.text).toBe(false);
    expect(fake.opened).toBe(0);
    expect(fake.acting).toEqual([POSTS]);
  });

  it("walks a script an automation runs and applies the button rule to its buttons", async () => {
    const fake = house({
      states: stateOf("automation.bad"),
      automations: { "automation.bad": { triggers: [], actions: [{ action: "button.press", target: { entity_id: "button.nas" } }] } },
      registry: { "button.nas": { entity_category: "config" } },
    });
    expect(refusedText(await run())).toContain("button.nas");
    expect(fake.acting).toEqual([]);
  });
});

describe("delete_automation and dashboards are not affected", () => {
  it("delete_automation makes no policy check, even for an automation that holds a blocked call", async () => {
    const fake = house();
    fake.stored.set("x", { id: "x", alias: "x", triggers: [], actions: [{ action: "homeassistant.restart" }] });
    spy.respondAlways(async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path.includes("/config/automation/config/x")) return Response.json({ id: "x", actions: [{ action: "homeassistant.restart" }] });
      if (request.method === "DELETE") return Response.json({ result: "ok" });
      if (path === "/api/websocket") return Response.json({}, { status: 200 });
      return Response.json([]);
    });
    const { first, second } = await deleteInTwoCalls(spy, "x");
    expect(first.json.status).toBe("confirmation_required");
    expect(first.text).not.toContain("safety policy");
    expect(second?.isError).toBe(false);
    expect(second?.text).not.toContain("safety policy");
    expect(spy.requests.some((q) => q.method === "DELETE")).toBe(true);
  });
});
