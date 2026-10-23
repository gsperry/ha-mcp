import { describe, expect, it } from "vitest";
import { installFetchSpy } from "../helpers/fetch";
import { callTool, callToolWithEnv, listTools } from "../helpers/mcp";
import { PLATFORMS, refusedText, startPolicyFake } from "../helpers/policy-fake";

const spy = installFetchSpy();

const call = (domain: string, service: string, data?: Record<string, unknown>) => callTool("call_service", { domain, service, data });

/** A refusal by name: nothing at all reaches Home Assistant, not even the WebSocket. */
async function expectRefusedByName(domain: string, service: string, data?: Record<string, unknown>) {
  const fake = startPolicyFake(spy, { platforms: PLATFORMS });
  const r = await call(domain, service, data);
  const text = refusedText(r);
  expect(text, `${domain}.${service}`).toContain(`${domain}.${service}`);
  expect(text).toContain("configuration blocks it, not Home Assistant");
  expect(text).toContain("Nothing was sent");
  expect(spy.requests, `${domain}.${service}`).toHaveLength(0);
  expect(fake.opened).toBe(0);
  expect(fake.acting).toEqual([]);
}

describe("call_service: blocked domains", () => {
  it.each([
    ["hassio", "host_reboot"],
    ["hassio", "addon_stop"],
    ["hassio", "backup_full"],
    ["backup", "create"],
    ["backup", "create_automatic"],
    ["shell_command", "anything"],
    ["python_script", "anything"],
    ["profiler", "start"],
    ["profiler", "memory"],
    ["debugpy", "start"],
  ])("refuses %s.%s by name, with no Home Assistant request", async (domain, service) => {
    await expectRefusedByName(domain, service);
  });

  it("refuses a domain's services whatever the data, including a service that does not exist yet", async () => {
    await expectRefusedByName("hassio", "a_future_service", { entity_id: "light.kitchen" });
    await expectRefusedByName("shell_command", "x", { entity_id: ["light.kitchen", "light.desk"] });
  });

  it("compares after trimming and lower-casing the names", async () => {
    // The tool schema only takes lower-case names, so the policy sees what validation lets through.
    const fake = startPolicyFake(spy, { platforms: PLATFORMS });
    const r = await call("Shell_Command", "x");
    expect(r.isError).toBe(true);
    expect(fake.acting).toEqual([]);
  });
});

describe("call_service: blocked services", () => {
  it.each([
    ["homeassistant", "restart"],
    ["homeassistant", "stop"],
    ["homeassistant", "set_location"],
    ["recorder", "purge"],
    ["recorder", "purge_entities"],
    ["recorder", "disable"],
    ["update", "install"],
    ["cloud", "remote_disconnect"],
    ["synology_dsm", "reboot"],
    ["synology_dsm", "shutdown"],
    ["portainer", "recreate_container"],
    ["system_bridge", "power_command"],
    ["group", "set"],
    ["scene", "create"],
    ["sql", "query"],
    ["media_extractor", "play_media"],
  ])("refuses %s.%s by name, with no Home Assistant request", async (domain, service) => {
    await expectRefusedByName(domain, service);
  });

  it("refuses media_extractor.play_media with an area target and with no entity", async () => {
    await expectRefusedByName("media_extractor", "play_media", { area_id: "living_room", media_content_id: "https://example.test/v" });
    await expectRefusedByName("media_extractor", "play_media", {});
  });

  it("refuses the device-addressed services with the data they take", async () => {
    await expectRefusedByName("portainer", "recreate_container", { container_device_id: "abc123" });
    await expectRefusedByName("system_bridge", "power_command", { bridge: "abc", command: "shutdown" });
    await expectRefusedByName("synology_dsm", "shutdown", {});
    await expectRefusedByName("synology_dsm", "reboot", {});
  });

  it("says the server blocks it and not Home Assistant, names the service and points at the README", async () => {
    startPolicyFake(spy, { platforms: PLATFORMS });
    const text = refusedText(await call("homeassistant", "restart"));
    expect(text).toContain("homeassistant.restart");
    expect(text).toContain("This server's configuration blocks it, not Home Assistant");
    expect(text).toContain("README");
  });

  it("allows the borderline services that stay allowed, with no entity, and reaches Home Assistant once", async () => {
    for (const [domain, service] of [
      ["homeassistant", "reload_all"],
      ["homeassistant", "reload_core_config"],
      ["homeassistant", "reload_config_entry"],
      ["homeassistant", "check_config"],
      ["recorder", "enable"],
      ["recorder", "get_statistics"],
      ["logger", "set_level"],
      ["system_log", "write"],
      ["system_log", "clear"],
      ["rest_command", "my_hook"],
      ["assist_satellite", "start_conversation"],
      ["ai_task", "generate_data"],
      ["persistent_notification", "create"],
      ["cloud", "remote_connect"],
      ["portainer", "prune_images"],
    ]) {
      const fake = startPolicyFake(spy, { platforms: PLATFORMS });
      const r = await call(domain!, service!, { message: "hello" });
      expect(r.isError, `${domain}.${service}: ${r.text.slice(0, 200)}`).toBe(false);
      expect(fake.acting, `${domain}.${service}`).toEqual([`POST /api/services/${domain}/${service}`]);
      expect(fake.opened).toBe(0);
    }
  });
});

