import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIRM_SETTINGS, codeIn, finishDelete, lastCode, requestDelete, sentNotifications } from "../helpers/delete";
import { installFetchSpy } from "../helpers/fetch";
import { callTool, callToolWithEnv, type ToolReply } from "../helpers/mcp";
import { fakeClock, startPolicyFake, type FakeOptions, type PolicyFake } from "../helpers/policy-fake";

const spy = installFetchSpy();

// The call limits (10 s, 15 s, 20 s) run at one twentieth of their length and every requested delay is recorded.
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

const stored = {
  id: "a1",
  alias: "Porch light",
  description: "Turns the porch light on",
  mode: "single",
  triggers: [{ trigger: "sun", event: "sunset" }],
  conditions: [],
  actions: [{ action: "persistent_notification.create", data: { message: "Porch light" } }],
};

const registryEntry = (entity_id: string, unique_id: string, extra: Record<string, unknown> = {}) => ({
  entity_id,
  platform: "automation",
  unique_id,
  area_id: "porch",
  labels: [],
  categories: {},
  name: null,
  icon: null,
  disabled_by: null,
  hidden_by: null,
  options: {},
  ...extra,
});

/** A house with automation `a1` (and `b2`) stored, and a DELETE route that removes them. */
function house(extra: Partial<FakeOptions> = {}): PolicyFake {
  const fake = startPolicyFake(spy, {
    platforms: {},
    registryList: [registryEntry("automation.porch_light", "a1"), registryEntry("automation.other", "b2")],
    states: { "automation.porch_light": { entity_id: "automation.porch_light", state: "on", attributes: { id: "a1", friendly_name: "Porch light" } } },
    restFallback: (path) => (path.startsWith("/api/history") ? Response.json([[]]) : undefined),
    ...extra,
  });
  fake.stored.set("a1", structuredClone(stored));
  fake.stored.set("b2", { ...structuredClone(stored), id: "b2", alias: "Other" });
  return fake;
}

const deletes = (fake: PolicyFake): string[] => fake.acting.filter((a) => a.startsWith("DELETE"));
const notifyPosts = (): Request[] => spy.requests.filter((r) => r.method === "POST" && new URL(r.url).pathname.startsWith("/api/services/notify/"));

