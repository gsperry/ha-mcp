import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compatibility, getOAuth, sessionProps } from "../../src/oauth.js";
import { installFetchSpy } from "../helpers/fetch.js";
import {
  BEARER,
  CALLBACK,
  CLIENT_ID,
  MCP_URL,
  ORIGIN,
  PASSWORD,
  VERIFIER,
  authorizeQuery,
  baseEnv,
  call,
  clearKv,
  clientDocument,
  countingKv,
  exchange,
  getAuthorize,
  mcpList,
  obtainTokens,
  postAuthorize,
  postToken,
  refresh,
  spyConsole,
} from "../helpers/oauth.js";

const spy = installFetchSpy();
beforeEach(async () => {
  await clearKv();
  spy.respondAlways(clientDocument());
});
afterEach(() => vi.restoreAllMocks());

const METADATA = `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="mcp"`;
const WELL_FORMED = "owner:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("the 401 with OAuth on", () => {
  it("names the metadata when no token was presented, with an empty body", async () => {
    for (const authorization of [null, "Bearer ", "Basic abc", "abc"]) {
      const res = await mcpList(authorization);
      expect(res.status, String(authorization)).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe(`Bearer ${METADATA}`);
      expect(await res.text()).toBe("");
    }
  });

  it("adds error=invalid_token when a token was presented and refused", async () => {
    const tokens = await obtainTokens();
    const bearer = `Bearer ${tokens.access_token}`;
    // Sanity: the token is good before each way of refusing it.
    expect((await mcpList(bearer)).status).toBe(200);

    const lastCharacter = tokens.access_token.slice(-1);
    const tampered = `${tokens.access_token.slice(0, -1)}${lastCharacter === "a" ? "b" : "a"}`;

    const otherHost = await call(
      new Request("https://other.test/mcp", {
        method: "POST",
        headers: { Authorization: bearer, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );

    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3601 * 1000);
    const expired = await mcpList(bearer);
    clock.mockRestore();

    const oauth = getOAuth(baseEnv(), new URL(ORIGIN))!;
    await oauth.api.revokeGrant(tokens.access_token.split(":")[1]!, "owner");
    const revoked = await mcpList(bearer);

    const refused: [string, Response, string][] = [
      ["a wrong token", await mcpList("Bearer wrong"), ORIGIN],
      ["a malformed shape", await mcpList("Bearer owner:short:x"), ORIGIN],
      ["a tampered secret", await mcpList(`Bearer ${tampered}`), ORIGIN],
      ["a token for another host", otherHost, "https://other.test"],
      ["an expired token", expired, ORIGIN],
      ["a revoked grant", revoked, ORIGIN],
    ];
    for (const [name, res, origin] of refused) {
      expect(res.status, name).toBe(401);
      expect(res.headers.get("WWW-Authenticate"), name).toBe(
        `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mcp"`,
      );
      expect(await res.text(), name).toBe("");
    }
  });

  it("a malformed token shape causes no KV read", async () => {
    const { kv, calls } = countingKv();
    for (const bad of ["garbage", "owner:short:x", "a:b:c", "owner:aaaaaaaaaaaaaaaa:bbbb", `${WELL_FORMED}x`, "owner:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb!"]) {
      const res = await mcpList(`Bearer ${bad}`, { OAUTH_KV: kv });
      expect(res.status, bad).toBe(401);
    }
    expect(calls.total).toBe(0);
  });

  it("a well-formed token costs one KV read", async () => {
    const { kv, calls } = countingKv();
    expect((await mcpList(`Bearer ${WELL_FORMED}`, { OAUTH_KV: kv })).status).toBe(401);
    expect(calls.get).toHaveLength(1);
  });
});

describe("the static bearer next to OAuth", () => {
  it("works with OAuth on and with the KV namespace throwing, and touches no KV", async () => {
    const { kv, calls } = countingKv({ get: true, put: true, delete: true, list: true });
    const res = await mcpList(`Bearer ${BEARER}`, { OAUTH_KV: kv });
    expect(res.status).toBe(200);
    expect(calls.total).toBe(0);
  });

  it("is logged as auth static, and an OAuth token as auth oauth", async () => {
    const tokens = await obtainTokens();
    const log = spyConsole();
    try {
      const init = (authorization: string) =>
        call(
          new Request(MCP_URL, {
            method: "POST",
            headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "c", version: "1" } },
            }),
          }),
        );
      expect((await init(`Bearer ${BEARER}`)).status).toBe(200);
      expect((await init(`Bearer ${tokens.access_token}`)).status).toBe(200);
      const lines = log.text().split("\n").filter((l) => l.includes('"event":"initialize"'));
      expect(lines.map((l) => JSON.parse(l).auth)).toEqual(["static", "oauth"]);
      expect(log.text()).not.toContain(tokens.access_token);
    } finally {
      log.restore();
    }
  });
});