describe("call_service: dispatch services", () => {
  it.each([
    ["conversation", "process", { text: "turn on the lights" }],
    ["google_assistant_sdk", "send_text_command", { command: "turn on the light" }],
    ["alexa_devices", "send_text_command", { device_id: "abc", text_command: "turn on the light" }],
  ])("refuses %s.%s by name with no request, including the Alexa one that names no entity", async (domain, service, data) => {
    await expectRefusedByName(domain, service, data);
  });

  it("refuses the Google Assistant service whatever its media player", async () => {
    await expectRefusedByName("google_assistant_sdk", "send_text_command", { command: "x", media_player: "media_player.speaker" });
  });

  it("allows assist_satellite.start_conversation, which only shapes the agent's context", async () => {
    const fake = startPolicyFake(spy, { platforms: PLATFORMS });
    const r = await call("assist_satellite", "start_conversation", { extra_system_prompt: "x" });
    expect(r.isError).toBe(false);
    expect(fake.acting).toHaveLength(1);
  });
});

describe("call_service: the settings", () => {
  it("ALLOW_SYSTEM_ACTIONS is off by default and only the exact text true turns the block off", async () => {
    for (const value of [undefined, "", "TRUE", "True", "1", "yes", " true", "true ", "on", "tru", "false"]) {
      const fake = startPolicyFake(spy, { platforms: PLATFORMS });
      const r = await callToolWithEnv(value === undefined ? {} : { ALLOW_SYSTEM_ACTIONS: value }, "call_service", {
        domain: "homeassistant",
        service: "restart",
      });
      expect(r.isError, JSON.stringify(value)).toBe(true);
      expect(refusedText(r)).toContain("homeassistant.restart");
      expect(fake.acting, JSON.stringify(value)).toEqual([]);
    }
  });

  it("with ALLOW_SYSTEM_ACTIONS true, a blocked call is sent and nothing is read", async () => {
    for (const [domain, service] of [
      ["homeassistant", "restart"],
      ["shell_command", "x"],
      ["conversation", "process"],
      ["group", "set"],
      ["media_extractor", "play_media"],
    ]) {
      const fake = startPolicyFake(spy, { platforms: PLATFORMS });
      const r = await callToolWithEnv({ ALLOW_SYSTEM_ACTIONS: "true" }, "call_service", { domain, service });
      expect(r.isError, `${domain}.${service}: ${r.text.slice(0, 200)}`).toBe(false);
      expect(fake.acting).toEqual([`POST /api/services/${domain}/${service}`]);
      expect(fake.opened).toBe(0);
    }
  });

  it("with ALLOW_SYSTEM_ACTIONS true, no entity map, expansion, script, automation or scene is read", async () => {
    const fake = startPolicyFake(spy, {
      platforms: PLATFORMS,
      scripts: { "script.restart": { sequence: [{ action: "homeassistant.restart" }] } },
    });
    const r = await callToolWithEnv({ ALLOW_SYSTEM_ACTIONS: "true" }, "call_service", {
      domain: "script",
      service: "turn_on",
      data: { entity_id: "script.restart" },
    });
    expect(r.isError).toBe(false);
    expect(fake.opened).toBe(0);
    expect(fake.rest.filter((r) => r.startsWith("GET"))).toEqual([]);
    expect(fake.acting).toHaveLength(1);
  });

  it("the legacy notify rule stays on with the block off", async () => {
    const fake = startPolicyFake(spy, { platforms: PLATFORMS });
    const r = await callToolWithEnv({ ALLOW_SYSTEM_ACTIONS: "true" }, "call_service", { domain: "notify", service: "shell_alert", data: { message: "x" } });
    expect(refusedText(r)).toContain("notify.shell_alert");
    expect(fake.acting).toEqual([]);
  });

  it("refuses every legacy notify service when no allowlist is set, and says where to set it", async () => {
    for (const service of ["notify", "persistent_notification", "mobile_app_phone", "shell_alert", "reload"]) {
      const fake = startPolicyFake(spy, { platforms: PLATFORMS });
      const text = refusedText(await call("notify", service, { message: "x" }));
      expect(text).toContain(`notify.${service}`);
      expect(text).toContain("ALLOWED_NOTIFY_SERVICES");
      expect(spy.requests).toHaveLength(0);
      expect(fake.acting).toEqual([]);
    }
  });

  it("ALLOWED_NOTIFY_SERVICES is the whole list, with or without the notify prefix, in any case, padded", async () => {
    const settings = { ALLOWED_NOTIFY_SERVICES: " notify.Mobile_App_Phone , other,, " };
    for (const service of ["mobile_app_phone", "other"]) {
      const fake = startPolicyFake(spy, { platforms: PLATFORMS });
      const r = await callToolWithEnv(settings, "call_service", { domain: "notify", service, data: { message: "x" } });
      expect(r.isError, service).toBe(false);
      expect(fake.acting).toEqual([`POST /api/services/notify/${service}`]);
      expect(fake.opened).toBe(0);
    }
    const fake = startPolicyFake(spy, { platforms: PLATFORMS });
    const r = await callToolWithEnv(settings, "call_service", { domain: "notify", service: "shell_alert", data: { message: "x" } });
    expect(refusedText(r)).toContain("notify.shell_alert");
    expect(fake.acting).toEqual([]);
  });

  it("an empty ALLOWED_NOTIFY_SERVICES is an empty list, not an absent one", async () => {
    // With a usable confirmation service, an absent list allows exactly that service and an empty text allows nothing.
    const confirmation = { DELETE_CONFIRMATION_NOTIFY_SERVICE: "notify.mobile_app_phone" };
    const absent = startPolicyFake(spy, { platforms: PLATFORMS });
    const allowed = await callToolWithEnv(confirmation, "call_service", { domain: "notify", service: "mobile_app_phone", data: {} });
    expect(allowed.isError).toBe(false);
    expect(absent.acting).toEqual(["POST /api/services/notify/mobile_app_phone"]);

    const fake = startPolicyFake(spy, { platforms: PLATFORMS });
    const r = await callToolWithEnv({ ...confirmation, ALLOWED_NOTIFY_SERVICES: "" }, "call_service", { domain: "notify", service: "mobile_app_phone", data: {} });
    expect(refusedText(r)).toContain("notify.mobile_app_phone");
    expect(fake.acting).toEqual([]);
    // Without the confirmation service an empty text and an absent setting are both an empty list.
    const none = startPolicyFake(spy, { platforms: PLATFORMS });
    refusedText(await callToolWithEnv({ ALLOWED_NOTIFY_SERVICES: "" }, "call_service", { domain: "notify", service: "mobile_app_phone", data: {} }));
    expect(none.acting).toEqual([]);
  });

  it("the default allowlist is the confirmation service alone, written either way and in any case, and only when it is usable", async () => {
    const send = (settings: Record<string, string>, service: string) =>
      callToolWithEnv(settings, "call_service", { domain: "notify", service, data: { message: "x" } });
    for (const value of ["notify.mobile_app_phone", "mobile_app_phone", "  Notify.Mobile_App_Phone  "]) {
      const fake = startPolicyFake(spy, { platforms: PLATFORMS });
      expect((await send({ DELETE_CONFIRMATION_NOTIFY_SERVICE: value }, "mobile_app_phone")).isError, value).toBe(false);
      expect(fake.acting).toEqual(["POST /api/services/notify/mobile_app_phone"]);
      refusedText(await send({ DELETE_CONFIRMATION_NOTIFY_SERVICE: value }, "other_phone"));
      expect(fake.acting).toHaveLength(1);
    }
    // Blank, invalid and unsupported names are never allowlisted by default.
    for (const value of ["", "   ", "notify.", "Mobile App", "mobile-app", "notify.a.b", "send_message", "persistent_notification", "notify.persistent_notification"]) {
      const fake = startPolicyFake(spy, { platforms: PLATFORMS });
      for (const service of ["mobile_app_phone", "persistent_notification", "notify", "a"]) {
        refusedText(await send({ DELETE_CONFIRMATION_NOTIFY_SERVICE: value }, service));
      }
      expect(fake.acting, value).toEqual([]);
    }
  });

  it("a list that includes the confirmation service allows what it lists; a list without it refuses it", async () => {
    const send = (settings: Record<string, string>, service: string) =>
      callToolWithEnv(settings, "call_service", { domain: "notify", service, data: { message: "x" } });
    const confirmation = { DELETE_CONFIRMATION_NOTIFY_SERVICE: "mobile_app_phone" };
    const listed = startPolicyFake(spy, { platforms: PLATFORMS });
    expect((await send({ ...confirmation, ALLOWED_NOTIFY_SERVICES: "notify.mobile_app_phone, other" }, "other")).isError).toBe(false);
    expect(listed.acting).toEqual(["POST /api/services/notify/other"]);
    const unlisted = startPolicyFake(spy, { platforms: PLATFORMS });
    refusedText(await send({ ...confirmation, ALLOWED_NOTIFY_SERVICES: "other" }, "mobile_app_phone"));
    expect(unlisted.acting).toEqual([]);
  });

  it("the allowlist is independent of ALLOW_SYSTEM_ACTIONS, and does not unblock anything else", async () => {
    startPolicyFake(spy, { platforms: PLATFORMS });
    const r = await callToolWithEnv({ ALLOWED_NOTIFY_SERVICES: "shell_command" }, "call_service", { domain: "shell_command", service: "x" });
    expect(refusedText(r)).toContain("shell_command.x");
  });

  it("notify.send_message is an entity service, classified like any other entity call", async () => {
    const fake = startPolicyFake(spy, { platforms: { ...PLATFORMS, "notify.phone": "mobile_app", "notify.shell": "command_line" } });
    const ok = await call("notify", "send_message", { entity_id: "notify.phone", message: "x" });
    expect(ok.isError).toBe(false);
    expect(fake.types()).toEqual(["entity/source"]);
    const bad = await call("notify", "send_message", { entity_id: "notify.shell", message: "x" });
    expect(refusedText(bad)).toContain("command_line");
  });

  it("no tool argument can change the policy", async () => {
    const tools = await listTools();
    for (const tool of tools) {
      const names = Object.keys((tool.inputSchema?.properties as Record<string, unknown>) ?? {});
      expect(names.join(","), tool.name).not.toMatch(/allow|override|force|unsafe|bypass|confirm_system/i);
    }
    // And an extra argument is not read as a setting.
    await expectRefusedByName("homeassistant", "restart", { ALLOW_SYSTEM_ACTIONS: "true", allow_system_actions: true });
  });
});

describe("read tools are unaffected", () => {
  it("list_services reads Home Assistant with no policy check and no WebSocket", async () => {
    const fake = startPolicyFake(spy, { platforms: PLATFORMS, restFallback: (path) => (path === "/api/services" ? Response.json([]) : undefined) });
    const r = await callTool("list_services");
    expect(r.isError).toBe(false);
    expect(fake.opened).toBe(0);
    expect(fake.rest).toEqual(["GET /api/services"]);
  });
});