/** Stalls a request until its own time limit aborts it. */
const stall = (request: Request): Promise<Response> =>
  new Promise<Response>((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted"))));

function expectNoCode(text: string, code: string): void {
  const a = code.slice(0, 4);
  const b = code.slice(4);
  for (const form of [code, `${a} ${b}`, `${a}-${b}`, `${a}${b}`]) expect(text).not.toContain(form);
}

// ---------------------------------------------------------------------------------------------

describe("delete_automation: call 1", () => {
  it("makes exactly three requests, sends the code and the entity id to the phone, and returns a challenge without the code", async () => {
    const fake = house();
    const r = await requestDelete("a1");
    expect(r.isError, r.text).toBe(false);
    expect(spy.requests).toHaveLength(3);
    expect(fake.rest).toEqual(["GET /api/config/automation/config/a1", "POST /api/services/notify/mobile_app_phone"]);
    expect(fake.types()).toEqual(["config/entity_registry/list"]);
    expect(deletes(fake)).toEqual([]);
    expect(fake.stored.has("a1")).toBe(true);

    const [sent] = await sentNotifications(spy);
    expect(sent!.title).toBe("Confirm automation delete");
    expect(sent!.message).toMatch(/^Claude asked to delete the automation with id a1, entity automation\.porch_light, named 'Porch light'\. Confirmation code: \d{4} \d{4}\. It expires in 5 minutes\. If you did not ask for this, ignore this message and do not share the code\.$/);
    const code = codeIn(sent!.message);

    expect(Object.keys(r.json)).toEqual(["status", "id", "alias", "entity_id", "challenge", "expires_at", "expires_in_seconds", "note"]);
    expect(r.json).toMatchObject({ status: "confirmation_required", id: "a1", alias: "Porch light", entity_id: "automation.porch_light", expires_in_seconds: 300 });
    expect(r.json.challenge).toMatch(/^dc1\.\d{1,12}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(r.json.expires_at)).toBeGreaterThan(Date.now());
    expectNoCode(r.text, code);
    for (const value of Object.values(r.json)) expectNoCode(JSON.stringify(value), code);
  });

  it("answers a missing id with the existing refusal and sends nothing to the phone", async () => {
    const fake = house();
    const r = await requestDelete("ghost");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("ghost");
    expect(r.text).toMatch(/No config with id ghost/);
    expect(r.text).toMatch(/Stage: before_delete/);
    expect(notifyPosts()).toHaveLength(0);
    expect(fake.rest).toEqual(["GET /api/config/automation/config/ghost"]);
  });

  it("sends the entity id of a renamed automation beside its new alias, and says the entity is unavailable when the registry has no entry", async () => {
    house();
    await requestDelete("a1");
    house({ registryList: [] });
    spy.requests.length = 0;
    const r = await requestDelete("a1");
    expect(r.json.entity_id).toBeNull();
    const [sent] = await sentNotifications(spy);
    expect(sent!.message).toContain("id a1, entity unavailable, named 'Porch light'");
  });

  it("a registry read that fails goes on with 'entity unavailable'; a credential failure stops before the phone is told", async () => {
    house({ ws: "throw" });
    const down = await requestDelete("a1");
    expect(down.isError, down.text).toBe(false);
    expect((await sentNotifications(spy))[0]!.message).toContain("entity unavailable");

    spy.requests.length = 0;
    const fake = house({ ws: "auth_invalid" });
    const bad = await requestDelete("a1");
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/revoked/);
    expect(bad.text).toMatch(/Stage: before_delete/);
    expect(notifyPosts()).toHaveLength(0);
    expect(fake.rest).toEqual(["GET /api/config/automation/config/a1"]);
  });

  it("a 401 on the config read stops before the registry and the phone", async () => {
    house({ restFallback: () => Response.json({ message: "Unauthorized" }, { status: 401 }) });
    const r = await requestDelete("a1");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/HTTP 401/);
    expect(spy.requests).toHaveLength(1);
  });
});