describe("an unreachable KV", () => {
  it("a well-formed token with KV.get throwing is 503 with Retry-After, never 200", async () => {
    const { kv } = countingKv({ get: true });
    const res = await mcpList(`Bearer ${WELL_FORMED}`, { OAUTH_KV: kv });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(await res.text()).toBe("");
  });

  it("a real token with KV.get throwing is 503", async () => {
    const tokens = await obtainTokens();
    const { kv } = countingKv({ get: true });
    expect((await mcpList(`Bearer ${tokens.access_token}`, { OAUTH_KV: kv })).status).toBe(503);
  });
});

describe("OAuth off", () => {
  const cases: [string, Record<string, undefined | string>][] = [
    ["the three OAuth bindings absent", { OAUTH_KV: undefined, SIGN_IN_LIMITER: undefined, OWNER_PASSWORD: undefined }],
    ["the KV binding absent", { OAUTH_KV: undefined }],
    ["the limiter absent", { SIGN_IN_LIMITER: undefined }],
    ["the password absent", { OWNER_PASSWORD: undefined }],
    ["the password empty", { OWNER_PASSWORD: "" }],
  ];

  it.each(cases)("with %s the Worker answers as the last release did", async (_name, overrides) => {
    const o = overrides as never;
    // /mcp: the same statuses and the bare challenge.
    const none = await mcpList(null, o);
    expect(none.status).toBe(401);
    expect(none.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await none.text()).toBe("");
    const wrong = await mcpList(`Bearer ${WELL_FORMED}`, o);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect((await call(new Request(MCP_URL, { method: "GET" }), o)).status).toBe(405);
    expect((await mcpList(null, o, { Origin: "https://evil.test" })).status).toBe(403);
    // The static bearer works.
    expect((await mcpList(`Bearer ${BEARER}`, o)).status).toBe(200);
    // Every OAuth path is 404 with an empty body.
    for (const [method, path] of [
      ["GET", "/authorize"],
      ["POST", "/authorize"],
      ["GET", "/oauth/token"],
      ["POST", "/oauth/token"],
      ["GET", "/.well-known/oauth-authorization-server"],
      ["GET", "/.well-known/oauth-protected-resource/mcp"],
    ] as const) {
      const res = await call(new Request(`${ORIGIN}${path}`, { method }), o);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.text()).toBe("");
    }
  });
});

describe("the compatibility flag", () => {
  it("with the flag reported false the Worker behaves as OAuth off; with it true, as on", async () => {
    const off = vi.spyOn(compatibility, "globalFetchStrictlyPublic").mockReturnValue(false);
    expect((await call(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`))).status).toBe(404);
    expect((await mcpList(null)).headers.get("WWW-Authenticate")).toBe("Bearer");
    expect((await mcpList(`Bearer ${BEARER}`)).status).toBe(200);
    off.mockReturnValue(true);
    expect((await call(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`))).status).toBe(200);
    expect((await mcpList(null)).headers.get("WWW-Authenticate")).toContain("resource_metadata");
  });

  it("the function's result equals what the library puts in its metadata", async () => {
    const doc = (await (await call(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`))).json()) as Record<string, unknown>;
    expect(compatibility.globalFetchStrictlyPublic()).toBe(true);
    expect(doc.client_id_metadata_document_supported).toBe(compatibility.globalFetchStrictlyPublic());
  });
});

describe("a password shorter than 24 characters", () => {
  const SHORT = "short-password-0123";

  it("keeps discovery and the token endpoint up and refuses the page, writing nothing", async () => {
    const { kv, calls } = countingKv();
    const o = { OWNER_PASSWORD: SHORT, OAUTH_KV: kv };
    expect((await call(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), o)).status).toBe(200);
    expect((await call(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`), o)).status).toBe(200);
    // The token endpoint answers as usual: an unknown code is the library's invalid_grant.
    const token = await exchange("owner:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", {}, o);
    expect(token.status).toBe(400);
    expect(((await token.json()) as { error: string }).error).toBe("invalid_grant");
    // The page is 503 for GET and POST.
    expect((await getAuthorize({}, o)).status).toBe(503);
    expect((await postAuthorize({ decision: "allow", password: SHORT }, { env: o })).status).toBe(503);
    expect(calls.put).toEqual([]);
    expect(calls.delete).toEqual([]);
  });

  it("refuses a session made under the earlier long password, at /mcp and at refresh", async () => {
    const tokens = await obtainTokens();
    expect((await mcpList(`Bearer ${tokens.access_token}`, { OWNER_PASSWORD: SHORT })).status).toBe(401);
    const res = await refresh(tokens.refresh_token, { OWNER_PASSWORD: SHORT });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("accepts a session whose tag came from the short password: the check is a tag comparison, not a length check", async () => {
    const o = { OWNER_PASSWORD: SHORT };
    const oauth = getOAuth({ ...baseEnv(), ...o }, new URL(ORIGIN))!;
    const authRequest = await oauth.api.parseAuthRequest(new Request(`${ORIGIN}/authorize?${await authorizeQuery()}`));
    const { redirectTo } = await oauth.api.completeAuthorization({
      request: authRequest,
      userId: "owner",
      metadata: {},
      scope: ["mcp"],
      props: await sessionProps(SHORT),
    });
    const code = new URL(redirectTo).searchParams.get("code")!;
    const res = await exchange(code, {}, o);
    expect(res.status).toBe(200);
    const tokens = (await res.json()) as { access_token: string };
    expect((await mcpList(`Bearer ${tokens.access_token}`, o)).status).toBe(200);
    // Under the real password the same token is refused.
    expect((await mcpList(`Bearer ${tokens.access_token}`)).status).toBe(401);
  });
});

