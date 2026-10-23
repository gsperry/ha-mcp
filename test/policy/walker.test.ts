import { describe, expect, it } from "vitest";
import { MAX_NESTING, MAX_STEPS } from "../../src/policy/lists";
import { analyzeCall, newBudget, walkAutomation, walkScript, walkSteps, type Problem } from "../../src/policy/walker";

const names = (steps: unknown) => walkSteps(steps, newBudget()).calls.map((c) => `${c.domain}.${c.service}`);
const problems = (steps: unknown) => walkSteps(steps, newBudget()).problems.map((p) => p.what);

describe("walker: nesting", () => {
  const call = { action: "homeassistant.restart" };

  it("finds a call in every nested form, with lists and with single items", () => {
    const forms: unknown[] = [
      [call],
      call,
      [{ choose: [{ conditions: [], sequence: [call] }] }],
      [{ choose: { conditions: [], sequence: call } }],
      [{ choose: [{ conditions: [], sequence: [] }], default: [call] }],
      [{ choose: [], default: call }],
      [{ if: [], then: [call] }],
      [{ if: [], then: [], else: [call] }],
      [{ if: [], then: call, else: call }],
      [{ repeat: { count: 2, sequence: [call] } }],
      [{ repeat: { count: 2, sequence: call } }],
      [{ parallel: [call] }],
      [{ parallel: [{ sequence: [call] }] }],
      [{ parallel: [[call]] }],
      [{ parallel: call }],
      [{ sequence: [call] }],
      [{ sequence: call }],
      [{ sequence: [{ sequence: [{ if: [], then: [{ choose: [{ sequence: [{ parallel: [call] }] }] }] }] }] }],
    ];
    for (const form of forms) expect(names(form), JSON.stringify(form)).toContain("homeassistant.restart");
  });

  it("reads actions and action, and triggers and trigger, of an automation, both when both are present", () => {
    const r = walkAutomation(
      { actions: [{ action: "light.turn_on" }], action: [{ action: "switch.turn_on" }], triggers: [{ a: 1 }], trigger: [{ b: 2 }] },
      newBudget(),
    );
    expect(r.calls.map((c) => c.domain)).toEqual(["light", "switch"]);
    expect(r.triggers).toEqual([[{ a: 1 }], [{ b: 2 }]]);
  });

  it("reads the sequence of a script", () => {
    expect(walkScript({ sequence: [{ action: "light.turn_on" }] }, newBudget()).calls).toHaveLength(1);
  });

  it("refuses a config that still holds use_blueprint", () => {
    expect(walkScript({ use_blueprint: { path: "x" } }, newBudget()).problems[0]?.what).toContain("use_blueprint");
    expect(walkAutomation({ use_blueprint: { path: "x" } }, newBudget()).problems[0]?.what).toContain("use_blueprint");
  });

  it("refuses a config that is not a mapping", () => {
    expect(walkScript("x", newBudget()).problems).toHaveLength(1);
    expect(walkAutomation(null, newBudget()).problems).toHaveLength(1);
  });
});

