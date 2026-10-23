import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../../src/index";
import { haWsCommands, HaWsError, type HaWsCommand } from "../../src/ha/ws";
import { installFetchSpy } from "../helpers/fetch";

type Msg = Record<string, unknown>;
type Reply = Msg | "silence";

interface FakeHa {
  /** Everything the helper sent, parsed, in order. */
  received: Msg[];
  closed: () => boolean;
  /** Sends a message from the fake server at a moment the test chooses. */
  reply: (m: Msg) => void;
}

const testEnv = env as unknown as Env;
const fetchSpy = installFetchSpy();

/**
 * Queues a fetch response that upgrades to a fake Home Assistant socket. `onCommand`
 * answers each command (not the auth message); the default succeeds with `{ echo: type }`.
 */
function fakeHa(opts: {
  authReply?: Msg;
  onCommand?: (msg: Msg) => Reply | Reply[];
  sendAuthRequired?: boolean;
  /** Makes the helper's own `send` throw for a message it matches, as a socket that is closing does. */
  throwOnSend?: (msg: Msg) => boolean;
} = {}): FakeHa {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  let closed = false;
  const send = (m: Msg) => server.send(JSON.stringify(m));
  const state: FakeHa = { received: [], closed: () => closed, reply: send };
  server.addEventListener("close", () => {
    closed = true;
  });
  server.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data as string) as Msg;
    state.received.push(msg);
    if (msg["type"] === "auth") {
      send(opts.authReply ?? { type: "auth_ok", ha_version: "2026.10.2" });
      return;
    }
    const replies = (opts.onCommand ?? ((m) => ({ id: m["id"], type: "result", success: true, result: { echo: m["type"] } })))(msg);
    for (const reply of Array.isArray(replies) ? replies : [replies]) {
      if (reply !== "silence") send(reply);
    }
  });
  if (opts.throwOnSend) {
    const original = client.send.bind(client);
    client.send = (data: string | ArrayBuffer | ArrayBufferView) => {
      if (typeof data === "string" && opts.throwOnSend!(JSON.parse(data) as Msg)) throw new TypeError("socket is closing");
      original(data);
    };
  }
  fetchSpy.respondOnce(() => new Response(null, { status: 101, webSocket: client }));
  if (opts.sendAuthRequired !== false) {
    queueMicrotask(() => send({ type: "auth_required", ha_version: "2026.10.2" }));
  }
  return state;
}

const ok = (id: unknown, result: unknown = null): Msg => ({ id, type: "result", success: true, result });
const fail = (id: unknown, code: string, message: string): Msg => ({
  id,
  type: "result",
  success: false,
  error: { code, message },
});
const cmd = (type: string, extra: Msg = {}): HaWsCommand => ({ message: { type, ...extra } });
/** Waits for the fake server to see the close, then lets the event loop turn so any late message would have arrived. */
async function settled(ha: FakeHa): Promise<void> {
  await vi.waitFor(() => expect(ha.closed()).toBe(true));
  await new Promise((r) => setTimeout(r, 50));
}
const commandsSent = (ha: FakeHa) => ha.received.filter((m) => m["type"] !== "auth");

afterEach(() => {
  vi.useRealTimers();
});

