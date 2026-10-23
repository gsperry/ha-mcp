import { describe, expect, it } from "vitest";
import type { Env } from "../../src/index";
import {
  HaError,
  buildHaUrl,
  haFetch,
  pathSegment,
  validateDomain,
  validateEntityId,
  validateService,
} from "../../src/ha/rest";
import { installFetchSpy } from "../helpers/fetch";

const TOKEN = "test-secret-token-value";
const env: Env = { HA_URL: "https://ha.example.test", HA_TOKEN: TOKEN, MCP_BEARER_TOKEN: "unused" };
const spy = installFetchSpy();

async function failure(p: Promise<unknown>): Promise<HaError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HaError);
    return e as HaError;
  }
  throw new Error("expected haFetch to throw");
}

describe("haFetch", () => {
  it("sends auth and JSON headers and parses a JSON body", async () => {
    spy.respondOnce(Response.json({ state: "on" }));
    const out = await haFetch(env, "/api/states/light.porch");
    expect(out).toEqual({ state: "on" });
    expect(spy.requests).toHaveLength(1);
    const req = spy.requests[0]!;
    expect(req.url).toBe("https://ha.example.test/api/states/light.porch");
    expect(req.method).toBe("GET");
    expect(req.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(req.headers.get("Content-Type")).toBe("application/json");
  });

  it("passes method and body through, and the caller cannot replace the Authorization header", async () => {
    spy.respondOnce(Response.json({ result: "ok" }));
    await haFetch(env, "/api/config/automation/config/a1", {
      method: "POST",
      body: JSON.stringify({ alias: "x", future_key: 1 }),
      headers: { Authorization: "Bearer other" },
    });
    const req = spy.requests[0]!;
    expect(req.method).toBe("POST");
    expect(await req.json()).toEqual({ alias: "x", future_key: 1 });
    expect(req.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("includes HA's validation message on a 400", async () => {
    spy.respondOnce(Response.json({ message: "Message malformed: extra keys not allowed" }, { status: 400 }));
    const err = await failure(haFetch(env, "/api/services/light/turn_on", { method: "POST", body: "{}" }));
    expect(err.status).toBe(400);
    expect(err.message).toContain("HTTP 400");
    expect(err.message).toContain("Message malformed: extra keys not allowed");
    expect(err.message).not.toContain(TOKEN);
  });

  it("names the credential causes on 401 and fetches exactly once", async () => {
    spy.respondAlways(new Response("401: Unauthorized", { status: 401 }));
    const err = await failure(haFetch(env, "/api/config"));
    expect(spy.requests).toHaveLength(1);
    expect(err.status).toBe(401);
    expect(err.message).toContain("HTTP 401");
    expect(err.message).toMatch(/revoked/);
    expect(err.message).toMatch(/not an administrator/);
    expect(err.message).toMatch(/local-only/);
    expect(err.message).not.toMatch(/ip_bans/);
    expect(err.message).not.toContain(TOKEN);
  });

  it("frames a 403 as Home Assistant's own ban answer, keeps its body and fetches exactly once", async () => {
    spy.respondAlways(new Response("403: Forbidden", { status: 403 }));
    const err = await failure(haFetch(env, "/api/config"));
    expect(spy.requests).toHaveLength(1);
    expect(err.status).toBe(403);
    expect(err.message).toContain("HTTP 403");
    expect(err.message).toContain("Home Assistant itself answered 403");
    expect(err.message).toMatch(/banned/);
    expect(err.message).toMatch(/ip_bans\.yaml/);
    expect(err.message).toMatch(/restart Home Assistant/);
    expect(err.message).toContain("403: Forbidden");
    expect(err.message).not.toMatch(/revoked/);
    expect(err.message).not.toMatch(/not an administrator/);
    expect(err.message).not.toContain(TOKEN);
  });

  it("marks a request that went out as sent, and a refusal before any request as not sent", async () => {
    spy.respondOnce(Response.json({ message: "no" }, { status: 400 }));
    expect((await failure(haFetch(env, "/api/states"))).sent).toBe(true);
    spy.respondOnce(() => {
      throw new TypeError("connection reset");
    });
    expect((await failure(haFetch(env, "/api/states"))).sent).toBe(true);
    const err = await failure(haFetch({ ...env, HA_URL: "not a url" }, "/api/states"));
    expect(err.sent).toBe(false);
    expect(spy.requests).toHaveLength(2);
  });

  it("reports a 404 with its body", async () => {
    spy.respondOnce(Response.json({ message: "Entity not found." }, { status: 404 }));
    const err = await failure(haFetch(env, "/api/states/light.missing"));
    expect(err.status).toBe(404);
    expect(err.message).toContain("HTTP 404");
    expect(err.message).toContain("Entity not found.");
  });

  it("truncates a long error body to 2 KB", async () => {
    spy.respondOnce(new Response("x".repeat(10_000), { status: 500 }));
    const err = await failure(haFetch(env, "/api/states"));
    expect(err.body.length).toBeLessThan(2100);
    expect(err.message.length).toBeLessThan(2300);
    expect(err.message).toContain("[truncated]");
  });

  it("returns text for a non-JSON success body", async () => {
    spy.respondOnce(new Response("<html>ok</html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    expect(await haFetch(env, "/api/")).toBe("<html>ok</html>");
  });

  it("includes a non-JSON error body in the message", async () => {
    spy.respondOnce(new Response("Bad Gateway from proxy", { status: 502 }));
    const err = await failure(haFetch(env, "/api/states"));
    expect(err.message).toContain("HTTP 502");
    expect(err.message).toContain("Bad Gateway from proxy");
  });

  it("times out, aborts the request and does not retry", async () => {
    let aborted = false;
    spy.respondAlways(
      (req) =>
        new Promise<Response>((_resolve, reject) => {
          req.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const err = await failure(haFetch(env, "/api/states", { timeoutMs: 20 }));
    expect(aborted).toBe(true);
    expect(spy.requests).toHaveLength(1);
    expect(err.message).toContain("did not answer");
    expect(err.status).toBeNull();
  });

  it("reports a network failure without the token and does not retry", async () => {
    spy.respondAlways(() => {
      throw new Error("connection refused");
    });
    const err = await failure(haFetch(env, "/api/states"));
    expect(spy.requests).toHaveLength(1);
    expect(err.message).toContain("connection refused");
    expect(err.message).not.toContain(TOKEN);
  });

  it("treats a redirect as an error instead of following it", async () => {
    spy.respondOnce(new Response(null, { status: 302, headers: { Location: "https://evil.example.test/" } }));
    const err = await failure(haFetch(env, "/api/states"));
    expect(err.status).toBe(302);
    expect(spy.requests).toHaveLength(1);
  });
});

describe("URL confinement", () => {
  it.each([
    "/api/../etc/passwd",
    "/api/%2e%2e/auth/token",
    "/api/%2E%2E/x",
    "/api/states/../../x",
    "/auth/token",
    "api",
    "/apix/states",
    "https://evil.example.test/api/states",
    "//evil.example.test/api/states",
    "/\\evil.example.test/api/states",
    "",
  ])("refuses %j without calling fetch", async (path) => {
    const err = await failure(haFetch(env, path));
    expect(err).toBeInstanceOf(HaError);
    expect(spy.requests).toHaveLength(0);
  });

  it("accepts a normal path and a query string", () => {
    expect(buildHaUrl(env, "/api/history/period?filter_entity_id=light.a").pathname).toBe("/api/history/period");
  });

  it("ignores a path or trailing slash on HA_URL and rejects bad HA_URL values", () => {
    expect(buildHaUrl({ ...env, HA_URL: "https://ha.example.test/" }, "/api/").href).toBe("https://ha.example.test/api/");
    expect(() => buildHaUrl({ ...env, HA_URL: "not a url" }, "/api/")).toThrow(HaError);
    expect(() => buildHaUrl({ ...env, HA_URL: "ftp://ha.example.test" }, "/api/")).toThrow(HaError);
  });
});

describe("pathSegment", () => {
  it("encodes slashes and dots so an id cannot escape /api/", () => {
    for (const id of ["a/../../b", "../x", "..%2f..", "%2e%2e", "a/b", "a?b#c"]) {
      const url = buildHaUrl(env, `/api/states/${pathSegment(id)}`);
      expect(url.origin).toBe("https://ha.example.test");
      expect(url.pathname.startsWith("/api/states/")).toBe(true);
      expect(url.pathname.slice("/api/states/".length)).not.toContain("/");
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
    }
    expect(pathSegment("a/b")).toBe("a%2Fb");
    expect(pathSegment("%2e%2e")).toBe("%252e%252e");
  });

  it.each(["", ".", ".."])("rejects %j", (v) => {
    expect(() => pathSegment(v)).toThrow(HaError);
  });

  it("keeps ordinary ids readable", () => {
    expect(pathSegment("1700000000000")).toBe("1700000000000");
  });
});

describe("validators", () => {
  it("accepts well-formed names", () => {
    expect(validateEntityId("light.porch_1")).toBe("light.porch_1");
    expect(validateDomain("light")).toBe("light");
    expect(validateService("turn_on")).toBe("turn_on");
  });

  it.each(["light", "Light.porch", "light.porch/../x", "light.", ".porch", "light.a.b", "light.a b", "", "../x.y"])(
    "rejects entity_id %j",
    (v) => {
      expect(() => validateEntityId(v)).toThrow(HaError);
    },
  );

  it.each(["", "Light", "a.b", "a/b", "..", "a b"])("rejects domain and service %j", (v) => {
    expect(() => validateDomain(v)).toThrow(HaError);
    expect(() => validateService(v)).toThrow(HaError);
  });
});