describe("walker: step types and keys", () => {
  it("reads action, legacy service and service_template as calls", () => {
    expect(names([{ action: "a.b" }, { service: "c.d" }, { service_template: "e.f" }])).toEqual(["a.b", "c.d", "e.f"]);
  });

  it("reads every call key whatever type wins in Home Assistant's order", () => {
    // delay wins, event wins, device_id wins: the call is still found.
    expect(names([{ delay: 1, action: "shell_command.x" }])).toEqual(["shell_command.x"]);
    expect(names([{ event: "x", service: "shell_command.x" }])).toEqual(["shell_command.x"]);
    expect(names([{ condition: "state", service_template: "shell_command.x" }])).toEqual(["shell_command.x"]);
    expect(names([{ delay: 1, sequence: [{ action: "shell_command.x" }] }])).toEqual(["shell_command.x"]);
  });

  it("reads each key of ACTIONS_MAP as a valid step type", () => {
    const keys = [
      "delay", "wait_template", "condition", "and", "or", "not", "event", "scene", "choose", "wait_for_trigger", "variables",
      "if", "stop", "parallel", "sequence", "set_conversation_response",
    ];
    for (const key of keys) {
      const value = key === "event" ? "x" : key === "scene" ? "scene.a" : key === "repeat" ? { sequence: [] } : [];
      expect(problems([{ [key]: value }]), key).toEqual([]);
    }
    expect(problems([{ repeat: { sequence: [] } }])).toEqual([]);
    expect(problems([{ device_id: "d", domain: "light", type: "turn_on", entity_id: "light.a" }])).toEqual([]);
  });

  it("finds a call whichever key of ACTIONS_MAP comes first in Home Assistant's order", () => {
    const keys = [
      "delay", "wait_template", "condition", "and", "or", "not", "event", "device_id", "scene", "repeat", "choose",
      "wait_for_trigger", "variables", "if", "stop", "parallel", "sequence", "set_conversation_response",
    ];
    for (const key of keys) {
      for (const callKey of ["action", "service", "service_template"]) {
        expect(names([{ [key]: [], [callKey]: "shell_command.x" }]), `${key} then ${callKey}`).toContain("shell_command.x");
        expect(names([{ [callKey]: "shell_command.x", [key]: [] }]), `${callKey} then ${key}`).toContain("shell_command.x");
      }
    }
  });

  it("refuses a step that is not a mapping, one with no action type, and a nested item that is not a mapping", () => {
    expect(problems(["text"])[0]).toContain("not a mapping");
    expect(problems([{ alias: "x" }])[0]).toContain("no key that names an action type");
    expect(problems([{ choose: ["x"] }])[0]).toContain("not a mapping");
    expect(problems([{ repeat: "x" }])[0]).toContain("not a mapping");
  });

  it("ignores enabled, continue_on_error and alias: a disabled step is still walked", () => {
    expect(names([{ enabled: false, continue_on_error: true, alias: "x", action: "shell_command.x" }])).toEqual(["shell_command.x"]);
    expect(names([{ enabled: "{{ false }}", action: "shell_command.x" }])).toEqual(["shell_command.x"]);
  });

  it("normalises names and refuses templated, malformed and non-text names", () => {
    expect(names([{ action: " Light.Turn_On " }])).toEqual(["light.turn_on"]);
    expect(problems([{ action: "{{ svc }}" }])[0]).toContain("template");
    expect(problems([{ action: "light" }])[0]).toContain("cannot be read");
    expect(problems([{ action: "light.turn on" }])[0]).toContain("cannot be read");
    expect(problems([{ action: 5 }])[0]).toContain("not text");
    expect(problems([{ service_template: "{{ svc }}" }])[0]).toContain("template");
  });

  it("collects wait_for_trigger values at any depth and does not walk them as actions", () => {
    const r = walkSteps([{ repeat: { sequence: [{ wait_for_trigger: [{ trigger: "event", event_type: "x" }] }] } }], newBudget());
    expect(r.waits).toHaveLength(1);
    expect(r.calls).toEqual([]);
  });

  it("reads scene steps, and refuses a templated one", () => {
    const r = walkSteps([{ scene: " Scene.Evening " }], newBudget());
    expect(r.scenes.map((s) => s.entity)).toEqual(["scene.evening"]);
    expect(problems([{ scene: "{{ x }}" }])[0]).toContain("scene");
  });

  it("reads event steps: plain types pass, reserved and templated types do not", () => {
    expect(problems([{ event: "my_event" }])).toEqual([]);
    expect(problems([{ event: "homeassistant_stop" }])[0]).toContain("reserved");
    expect(problems([{ event: " HomeAssistant_Close " }])[0]).toContain("reserved");
    expect(problems([{ event: "{{ t }}" }])[0]).toContain("template");
    expect(problems([{ event: 5 }])[0]).toContain("not text");
  });
});