describe("origins the library accepts", () => {
  const request = (origin: string, path: string, init: RequestInit = {}) => new Request(`${origin}${path}`, init);

  it("a loopback http origin has OAuth on", async () => {
    for (const origin of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
      const res = await call(request(origin, "/mcp", { method: "POST" }));
      expect(res.status, origin).toBe(401);
      expect(res.headers.get("WWW-Authenticate"), origin).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
      expect((await call(request(origin, "/.well-known/oauth-authorization-server"))).status, origin).toBe(200);
    }
  });

  it("a non-loopback http origin behaves as OAuth off, without an exception and without asking the library (no log line)", async () => {
    const log = spyConsole();
    try {
      for (const origin of ["http://worker.test", "http://192.0.2.1", "http://localhost.example.test"]) {
        const res = await call(request(origin, "/mcp", { method: "POST" }));
        expect(res.status, origin).toBe(401);
        expect(res.headers.get("WWW-Authenticate"), origin).toBe("Bearer");
        expect((await call(request(origin, "/.well-known/oauth-authorization-server"))).status, origin).toBe(404);
        expect((await call(request(origin, "/authorize"))).status, origin).toBe(404);
      }
      // The edge's own origin check answered; the library's refusal (logged as a configuration problem) was never reached.
      expect(log.text()).not.toContain("oauth_error");
    } finally {
      log.restore();
    }
  });
});

describe("the existing edge rules with OAuth on", () => {
  it("non-POST methods on /mcp are 405 with Allow: POST and no challenge, before authentication", async () => {
    for (const method of ["GET", "DELETE", "PUT", "OPTIONS"]) {
      const res = await call(new Request(MCP_URL, { method }));
      expect(res.status, method).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
      expect(res.headers.get("WWW-Authenticate")).toBeNull();
    }
  });

  it("a disallowed Origin on /mcp is 403 before the credential", async () => {
    const res = await mcpList(null, {}, { Origin: "https://evil.test" });
    expect(res.status).toBe(403);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("a disallowed Origin on the discovery and token paths is not refused for it, and the answer carries CORS headers", async () => {
    const evil = { Origin: "https://evil.test" };
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await call(new Request(`${ORIGIN}${path}`, { headers: evil }));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin"), path).toBe("https://evil.test");
    }
    // A token request with a good form is answered by the library, not refused for its Origin.
    const res = await postToken({ grant_type: "authorization_code", code: "x", client_id: CLIENT_ID, code_verifier: VERIFIER, redirect_uri: CALLBACK }, evil);
    expect(res.status).toBe(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://evil.test");
  });
});

describe("no secret reaches the console", () => {
  it("a sign-in and a token use write no password, token or code", async () => {
    const log = spyConsole();
    try {
      const tokens = await obtainTokens();
      await mcpList(`Bearer ${tokens.access_token}`);
      const text = log.text();
      for (const secret of [PASSWORD, tokens.access_token, tokens.refresh_token, BEARER]) expect(text).not.toContain(secret);
    } finally {
      log.restore();
    }
  });
});
