import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFetchSpy } from "../helpers/fetch.js";
import {
  BEARER,
  ORIGIN,
  PASSWORD,
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
  refresh,
  signIn,
  type Tokens,
} from "../helpers/oauth.js";

const spy = installFetchSpy();
beforeEach(async () => {
  await clearKv();
  spy.respondAlways(clientDocument());
});
afterEach(() => vi.restoreAllMocks());

const errorOf = async (res: Response): Promise<string> => ((await res.json()) as { error: string }).error;
const KV_KEYS = async (): Promise<string[]> => (await baseEnv().OAUTH_KV!.list()).keys.map((k) => k.name);

describe("the whole flow in process", () => {
  it("sign in, exchange: an access token, a refresh token, one hour, scope mcp; the token works at /mcp", async () => {
    const res = await exchange(await signIn());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const tokens = (await res.json()) as Tokens;
    expect(tokens.token_type.toLowerCase()).toBe("bearer");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.scope).toBe("mcp");
    expect(tokens.access_token).toMatch(/^owner:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{32}$/);
    expect(tokens.refresh_token).toMatch(/^owner:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{32}$/);

    const list = await mcpList(`Bearer ${tokens.access_token}`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.length).toBeGreaterThan(0);
  });

  it("a code works once; a second exchange is invalid_grant and revokes the grant", async () => {
    const code = await signIn();
    const first = await exchange(code);
    expect(first.status).toBe(200);
    const tokens = (await first.json()) as Tokens;
    const second = await exchange(code);
    expect(second.status).toBe(400);
    expect(await errorOf(second)).toBe("invalid_grant");
    expect((await mcpList(`Bearer ${tokens.access_token}`)).status).toBe(401);
    expect(await errorOf(await refresh(tokens.refresh_token))).toBe("invalid_grant");
  });

  it("each of a wrong verifier, another redirect_uri, another client and an unknown code is refused and writes nothing", async () => {
    const UNKNOWN = "owner:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const cases: [string, (code: string, env: { OAUTH_KV: KVNamespace }) => Promise<Response>][] = [
      ["a wrong verifier", (code, env) => exchange(code, { code_verifier: "w".repeat(64) }, env)],
      ["another redirect_uri", (code, env) => exchange(code, { redirect_uri: "https://claude.ai/api/mcp/other" }, env)],
      ["another client", (code, env) => exchange(code, { client_id: "https://claude.ai/oauth/another-client.json" }, env)],
      ["an unknown code", (_code, env) => exchange(UNKNOWN, {}, env)],
    ];
    for (const [name, run] of cases) {
      await clearKv();
      const code = await signIn(); // with the real namespace
      const { kv, calls } = countingKv();
      const res = await run(code, { OAUTH_KV: kv });
      expect(res.status, name).toBe(400);
      expect(["invalid_grant", "invalid_request", "invalid_client"], name).toContain(await errorOf(res));
      expect(calls.put, name).toEqual([]);
    }
  });

  it("a challenge of method plain never yields a code", async () => {
    const res = await getAuthorize({ code_challenge_method: "plain" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).searchParams.get("code")).toBeNull();
    const post = await postAuthorize({ decision: "allow", password: PASSWORD }, { query: await authorizeQuery({ code_challenge_method: "plain" }) });
    expect(post.status).toBe(302);
    expect(new URL(post.headers.get("Location")!).searchParams.get("error")).toBe("invalid_request");
  });

  it("a JSON body at the token endpoint is 400 and a GET is 405", async () => {
    const json = await call(
      new Request(`${ORIGIN}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token" }) }),
    );
    expect(json.status).toBe(400);
    expect((await call(new Request(`${ORIGIN}/oauth/token`))).status).toBe(405);
  });
});

describe("refresh", () => {
  it("rotates: the new access token works, the old refresh token works once more, and a garbage one is invalid_grant", async () => {
    const first = await obtainTokens();
    const res = await refresh(first.refresh_token);
    expect(res.status).toBe(200);
    const second = (await res.json()) as Tokens;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await mcpList(`Bearer ${second.access_token}`)).status).toBe(200);
    // The grace the library gives: the previous refresh token is valid until the new one is first used.
    const again = await refresh(first.refresh_token);
    expect(again.status).toBe(200);
    const garbage = await refresh("owner:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(garbage.status).toBe(400);
    expect(await errorOf(garbage)).toBe("invalid_grant");
  });

  it("a refresh costs at most two writes", async () => {
    const first = await obtainTokens();
    const { kv, calls } = countingKv();
    expect((await refresh(first.refresh_token, { OAUTH_KV: kv })).status).toBe(200);
    expect(calls.put.length).toBeLessThanOrEqual(2);
  });
});

describe("scope", () => {
  it("is mcp when the client asks for mcp and offline_access, and when it asks for nothing", async () => {
    for (const scope of ["mcp offline_access", null]) {
      const code = await signIn({ scope });
      const tokens = (await (await exchange(code)).json()) as Tokens;
      expect(tokens.scope, String(scope)).toBe("mcp");
    }
  });
});

describe("expiry", () => {
  it("an access token is 401 invalid_token after an hour", async () => {
    const tokens = await obtainTokens();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3601 * 1000);
    const res = await mcpList(`Bearer ${tokens.access_token}`);
    clock.mockRestore();
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  });

  it("a refresh token is invalid_grant after 30 days, and still works just before", async () => {
    const tokens = await obtainTokens();
    const day = 24 * 3600 * 1000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 29 * day);
    expect((await refresh(tokens.refresh_token)).status).toBe(200);
    clock.mockReturnValue(Date.now() + 31 * day);
    const res = await refresh(tokens.refresh_token);
    clock.mockRestore();
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_grant");
  });
});

describe("one session at a time", () => {
  it("a second sign-in for the same client replaces the first: the old tokens fail", async () => {
    const first = await obtainTokens();
    const second = await obtainTokens();
    expect((await mcpList(`Bearer ${first.access_token}`)).status).toBe(401);
    expect(await errorOf(await refresh(first.refresh_token))).toBe("invalid_grant");
    expect((await mcpList(`Bearer ${second.access_token}`)).status).toBe(200);
  });
});

describe("the session tag", () => {
  const CHANGED = { OWNER_PASSWORD: "a-different-owner-password-0123456789" };

  it("after OWNER_PASSWORD changes the access token is 401, the refresh is invalid_grant and removes the grant, and the static bearer works", async () => {
    const tokens = await obtainTokens();
    expect((await mcpList(`Bearer ${tokens.access_token}`)).status).toBe(200);
    expect((await mcpList(`Bearer ${tokens.access_token}`, CHANGED)).status).toBe(401);
    expect((await mcpList(`Bearer ${BEARER}`, CHANGED)).status).toBe(200);

    expect((await KV_KEYS()).some((k) => k.startsWith("grant:"))).toBe(true);
    const res = await refresh(tokens.refresh_token, CHANGED);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_grant");
    expect((await KV_KEYS()).some((k) => k.startsWith("grant:"))).toBe(false);

    // The static bearer works throughout, and the old password cannot revive the session.
    expect((await mcpList(`Bearer ${BEARER}`, CHANGED)).status).toBe(200);
    expect((await mcpList(`Bearer ${tokens.access_token}`)).status).toBe(401);
  });
});

describe("the KV namespace", () => {
  it("a sign-in whose KV write throws is a 503 page and grants nothing", async () => {
    const { kv } = countingKv({ put: true });
    const res = await postAuthorize({ decision: "allow", password: PASSWORD }, { env: { OAUTH_KV: kv } });
    expect(res.status).toBe(503);
    expect(res.headers.get("Location")).toBeNull();
    expect(await KV_KEYS()).toEqual([]);
  });

  it("an exchange whose KV write throws is an OAuth-shaped error, and no access token is issued", async () => {
    const code = await signIn();
    const { kv } = countingKv({ put: true });
    const res = await exchange(code, {}, { OAUTH_KV: kv });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error?: string; access_token?: string };
    expect(typeof body.error).toBe("string");
    expect(body.access_token).toBeUndefined();
  });

  it("nothing is written before a correct password, and no client record is ever written", async () => {
    const { kv, calls } = countingKv();
    const env = { OAUTH_KV: kv };
    await call(new Request(`${ORIGIN}/authorize?${await authorizeQuery()}`), env);
    await postAuthorize({ decision: "allow", password: "wrong" }, { env });
    await postAuthorize({ decision: "deny" }, { env });
    expect(calls.put).toEqual([]);

    const code = await (async () => {
      const res = await postAuthorize({ decision: "allow", password: PASSWORD }, { env });
      return new URL(res.headers.get("Location")!).searchParams.get("code")!;
    })();
    expect((await exchange(code, {}, env)).status).toBe(200);
    expect(calls.put.length).toBeGreaterThan(0);
    for (const key of [...calls.put, ...calls.delete]) expect(key, key).toMatch(/^(grant|token):/);
  });
});

describe("registration does not exist", () => {
  it("/register is 404, so no anonymous caller can write a client record", async () => {
    const res = await call(new Request(`${ORIGIN}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    expect(res.status).toBe(404);
  });
});