describe("walker: device steps", () => {
  const device = (extra: Record<string, unknown>) =>
    walkSteps([{ device_id: "d1", ...extra }], newBudget());

  it("classifies each device domain of the table", () => {
    const cases: [string, string, string][] = [
      ["button", "press", "press"],
      ["button", "anything", "press"],
      ["light", "turn_on", "turn_on"],
      ["light", "turn_off", "turn_off"],
      ["light", "toggle", "toggle"],
      ["light", "brightness_increase", "turn_on"],
      ["switch", "turn_off", "turn_off"],
      ["fan", "toggle", "toggle"],
      ["humidifier", "turn_on", "turn_on"],
      ["remote", "turn_on", "turn_on"],
      ["alarm_control_panel", "arm_away", "arm_away"],
      ["climate", "set_hvac_mode", "set_hvac_mode"],
      ["cover", "open", "open"],
      ["lock", "unlock", "unlock"],
      ["number", "set_value", "set_value"],
      ["select", "select_option", "select_option"],
      ["text", "set_value", "set_value"],
      ["vacuum", "clean", "clean"],
      ["water_heater", "turn_on", "turn_on"],
    ];
    for (const [domain, type, service] of cases) {
      const r = device({ domain, type, entity_id: `${domain}.x` });
      expect(r.problems, `${domain} ${type}`).toEqual([]);
      expect(r.devices[0], `${domain} ${type}`).toMatchObject({ domain, service, entity: `${domain}.x` });
    }
  });

  it("refuses every other domain, a step with no entity, and an unknown type of a toggle domain", () => {
    for (const domain of ["mobile_app", "nut", "rfxtrx", "zha", "zwave_js", "my_custom"]) {
      expect(device({ domain, type: "x", entity_id: "light.a" }).problems[0]?.what, domain).toContain("cannot be determined");
    }
    expect(device({ domain: "zha", type: "x" }).problems).toHaveLength(1);
    expect(device({ domain: "light", type: "turn_on" }).problems[0]?.what).toContain("names no entity");
    expect(device({ domain: "switch", type: "weird", entity_id: "switch.a" }).problems[0]?.what).toContain("cannot be determined");
    expect(device({ type: "turn_on", entity_id: "light.a" }).problems[0]?.what).toContain("domain");
    expect(device({ domain: "light", entity_id: "light.a" }).problems[0]?.what).toContain("type");
    expect(device({ domain: "light", type: "turn_on", entity_id: "{{ e }}" }).problems[0]?.what).toContain("template");
  });

  it("keeps a registry id as written, lower-cased", () => {
    expect(device({ domain: "light", type: "turn_on", entity_id: "ABC123" }).devices[0]?.entity).toBe("abc123");
  });
});