describe("delete_automation: call 2", () => {
  it("deletes once with the right code and returns the same shape as before", async () => {
    const fake = house();
    const first = await requestDelete("a1");
    const code = await lastCode(spy);
    spy.requests.length = 0;
    const r = await finishDelete("a1", first.json.challenge, code);
    expect(r.isError, r.text).toBe(false);
    expect(Object.keys(r.json)).toEqual(["id", "deleted_config", "lost_registry_metadata", "warnings", "note"]);
    expect(r.json.deleted_config).toEqual(stored);
    expect(r.json.lost_registry_metadata).toMatchObject({ entity_id: "automation.porch_light", area_id: "porch" });
    expect(deletes(fake)).toEqual(["DELETE /api/config/automation/config/a1"]);
    expect(fake.stored.has("a1")).toBe(false);
    expect(spy.requests).toHaveLength(3);
  });

  it("accepts the code with spaces and hyphens", async () => {
    const shapes = [(c: string) => `${c.slice(0, 4)} ${c.slice(4)}`, (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`, (c: string) => `${c.slice(0, 2)} - ${c.slice(2)}`];
    for (const shape of shapes) {
      const fake = house();
      const first = await requestDelete("a1");
      const code = await lastCode(spy);
      const r = await finishDelete("a1", first.json.challenge, shape(code));
      expect(r.isError, r.text).toBe(false);
      expect(deletes(fake)).toHaveLength(1);
    }
  });

  describe("refusals", () => {
    /** Makes call 1 for `a1` and returns what the model would hold. */
    async function issued(): Promise<{ challenge: string; code: string; fake: PolicyFake }> {
      const fake = house();
      const first = await requestDelete("a1");
      const code = await lastCode(spy);
      spy.requests.length = 0;
      return { challenge: first.json.challenge as string, code, fake };
    }

    const wrongCode = (code: string) => (code.slice(0, 7) + String((Number(code[7]) + 1) % 10)).padStart(8, "0");
    const replaceField = (challenge: string, index: number, edit: (v: string) => string) =>
      challenge
        .split(".")
        .map((v, i) => (i === index ? edit(v) : v))
        .join(".");
    const flipMiddle = (v: string) => v.slice(0, 5) + (v[5] === "A" ? "B" : "A") + v.slice(6);

    const cases: [string, (c: { challenge: string; code: string }) => { id?: string; challenge?: string; code?: string }][] = [
      ["a wrong code", (c) => ({ code: wrongCode(c.code) })],
      ["an altered expiry (extended)", (c) => ({ challenge: replaceField(c.challenge, 1, (v) => String(Number(v) + 600)) })],
      ["an altered expiry (padded)", (c) => ({ challenge: replaceField(c.challenge, 1, (v) => `0${v}`) })],
      ["an altered digest", (c) => ({ challenge: replaceField(c.challenge, 2, flipMiddle) })],
      ["an altered tag", (c) => ({ challenge: replaceField(c.challenge, 3, flipMiddle) })],
      ["another id", (c) => ({ id: "b2", challenge: c.challenge, code: c.code })],
      ["a code without a challenge", (c) => ({ code: c.code })],
      ["a challenge without a code", (c) => ({ challenge: c.challenge })],
      ["a code that is too short", () => ({ code: "1234567" })],
      ["a code that is too long", (c) => ({ code: `${c.code}0` })],
      ["a code with a letter", (c) => ({ code: `${c.code.slice(0, 7)}x` })],
      ["a code with a non-ASCII digit", (c) => ({ code: `${c.code.slice(0, 7)}٣` })],
      ["a garbled challenge", () => ({ challenge: "not-a-challenge" })],
    ];

    it.each(cases)("refuses %s with no request to Home Assistant, no DELETE, and neither code in the message", async (_name, make) => {
      const { challenge, code, fake } = await issued();
      const args = { id: "a1", challenge, code, ...make({ challenge, code }) } as Record<string, unknown>;
      for (const key of Object.keys(args)) if (args[key] === undefined) delete args[key];
      if (_name.startsWith("a code without")) delete args.challenge;
      if (_name.startsWith("a challenge without")) delete args.code;
      const r = await callToolWithEnv(CONFIRM_SETTINGS, "delete_automation", args);
      expect(r.isError, r.text).toBe(true);
      expect(r.text).toMatch(/Nothing was deleted/);
      expect(spy.requests).toHaveLength(0);
      expect(deletes(fake)).toEqual([]);
      expectNoCode(r.text, code);
      if (typeof args.code === "string") expectNoCode(r.text, args.code);
    });

    it("refuses an expired challenge (a mocked clock) and says so", async () => {
      const clock = fakeClock();
      const { challenge, code, fake } = await issued();
      clock.advance(299_000);
      const early = await finishDelete("a1", challenge, code);
      expect(early.isError, early.text).toBe(false);
      expect(deletes(fake)).toHaveLength(1);

      const second = await issued();
      clock.advance(301_000);
      spy.requests.length = 0;
      const late = await finishDelete("a1", second.challenge, second.code);
      expect(late.isError).toBe(true);
      expect(late.text).toMatch(/expired/);
      expect(spy.requests).toHaveLength(0);
      expect(deletes(second.fake)).toEqual([]);
      expectNoCode(late.text, second.code);
    });

    it("refuses when the automation changed after the code was sent, after the read and before the DELETE", async () => {
      const { challenge, code, fake } = await issued();
      fake.stored.set("a1", { ...structuredClone(stored), alias: "Changed after the code was sent" });
      const r = await finishDelete("a1", challenge, code);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/changed after the code was sent/);
      expect(r.text).toMatch(/Nothing was deleted/);
      expect(deletes(fake)).toEqual([]);
      expect(spy.requests.map((q) => q.method)).toEqual(["GET"]);
      expectNoCode(r.text, code);
    });

    it("refuses a challenge made under another HA_TOKEN, and refuses both calls with an empty HA_TOKEN before any request", async () => {
      const { challenge, code, fake } = await issued();
      const other = await callToolWithEnv({ ...CONFIRM_SETTINGS, HA_TOKEN: "another-token" }, "delete_automation", { id: "a1", challenge, code });
      expect(other.isError).toBe(true);
      expect(other.text).toMatch(/does not match/);
      expect(deletes(fake)).toEqual([]);
      expect(spy.requests).toHaveLength(0);

      for (const args of [{ id: "a1" }, { id: "a1", challenge, code }]) {
        const r = await callToolWithEnv({ ...CONFIRM_SETTINGS, HA_TOKEN: "" }, "delete_automation", args);
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/HA_TOKEN is empty/);
      }
      expect(spy.requests).toHaveLength(0);
    });

    it("a challenge for one automation does not open another, and two live challenges work independently", async () => {
      const fake = house();
      const a = await requestDelete("a1");
      const codeA = await lastCode(spy);
      const b = await requestDelete("b2");
      const codeB = await lastCode(spy);
      expect((await finishDelete("a1", b.json.challenge, codeB)).isError).toBe(true);
      expect((await finishDelete("b2", a.json.challenge, codeA)).isError).toBe(true);
      expect((await finishDelete("a1", a.json.challenge, codeB)).isError).toBe(true);
      expect(deletes(fake)).toEqual([]);
      expect((await finishDelete("a1", a.json.challenge, codeA)).isError).toBe(false);
      expect((await finishDelete("b2", b.json.challenge, codeB)).isError).toBe(false);
      expect(deletes(fake)).toHaveLength(2);
    });
  });

  it("replay: a second call 2 after a delete is the 404 refusal; the same config re-created is deleted again, another config is refused", async () => {
    const fake = house();
    const first = await requestDelete("a1");
    const code = await lastCode(spy);
    expect((await finishDelete("a1", first.json.challenge, code)).isError).toBe(false);

    const again = await finishDelete("a1", first.json.challenge, code);
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/No config with id a1/);
    expect(deletes(fake)).toHaveLength(1);

    fake.stored.set("a1", structuredClone(stored));
    expect((await finishDelete("a1", first.json.challenge, code)).isError).toBe(false);
    expect(deletes(fake)).toHaveLength(2);

    fake.stored.set("a1", { ...structuredClone(stored), actions: [] });
    const other = await finishDelete("a1", first.json.challenge, code);
    expect(other.isError).toBe(true);
    expect(other.text).toMatch(/changed after the code was sent/);
    expect(deletes(fake)).toHaveLength(2);
  });

  it("holds no state on the server: a second server verifies a challenge the first one issued", async () => {
    const fake = house();
    const first = await requestDelete("a1");
    const code = await lastCode(spy);
    // Every callToolWithEnv builds a new server and transport; none of them keeps anything.
    const r = await finishDelete("a1", first.json.challenge, code);
    expect(r.isError, r.text).toBe(false);
    expect(deletes(fake)).toHaveLength(1);
  });

  it("calls the DELETE after every check: a config that changed is refused before any registry read", async () => {
    const { challenge, code, fake } = await (async () => {
      const f = house();
      const first = await requestDelete("a1");
      const c = await lastCode(spy);
      spy.requests.length = 0;
      return { challenge: first.json.challenge as string, code: c, fake: f };
    })();
    fake.stored.set("a1", { ...structuredClone(stored), mode: "queued" });
    const commandsBefore = fake.commands.length;
    const opened = fake.opened;
    await finishDelete("a1", challenge, code);
    expect(fake.commands).toHaveLength(commandsBefore);
    expect(fake.opened).toBe(opened);
  });
});

describe("delete_automation: the settings", () => {
  const callBoth = async (settings: Parameters<typeof callToolWithEnv>[0]) => {
    const one = await callToolWithEnv(settings, "delete_automation", { id: "a1" });
    const requestsOne = spy.requests.length;
    // Call 2 with garbage: the setting must refuse first, whatever the challenge looks like.
    const two = await callToolWithEnv(settings, "delete_automation", { id: "a1", challenge: "x", code: "12345678" });
    return { one, two, requestsOne, requestsTotal: spy.requests.length };
  };

  const refused: [string, Record<string, string>, RegExp][] = [
    ["absent", {}, /DELETE_CONFIRMATION_NOTIFY_SERVICE is not set/],
    ["blank", { DELETE_CONFIRMATION_NOTIFY_SERVICE: "   " }, /DELETE_CONFIRMATION_NOTIFY_SERVICE is not set/],
    ["only the notify prefix", { DELETE_CONFIRMATION_NOTIFY_SERVICE: "notify." }, /is not set/],
    ["invalid (space)", { DELETE_CONFIRMATION_NOTIFY_SERVICE: "Mobile App" }, /not a notify service name/],
    ["invalid (hyphen)", { DELETE_CONFIRMATION_NOTIFY_SERVICE: "mobile-app" }, /not a notify service name/],
    ["invalid (dot)", { DELETE_CONFIRMATION_NOTIFY_SERVICE: "notify.a.b" }, /not a notify service name/],
    ["send_message", { DELETE_CONFIRMATION_NOTIFY_SERVICE: "notify.send_message" }, /cannot deliver a code/],
    ["persistent_notification", { DELETE_CONFIRMATION_NOTIFY_SERVICE: "persistent_notification" }, /cannot deliver a code/],
    ["valid but not on the allowlist", { DELETE_CONFIRMATION_NOTIFY_SERVICE: "mobile_app_phone", ALLOWED_NOTIFY_SERVICES: "other" }, /ALLOWED_NOTIFY_SERVICES is set and does not list it/],
    ["valid with an empty allowlist", { DELETE_CONFIRMATION_NOTIFY_SERVICE: "mobile_app_phone", ALLOWED_NOTIFY_SERVICES: "" }, /ALLOWED_NOTIFY_SERVICES is set and does not list it/],
    ["a good setting with an unusable allowlist entry for it", { DELETE_CONFIRMATION_NOTIFY_SERVICE: "mobile_app_phone", ALLOWED_NOTIFY_SERVICES: " , " }, /does not list it/],
  ];

  it.each(refused)("%s: both calls are refused before any request, naming the setting", async (_name, settings, pattern) => {
    const fake = house();
    const { one, two, requestsTotal } = await callBoth(settings);
    for (const r of [one, two]) {
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(pattern);
      expect(r.text).toMatch(/Confirmation is not set up/);
      expect(r.text).toMatch(/Nothing was deleted/);
    }
    expect(requestsTotal).toBe(0);
    expect(deletes(fake)).toEqual([]);
  });

  const allowed: [string, Record<string, string>][] = [
    ["valid, allowlist absent", { DELETE_CONFIRMATION_NOTIFY_SERVICE: "notify.mobile_app_phone" }],
    ["valid without the prefix, in any case, padded", { DELETE_CONFIRMATION_NOTIFY_SERVICE: "  Mobile_App_Phone " }],
    ["valid with a list that includes it", { DELETE_CONFIRMATION_NOTIFY_SERVICE: "mobile_app_phone", ALLOWED_NOTIFY_SERVICES: "other, notify.Mobile_App_Phone" }],
  ];

  it.each(allowed)("%s: call 1 goes on and the phone service is the one named", async (_name, settings) => {
    house();
    const r = await callToolWithEnv(settings, "delete_automation", { id: "a1" });
    expect(r.isError, r.text).toBe(false);
    expect(notifyPosts().map((q) => new URL(q.url).pathname)).toEqual(["/api/services/notify/mobile_app_phone"]);
  });

  describe("with the system-action block off", () => {
    it("refuses call 1 and call 2 before any request, whatever the notify setting says, naming the block", async () => {
      for (const settings of [{ ...CONFIRM_SETTINGS }, {}, { DELETE_CONFIRMATION_NOTIFY_SERVICE: "persistent_notification" }]) {
        const fake = house();
        spy.requests.length = 0;
        const { one, two, requestsTotal } = await callBoth({ ...settings, ALLOW_SYSTEM_ACTIONS: "true" });
        for (const r of [one, two]) {
          expect(r.isError).toBe(true);
          expect(r.text).toMatch(/system-action block/);
          expect(r.text).toContain("ALLOW_SYSTEM_ACTIONS");
          expect(r.text).toMatch(/Nothing was deleted/);
        }
        expect(requestsTotal).toBe(0);
        expect(fake.acting).toEqual([]);
      }
    });

    it.each(["TRUE", "1", "", "yes", " true"])("%j leaves the block on, so the delete goes on", async (value) => {
      house();
      const r = await callToolWithEnv({ ...CONFIRM_SETTINGS, ALLOW_SYSTEM_ACTIONS: value }, "delete_automation", { id: "a1" });
      expect(r.isError, r.text).toBe(false);
      expect(r.json.status).toBe("confirmation_required");
    });

    it("with the block on, an automation that runs sql.query after 1000 trivial steps is refused by upsert_automation", async () => {
      const fake = house();
      const actions = [...Array.from({ length: 1000 }, () => ({ delay: { seconds: 1 } })), { action: "sql.query", data: { query: "SELECT 1" } }];
      const r = await callTool("upsert_automation", { id: "n1", config: { alias: "x", triggers: [{ trigger: "sun", event: "sunset" }], actions } });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^Refused by this server's safety policy/);
      expect(fake.acting).toEqual([]);
    });
  });
});

describe("delete_automation: the notify call fails", () => {
  const SECRET = "HA-PRIVATE-TEXT-do-not-repeat";
  const cases: [string, (request: Request) => Response | Promise<Response>, RegExp, boolean][] = [
    ["400", () => Response.json({ message: SECRET }, { status: 400 }), /HTTP 400.*may not have been sent/s, false],
    ["401", () => Response.json({ message: SECRET }, { status: 401 }), /HTTP 401.*administrator/s, false],
    ["403", () => Response.json({ message: SECRET }, { status: 403 }), /HTTP 403.*banned/s, false],
    ["500", () => new Response(SECRET, { status: 500 }), /HTTP 500.*may or may not have been sent/s, true],
    [
      "a network error",
      () => {
        throw new TypeError(SECRET);
      },
      /gave no answer.*may have been sent/s,
      true,
    ],
    ["a timeout", stall, /gave no answer.*may have been sent/s, true],
  ];

  it.each(cases)("%s: refused with no challenge and no DELETE, and Home Assistant's text is not repeated", async (_name, answer, pattern, mayHaveArrived) => {
    const fake = house({ onRequest: (request) => (new URL(request.url).pathname.startsWith("/api/services/notify/") ? answer(request) : undefined) });
    const r = await requestDelete("a1");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(pattern);
    expect(r.text).toMatch(/Nothing was deleted/);
    expect(r.text).toMatch(/not retried|nothing was retried/i);
    expect(r.text).not.toContain(SECRET);
    expect(r.text).not.toContain("dc1.");
    if (mayHaveArrived) {
      expect(r.text).toMatch(/may have arrived/);
      expect(r.text).toMatch(/cannot be used/);
    }
    expect(notifyPosts()).toHaveLength(1);
    expect(deletes(fake)).toEqual([]);
  });

  it("a 400 also says a code may have arrived and cannot be used", async () => {
    house({ onRequest: (request) => (new URL(request.url).pathname.startsWith("/api/services/notify/") ? Response.json({}, { status: 400 }) : undefined) });
    const r = await requestDelete("a1");
    expect(r.text).toMatch(/may have arrived/);
    expect(r.text).toMatch(/cannot be used/);
  });
});

describe("delete_automation: time and logs", () => {
  it("call 1 stays within 35 s of mocked time with a stalled registry read, and uses 10, 10 and 15 s limits", async () => {
    house({ ws: "silence" });
    const r = await requestDelete("a1");
    expect(r.isError, r.text).toBe(false);
    expect(delays.filter((d) => d >= 4000)).toEqual([10_000, 10_000, 15_000]);
    expect((await sentNotifications(spy))[0]!.message).toContain("entity unavailable");
  });

  it("call 1 with a stalled config read ends at 10 s, and with a stalled notify at 15 s, sending nothing more", async () => {
    const fake = house({ onRequest: (request) => (new URL(request.url).pathname.startsWith("/api/config/") ? stall(request) : undefined) });
    const noRead = await requestDelete("a1");
    expect(noRead.isError).toBe(true);
    expect(delays.filter((d) => d >= 4000)).toEqual([10_000]);
    expect(notifyPosts()).toHaveLength(0);
    expect(deletes(fake)).toEqual([]);

    delays.length = 0;
    house({ onRequest: (request) => (new URL(request.url).pathname.startsWith("/api/services/notify/") ? stall(request) : undefined) });
    const noNotify = await requestDelete("a1");
    expect(noNotify.isError).toBe(true);
    expect(delays.filter((d) => d >= 4000)).toEqual([10_000, 10_000, 15_000]);
  });

  it("call 2 asks for the same limits as the delete always did: 10, 10 and 20 s", async () => {
    house({ onRequest: (request) => (request.method === "DELETE" ? stall(request) : undefined) });
    const first = await requestDelete("a1");
    const code = await lastCode(spy);
    delays.length = 0;
    const r = await finishDelete("a1", first.json.challenge, code);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/outcome unknown/);
    expect(delays.filter((d) => d >= 4000)).toEqual([10_000, 10_000, 20_000]);
  });

  it("calls no console method with the code or the challenge", async () => {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    house();
    const first = await requestDelete("a1");
    const code = await lastCode(spy);
    await finishDelete("a1", first.json.challenge, code);
    await finishDelete("a1", first.json.challenge, code);
    for (const s of spies) {
      const text = s.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expectNoCode(text, code);
      expect(text).not.toContain(first.json.challenge);
    }
  });
});

describe("delete_automation: the code does not come back through the read tools", () => {
  it("get_entity, list_entities, get_history, list_automations and get_automation return nothing that holds the code", async () => {
    house();
    const first = await requestDelete("a1");
    const code = await lastCode(spy);
    const replies: ToolReply[] = [
      await callTool("get_entity", { entity_id: "automation.porch_light" }),
      await callTool("list_entities", {}),
      await callTool("get_history", { entity_id: "automation.porch_light" }),
      await callTool("list_automations", {}),
      await callTool("get_automation", { id: "a1" }),
    ];
    for (const r of replies) {
      expectNoCode(r.text, code);
      expect(r.text).not.toContain(first.json.challenge);
    }
  });
});

describe("delete_automation: registration and wording", () => {
  it("describes the two calls, the owner, and never guessing; the input has challenge and code; still destructive", async () => {
    const { listTools } = await import("../helpers/mcp");
    const tool = (await listTools()).find((t) => t.name === "delete_automation")!;
    expect(tool.description).toMatch(/two calls/);
    expect(tool.description).toMatch(/Call 1: pass only `id`/);
    expect(tool.description).toMatch(/confirmation_required/);
    expect(tool.description).toMatch(/you are never shown the code/);
    expect(tool.description).toMatch(/ask them to read you the code/);
    expect(tool.description).toMatch(/Never guess, invent, search for or reuse a code/);
    expect(tool.description).toMatch(/confirmation is not set up, tell the owner/);
    expect(tool.description).toMatch(/deleted_config/);
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["id", "challenge", "code"]);
    expect(tool.inputSchema.required).toEqual(["id"]);
    expect(tool.annotations?.destructiveHint).toBe(true);
    expect(tool.annotations?.readOnlyHint).toBe(false);
    expect(tool.inputSchema.properties.challenge.description).toMatch(/exactly as call 1 returned/);
    expect(tool.inputSchema.properties.code.description).toMatch(/Never guess/);
  });

  it("the unknown-outcome error and the upsert_automation description say two calls", async () => {
    const { listTools } = await import("../helpers/mcp");
    const upsert = (await listTools()).find((t) => t.name === "upsert_automation")!;
    expect(upsert.description).toMatch(/undo a create with delete_automation \(two calls; the owner reads you a code; needs the system-action block on\)/);

    house({ onRequest: (request) => (request.method === "DELETE" ? new Response("boom", { status: 500 }) : undefined) });
    const first = await requestDelete("a1");
    const code = await lastCode(spy);
    const r = await finishDelete("a1", first.json.challenge, code);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/repeat delete_automation with the two calls/);
    expect(r.text).toMatch(/reuse the challenge and code while the challenge has not expired, otherwise call with only `id` for a new code/);
  });
});