describe("haWsCommands", () => {
  it("opens the socket with an Upgrade header, authenticates and returns results in order", async () => {
    const ha = fakeHa();
    const results = await haWsCommands(testEnv, [cmd("config/entity_registry/list"), cmd("lovelace/config", { url_path: null })]);

    expect(results).toEqual([
      { success: true, result: { echo: "config/entity_registry/list" } },
      { success: true, result: { echo: "lovelace/config" } },
    ]);
    expect(fetchSpy.requests).toHaveLength(1);
    expect(fetchSpy.requests[0]!.url).toBe("https://ha.test/api/websocket");
    expect(fetchSpy.requests[0]!.headers.get("Upgrade")).toBe("websocket");
    expect(ha.received[0]).toEqual({ type: "auth", access_token: testEnv.HA_TOKEN });
    expect(commandsSent(ha)).toEqual([
      { type: "config/entity_registry/list", id: 1 },
      { type: "lovelace/config", url_path: null, id: 2 },
    ]);
    await vi.waitFor(() => expect(ha.closed()).toBe(true));
  });

  it("sends command k+1 only after command k's result arrives", async () => {
    const ha = fakeHa({ onCommand: () => "silence" });
    const pending = haWsCommands(testEnv, [cmd("a"), cmd("b")]);
    await vi.waitFor(() => expect(commandsSent(ha)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(commandsSent(ha)).toEqual([{ type: "a", id: 1 }]);
    ha.reply(ok(1, "first"));
    await vi.waitFor(() => expect(commandsSent(ha)).toHaveLength(2));
    ha.reply(ok(2, "second"));
    await expect(pending).resolves.toEqual([
      { success: true, result: "first" },
      { success: true, result: "second" },
    ]);
  });

  it("rejects on auth_invalid without sending a command or retrying, and names the likely causes", async () => {
    const ha = fakeHa({ authReply: { type: "auth_invalid", message: "Invalid access token or password" } });
    const error = await haWsCommands(testEnv, [cmd("a")]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HaWsError);
    const e = error as HaWsError;
    expect(e.code).toBe("auth_invalid");
    expect(e.message).toMatch(/revoked/);
    expect(e.message).toMatch(/inactive/);
    expect(e.message).toMatch(/local-only/);
    expect(commandsSent(ha)).toHaveLength(0);
    expect(fetchSpy.requests).toHaveLength(1);
    await vi.waitFor(() => expect(ha.closed()).toBe(true));
  });

  it("never puts the token in an error message", async () => {
    fakeHa({ authReply: { type: "auth_invalid", message: `bad token ${testEnv.HA_TOKEN}` } });
    const e1 = (await haWsCommands(testEnv, [cmd("a")]).catch((e: unknown) => e)) as Error;
    expect(e1.message).not.toContain(testEnv.HA_TOKEN);

    fakeHa({ onCommand: (m) => fail(m["id"], "unknown_error", "boom") });
    const e2 = (await haWsCommands(testEnv, [cmd("a")]).catch((e: unknown) => e)) as Error;
    expect(e2.message).not.toContain(testEnv.HA_TOKEN);
  });

  it("stops at the first error result and never sends the next command", async () => {
    const ha = fakeHa({
      onCommand: (m) => (m["id"] === 2 ? fail(2, "unauthorized", "Unauthorized") : ok(m["id"])),
    });
    const error = (await haWsCommands(testEnv, [cmd("a"), cmd("b"), cmd("c")]).catch((e: unknown) => e)) as HaWsError;

    expect(error).toBeInstanceOf(HaWsError);
    expect(error.code).toBe("unauthorized");
    expect(error.message).toContain("unauthorized");
    expect(error.message).toContain("Unauthorized");
    expect(commandsSent(ha).map((m) => m["type"])).toEqual(["a", "b"]);
    await settled(ha);
    expect(commandsSent(ha).map((m) => m["type"])).toEqual(["a", "b"]);
  });

  it("returns an allowed error code as that command's result and carries on", async () => {
    const ha = fakeHa({
      onCommand: (m) => (m["id"] === 1 ? fail(1, "config_not_found", "No config found.") : ok(m["id"], "saved")),
    });
    const results = await haWsCommands(testEnv, [
      { message: { type: "lovelace/config" }, allowErrorCodes: ["config_not_found"] },
      cmd("lovelace/config/save"),
    ]);

    expect(results).toEqual([
      { success: false, error: { code: "config_not_found", message: "No config found." } },
      { success: true, result: "saved" },
    ]);
    expect(commandsSent(ha)).toHaveLength(2);
  });

  it("does not allow an error code that was not listed", async () => {
    const ha = fakeHa({ onCommand: (m) => fail(m["id"], "home_assistant_error", "nope") });
    await expect(
      haWsCommands(testEnv, [{ message: { type: "a" }, allowErrorCodes: ["config_not_found"] }, cmd("b")]),
    ).rejects.toThrow(/home_assistant_error/);
    await settled(ha);
    expect(commandsSent(ha)).toHaveLength(1);
  });

  it("aborts when check throws, before the next command is sent", async () => {
    const ha = fakeHa({ onCommand: (m) => ok(m["id"], { mode: "yaml" }) });
    const seen: unknown[] = [];
    const error = await haWsCommands(testEnv, [
      {
        message: { type: "lovelace/dashboards/list" },
        check: (r) => {
          seen.push(r);
          throw new Error("Dashboard is in YAML mode; refusing to save.");
        },
      },
      cmd("lovelace/config/save"),
    ]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Dashboard is in YAML mode; refusing to save.");
    expect(seen).toEqual([{ success: true, result: { mode: "yaml" } }]);
    expect(commandsSent(ha).map((m) => m["type"])).toEqual(["lovelace/dashboards/list"]);
    await settled(ha);
    expect(commandsSent(ha).map((m) => m["type"])).toEqual(["lovelace/dashboards/list"]);
  });

  it("runs check with an allowed error result, and continues when check returns", async () => {
    fakeHa({ onCommand: (m) => (m["id"] === 1 ? fail(1, "config_not_found", "x") : ok(m["id"])) });
    const check = vi.fn();
    await haWsCommands(testEnv, [
      { message: { type: "a" }, allowErrorCodes: ["config_not_found"], check },
      cmd("b"),
    ]);
    expect(check).toHaveBeenCalledWith({ success: false, error: { code: "config_not_found", message: "x" } });
  });

  it("honours commands that a check appends to the list it was given, on the same connection and in order", async () => {
    const ha = fakeHa({ onCommand: (m) => ok(m["id"], `done ${String(m["type"])}`) });
    const commands: HaWsCommand[] = [];
    const seen: unknown[] = [];
    commands.push({
      message: { type: "first" },
      check: (r) => {
        seen.push(r);
        // The list is read lazily: a check may add what the walk needs next, even after an await.
        commands.push({
          message: { type: "second" },
          check: async () => {
            await Promise.resolve();
            commands.push(cmd("third"));
          },
        });
      },
    });
    const results = await haWsCommands(testEnv, commands);

    expect(commandsSent(ha).map((m) => m["type"])).toEqual(["first", "second", "third"]);
    expect(commandsSent(ha).map((m) => m["id"])).toEqual([1, 2, 3]);
    expect(results.map((r) => (r.success ? r.result : null))).toEqual(["done first", "done second", "done third"]);
    expect(seen).toEqual([{ success: true, result: "done first" }]);
    expect(fetchSpy.requests).toHaveLength(1);
  });

  it("stops when a check appends nothing, and sends nothing after a check that appends then throws", async () => {
    const ha = fakeHa();
    const list: HaWsCommand[] = [{ message: { type: "only" }, check: () => undefined }];
    await expect(haWsCommands(testEnv, list)).resolves.toHaveLength(1);
    expect(commandsSent(ha)).toHaveLength(1);

    const ha2 = fakeHa();
    const list2: HaWsCommand[] = [];
    list2.push({
      message: { type: "a" },
      check: () => {
        list2.push(cmd("never"));
        throw new Error("refused");
      },
    });
    await expect(haWsCommands(testEnv, list2)).rejects.toThrow("refused");
    expect(commandsSent(ha2).map((m) => m["type"])).toEqual(["a"]);
  });

  it("rejects when the response carries no webSocket, without sending anything", async () => {
    fetchSpy.respondOnce(new Response("Not here", { status: 200 }));
    await expect(haWsCommands(testEnv, [cmd("a")])).rejects.toThrow(/did not upgrade.*HTTP 200/);
    expect(fetchSpy.requests).toHaveLength(1);
  });

  it("times out after 10 s overall and closes the socket", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ha = fakeHa({ sendAuthRequired: false });
    const pending = haWsCommands(testEnv, [cmd("a")]).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(ha.closed()).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const error = (await pending) as Error;
    expect(error.message).toMatch(/timed out after 10 s/);
    vi.useRealTimers();
    await vi.waitFor(() => expect(ha.closed()).toBe(true));
    expect(commandsSent(ha)).toHaveLength(0);
  });

  it("rejects when Home Assistant closes the socket mid-sequence", async () => {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    server.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data as string) as Msg;
      if (msg["type"] === "auth") server.send(JSON.stringify({ type: "auth_ok" }));
      else server.close(1011, "going away");
    });
    fetchSpy.respondOnce(() => new Response(null, { status: 101, webSocket: client }));
    queueMicrotask(() => server.send(JSON.stringify({ type: "auth_required" })));

    await expect(haWsCommands(testEnv, [cmd("a")])).rejects.toThrow(/closed the WebSocket/);
  });

  describe("a send that throws", () => {
    // Well under the 10 s time limit: the call must not wait for it.
    const PROMPT_MS = 1_000;

    async function rejectsPromptly(promise: Promise<unknown>): Promise<HaWsError> {
      const started = Date.now();
      const error = await Promise.race([
        promise.catch((e: unknown) => e),
        new Promise<string>((r) => setTimeout(() => r("still waiting"), PROMPT_MS)),
      ]);
      expect(error, "the call should reject without waiting for the time limit").toBeInstanceOf(HaWsError);
      expect(Date.now() - started).toBeLessThan(PROMPT_MS);
      return error as HaWsError;
    }

    it("rejects promptly when the auth message cannot be sent, with no code, and closes the socket", async () => {
      const ha = fakeHa({ throwOnSend: (m) => m["type"] === "auth" });
      const error = await rejectsPromptly(haWsCommands(testEnv, [cmd("a")]));
      expect(error.code).toBeUndefined();
      expect(error.message).toMatch(/Sending to the Home Assistant WebSocket failed/);
      expect(error.message).not.toContain(testEnv.HA_TOKEN);
      await vi.waitFor(() => expect(ha.closed()).toBe(true));
      expect(ha.received).toHaveLength(0);
    });

    it("rejects promptly when the first command cannot be sent, with no code, and closes the socket", async () => {
      const ha = fakeHa({ throwOnSend: (m) => m["type"] === "a" });
      const error = await rejectsPromptly(haWsCommands(testEnv, [cmd("a"), cmd("b")]));
      expect(error.code).toBeUndefined();
      expect(error.message).toMatch(/Sending to the Home Assistant WebSocket failed/);
      await vi.waitFor(() => expect(ha.closed()).toBe(true));
      expect(commandsSent(ha)).toEqual([]);
    });

    it("rejects promptly when a later command, sent from the result handler, cannot be sent", async () => {
      const ha = fakeHa({ throwOnSend: (m) => m["type"] === "b" });
      const error = await rejectsPromptly(haWsCommands(testEnv, [cmd("a"), cmd("b"), cmd("c")]));
      expect(error.code).toBeUndefined();
      expect(error.message).toMatch(/Sending to the Home Assistant WebSocket failed/);
      await vi.waitFor(() => expect(ha.closed()).toBe(true));
      expect(commandsSent(ha)).toEqual([{ type: "a", id: 1 }]);
    });
  });

  it("returns an empty list without connecting when given no commands", async () => {
    await expect(haWsCommands(testEnv, [])).resolves.toEqual([]);
    expect(fetchSpy.requests).toHaveLength(0);
  });

  it("adds an administrator hint to an unauthorized command error", async () => {
    fakeHa({ onCommand: (m) => fail(m["id"], "unauthorized", "Unauthorized") });
    await expect(haWsCommands(testEnv, [cmd("config/entity_registry/list")])).rejects.toThrow(/administrator/);
  });

  it("ignores results for other ids", async () => {
    const ha = fakeHa({ onCommand: (m) => [ok(99, "stray"), fail(0, "unknown_error", "stray"), ok(m["id"], "mine")] });
    const results = await haWsCommands(testEnv, [cmd("a"), cmd("b")]);
    expect(results).toEqual([
      { success: true, result: "mine" },
      { success: true, result: "mine" },
    ]);
    expect(commandsSent(ha)).toHaveLength(2);
  });

  it("rejects when the first message is not auth_required, and sends no token", async () => {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    const received: string[] = [];
    server.addEventListener("message", (e) => received.push(e.data as string));
    fetchSpy.respondOnce(() => new Response(null, { status: 101, webSocket: client }));
    queueMicrotask(() => server.send(JSON.stringify({ type: "auth_ok" })));
    await expect(haWsCommands(testEnv, [cmd("a")])).rejects.toThrow(/Expected auth_required/);
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([]);
  });

  it("rejects on a message that is JSON null", async () => {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    fetchSpy.respondOnce(() => new Response(null, { status: 101, webSocket: client }));
    queueMicrotask(() => server.send("null"));
    await expect(haWsCommands(testEnv, [cmd("a")])).rejects.toThrow(/not a valid JSON object/);
  });

  it("sends nothing after a check abort, even when a later result arrives", async () => {
    const ha = fakeHa({ onCommand: () => "silence" });
    const pending = haWsCommands(testEnv, [
      {
        message: { type: "a" },
        check: () => {
          throw new Error("refused");
        },
      },
      cmd("b"),
    ]).catch((e: unknown) => e);
    await vi.waitFor(() => expect(commandsSent(ha)).toHaveLength(1));
    ha.reply(ok(1, "x"));
    expect(((await pending) as Error).message).toBe("refused");
    ha.reply(ok(2, "late"));
    await settled(ha);
    expect(commandsSent(ha).map((m) => m["type"])).toEqual(["a"]);
  });

  it("aborts the upgrade request when the 10 s limit passes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let signal: AbortSignal | undefined;
    fetchSpy.respondOnce(
      (request) =>
        new Promise<Response>((_, reject) => {
          signal = request.signal;
          request.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const pending = haWsCommands(testEnv, [cmd("a")]).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(signal?.aborted).toBe(true);
    expect(((await pending) as Error).message).toMatch(/timed out after 10 s/);
  });

  it("closes a socket that arrives after the time limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    let closed = false;
    server.addEventListener("close", () => {
      closed = true;
    });
    let release: (() => void) | undefined;
    fetchSpy.respondOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response(null, { status: 101, webSocket: client }));
        }),
    );
    const pending = haWsCommands(testEnv, [cmd("a")]).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(((await pending) as Error).message).toMatch(/timed out/);
    release?.();
    vi.useRealTimers();
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it("rejects an invalid or non-http HA_URL with a clear error and makes no request", async () => {
    await expect(haWsCommands({ ...testEnv, HA_URL: "not a url" }, [cmd("a")])).rejects.toThrow(/HA_URL is not a valid URL/);
    await expect(haWsCommands({ ...testEnv, HA_URL: "ftp://ha.test" }, [cmd("a")])).rejects.toThrow(/must start with http/);
    expect(fetchSpy.requests).toHaveLength(0);
  });
});