describe("walker: targets and data", () => {
  const analyze = (parts: Parameters<typeof analyzeCall>[2], domain = "light", service = "turn_on", mode: "walked" | "direct" = "walked") => {
    const p: Problem[] = [];
    const finding = analyzeCall(domain, service, parts, mode, "step", p);
    return { finding, problems: p.map((x) => x.what) };
  };

  it("reads entity ids from list, comma text and any case, from data, target and the step", () => {
    const { finding } = analyze({
      data: { entity_id: ["Light.A", " light.b "] },
      target: { entity_id: "light.c, LIGHT.D" },
      entityId: "light.e",
    });
    expect(finding.entityPieces.sort()).toEqual(["light.a", "light.b", "light.c", "light.d", "light.e"]);
  });

  it("keeps all and none as pieces", () => {
    expect(analyze({ data: { entity_id: "all" } }).finding.entityPieces).toEqual(["all"]);
    expect(analyze({ target: { entity_id: "none" } }).finding.entityPieces).toEqual(["none"]);
  });

  it("collects floor, area, device and label ids", () => {
    const { finding } = analyze({ target: { floor_id: "up", area_id: ["kitchen", "hall"], device_id: "d1", label_id: "l1" } });
    expect(finding.others).toEqual({ device_id: ["d1"], area_id: ["kitchen", "hall"], floor_id: ["up"], label_id: ["l1"] });
  });

  it("refuses a templated target, a templated target key, and a templated mapping key anywhere", () => {
    expect(analyze({ target: "{{ t }}" }).problems[0]).toContain("`target` is a template");
    expect(analyze({ target: { entity_id: "{{ e }}" } }).problems[0]).toContain("`entity_id` is a template");
    expect(analyze({ data: { area_id: "{{ a }}" } }).problems[0]).toContain("`area_id` is a template");
    expect(analyze({ entityId: "{{ e }}" }).problems[0]).toContain("`entity_id` is a template");
    expect(analyze({ data: { a: { "{{ k }}": 1 } } }).problems[0]).toContain("mapping key");
    expect(analyze({ target: { "{{ k }}": 1 } }).problems[0]).toContain("mapping key");
    expect(analyze({ data: "{{ d }}" }).problems[0]).toContain("`data` is a template");
    expect(analyze({ dataTemplate: "{% if x %}{}{% endif %}" }).problems[0]).toContain("`data_template` is a template");
  });

  it("ignores a template in an ordinary data field", () => {
    expect(analyze({ data: { brightness: "{{ b }}", message: "x {{ y }}" } }).problems).toEqual([]);
  });

  it("parses a whole data string that is a mapping, and refuses one that is not", () => {
    const ok = analyze({ data: "{'entity_id': 'Switch.Shell'}" });
    expect(ok.problems).toEqual([]);
    expect(ok.finding.entityPieces).toEqual(["switch.shell"]);
    expect(analyze({ dataTemplate: "{'entity_id': 'switch.shell'}" }).finding.entityPieces).toEqual(["switch.shell"]);
    expect(analyze({ data: "just text" }).problems[0]).toContain("cannot read as a mapping");
    expect(analyze({ data: "{'entity_id': 'a', 'entity_id': 'b'}" }).problems[0]).toContain("duplicate key");
    expect(analyze({ data: "# x\n{'entity_id': 'switch.shell'}" }).problems[0]).toContain("comment");
    expect(analyze({ data: "\\\n{'entity_id': 'switch.shell'}" }).problems[0]).toContain("comment");
    expect(analyze({ data: 5 }).problems[0]).toContain("not a mapping");
  });

  it("does not parse a whole data string of a direct call, which is JSON", () => {
    expect(analyze({ data: { x: 1 } }, "light", "turn_on", "direct").problems).toEqual([]);
    // A nested template is plain text in a direct call.
    expect(analyze({ data: { a: { "{{ k }}": 1 } } }, "light", "turn_on", "direct").problems).toEqual([]);
  });

  it("scans every other string, keys and values at any depth, and splits comma text", () => {
    const { finding } = analyze({
      data: {
        message: "Switch.Shell",
        nested: { deep: ["light.a, sensor.b", { "Switch.Key": 1 }], text: "hello. world" },
        "[Door] open": "#1 priority",
        other: "{'switch.x': 'on'}",
      },
    });
    expect(finding.scanned.sort()).toEqual(["light.a", "sensor.b", "switch.key", "switch.shell"]);
  });

  it("does not scan template strings or the target keys again", () => {
    const { finding } = analyze({ data: { entity_id: "light.a", note: "{{ 'light.b' }}" } });
    expect(finding.scanned).toEqual([]);
  });

  it("leaves nested plain strings as text: a literal or a backslash there is not refused", () => {
    const { problems: p, finding } = analyze({ data: { message: "[Door] open", note: "#1 priority", raw: "a\\b", lit: "{'switch.shell': 'on'}" } });
    expect(p).toEqual([]);
    expect(finding.scanned).toEqual([]);
  });

  it("refuses non-text and non-mapping pieces", () => {
    expect(analyze({ data: { entity_id: [5] } }).problems[0]).toContain("not text");
    expect(analyze({ target: 5 }).problems[0]).toContain("not a mapping");
  });
});

describe("walker: inline-entity services and media-player fields", () => {
  const analyze = (domain: string, service: string, parts: Parameters<typeof analyzeCall>[2]) => {
    const p: Problem[] = [];
    const finding = analyzeCall(domain, service, parts, "walked", "step", p);
    return { finding, problems: p.map((x) => x.what) };
  };

  it("reads the keys of scene.apply entities as strict members, lower-cased", () => {
    const { finding, problems: p } = analyze("scene", "apply", { data: { entities: { "Switch.Shell": "on", "light.a": { state: "on" } } } });
    expect(p).toEqual([]);
    expect(finding.members.sort()).toEqual(["light.a", "switch.shell"]);
    expect(finding.membersAreMedia).toBe(false);
  });

  it("refuses a template anywhere in the data of scene.apply and media_player.join, and entities that is not a mapping", () => {
    expect(analyze("scene", "apply", { data: { entities: { "light.a": { brightness: "{{ b }}" } } } }).problems[0]).toContain("templated value");
    expect(analyze("scene", "apply", { data: { transition: "{{ t }}", entities: {} } }).problems[0]).toContain("templated value");
    expect(analyze("scene", "apply", { data: { entities: "{{ e }}" } }).problems.length).toBeGreaterThan(0);
    expect(analyze("media_player", "join", { data: { group_members: "{{ m }}" } }).problems[0]).toContain("templated value");
    expect(analyze("media_player", "join", { data: { group_members: ["media_player.a"], x: "{{ y }}" } }).problems[0]).toContain("templated value");
    expect(analyze("scene", "apply", { data: { entities: 5 } }).problems[0]).toContain("not a mapping");
  });

  it("reads media_player.join members from list or comma text, any case", () => {
    const { finding } = analyze("media_player", "join", { data: { group_members: "media_player.a, Switch.Shell" } });
    expect(finding.members).toEqual(["media_player.a", "switch.shell"]);
  });

  it("reads the media-player field of tts.speak, camera.play_stream and the Google Assistant service as members", () => {
    for (const [domain, service, field] of [
      ["tts", "speak", "media_player_entity_id"],
      ["camera", "play_stream", "media_player"],
      ["google_assistant_sdk", "send_text_command", "media_player"],
    ] as const) {
      const r = analyze(domain, service, { data: { [field]: "Media_Player.TV, all" } });
      expect(r.finding.members, domain).toEqual(["media_player.tv", "all"]);
      expect(r.finding.membersAreMedia).toBe(true);
      expect(analyze(domain, service, { data: { [field]: "{{ p }}" } }).problems[0], domain).toContain("media-player field");
      expect(analyze(domain, service, { data: { [field]: ["media_player.tv\x1c"] } }).finding.members, domain).toEqual(["media_player.tv"]);
    }
  });

  it("reads entity_id of a legacy tts say service as the media-player field wherever it stands", () => {
    for (const parts of [
      { data: { entity_id: "all" } },
      { dataTemplate: { entity_id: "all" } },
      { target: { entity_id: "all" } },
      { entityId: "all" },
    ]) {
      const r = analyze("tts", "cloud_say", parts);
      expect(r.finding.members, JSON.stringify(parts)).toEqual(["all"]);
      expect(r.finding.entityPieces, JSON.stringify(parts)).toEqual([]);
      expect(r.finding.membersAreMedia).toBe(true);
    }
    expect(analyze("tts", "cloud_say", { entityId: "{{ e }}" }).problems[0]).toContain("template");
  });

  it("does not treat tts.speak's entity_id or clear_cache as the legacy field", () => {
    expect(analyze("tts", "speak", { data: { entity_id: "tts.cloud", media_player_entity_id: "media_player.a" } }).finding.entityPieces).toEqual(["tts.cloud"]);
    expect(analyze("tts", "clear_cache", { data: {} }).finding.membersAreMedia).toBe(false);
  });

  it("allows a templated message next to a plain media player, and refuses a templated mapping key in these services", () => {
    const ok = analyze("tts", "speak", { data: { media_player_entity_id: "media_player.a", message: "Hello {{ name }}" } });
    expect(ok.problems).toEqual([]);
    const bad = analyze("tts", "speak", { data: { media_player_entity_id: "media_player.a", options: { "{{ k }}": 1 } } });
    expect(bad.problems[0]).toContain("mapping key");
    const both = analyze("tts", "speak", { data: { media_player_entity_id: "{{ p }}", message: "{{ m }}" } });
    expect(both.problems).toHaveLength(1);
    expect(both.problems[0]).toContain("media-player field");
  });
});

describe("walker: bounds", () => {
  it("refuses nesting deeper than the limit", () => {
    let step: Record<string, unknown> = { action: "light.turn_on" };
    for (let i = 0; i < MAX_NESTING + 2; i++) step = { sequence: [step] };
    expect(problems([step]).join(" ")).toContain(`${MAX_NESTING} levels`);
    let ok: Record<string, unknown> = { action: "light.turn_on" };
    for (let i = 0; i < MAX_NESTING - 1; i++) ok = { sequence: [ok] };
    expect(problems([ok])).toEqual([]);
  });

  it("refuses more steps than the limit, counted across walks that share a budget", () => {
    const steps = Array.from({ length: MAX_STEPS + 1 }, () => ({ delay: 1 }));
    expect(problems(steps).join(" ")).toContain(`${MAX_STEPS} steps`);
    expect(problems(steps.slice(0, MAX_STEPS))).toEqual([]);
    const budget = newBudget();
    expect(walkSteps(steps.slice(0, 600), budget).problems).toEqual([]);
    expect(walkSteps(steps.slice(0, 600), budget).problems[0]?.what).toContain(`${MAX_STEPS} steps`);
  });

  it("does not change its input", () => {
    const steps = [{ choose: [{ sequence: [{ action: "light.turn_on", target: { entity_id: "Light.A" } }] }] }];
    const copy = JSON.stringify(steps);
    walkSteps(steps, newBudget());
    expect(JSON.stringify(steps)).toBe(copy);
  });
});
