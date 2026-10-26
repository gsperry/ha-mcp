import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFetchSpy } from "../helpers/fetch.js";
import {
  CALLBACK,
  CLIENT_ID,
  MCP_URL,
  ORIGIN,
  PASSWORD,
  VERIFIER,
  authorizeQuery,
  baseEnv,
  call,
  challengeFor,
  clearKv,
  clientDocument,
  countingKv,
  getAuthorize,
  postAuthorize,
  spyConsole,
  stubLimiter,
} from "../helpers/oauth.js";

const spy = installFetchSpy();
beforeEach(async () => {
  await clearKv();
  spy.respondAlways(clientDocument());
});
afterEach(() => vi.restoreAllMocks());

const WRONG = "not-the-password";
const WARNING_LINE = "Continue only if you clicked Connect yourself just now; never use a sign-in link someone sent you.";

describe("GET /authorize", () => {
  it("serves the sign-in page with its security headers, the facts the owner must see, and writes nothing", async () => {
    spy.respondAlways(clientDocument([CALLBACK], "<script>alert(1)</script> & Co"));
    const { kv, calls } = countingKv();
    const res = await getAuthorize({}, { OAUTH_KV: kv });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(res.headers.get("Set-Cookie")).toBeNull();

    const html = await res.text();
    // The name the app claims is rendered as text.
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co");
    expect(html).not.toContain("<script>");
    expect(html).toContain("claude.ai"); // the redirect host and the publisher
    expect(html).toContain(WARNING_LINE);
    expect(html).toContain("read and change your Home Assistant");
    expect(html).toMatch(/<input type="text" name="username" value="owner" autocomplete="username"/);
    expect(html).toMatch(/<input type="password"[^>]*autocomplete="current-password"[^>]*maxlength="256"[^>]*required/);
    expect(html).toContain('name="decision" value="allow"');
    expect(html).toContain('name="decision" value="deny"');
    expect(html).not.toMatch(/<form[^>]*action=/);
    expect(html).not.toContain("That password was not accepted.");
    expect(calls.put).toEqual([]);
    expect(calls.delete).toEqual([]);
  });

  it("reads the page's Referrer-Policy and requires same-origin, which keeps the form post's Origin real", async () => {
    // Under no-referrer (and policies that act like it here) browsers send `Origin: null` on a form
    // post, and the own-origin posts in these tests would no longer describe what a browser sends.
    expect((await getAuthorize()).headers.get("Referrer-Policy")).toBe("same-origin");
  });

  it("shows the loopback warning for a program on the owner's computer and refuses ::1", async () => {
    spy.respondAlways(clientDocument(["http://127.0.0.1/callback", "http://localhost/callback"]));
    for (const redirect of ["http://127.0.0.1:51234/callback", "http://localhost:3118/callback"]) {
      const res = await getAuthorize({ redirect_uri: redirect });
      expect(res.status, redirect).toBe(200);
      expect(await res.text()).toContain("This sends access to a program on your computer; continue only if you just started signing in from it.");
    }
    const refused = await getAuthorize({ redirect_uri: "http://[::1]:5000/callback" });
    expect(refused.status).toBe(400);
  });

  it("shows no loopback warning for the hosted callback", async () => {
    expect(await (await getAuthorize()).text()).not.toContain("program on your computer");
  });

  it("answers 502 with fixed text when the client document cannot be fetched or is invalid", async () => {
    spy.respondAlways(() => new Response("nope", { status: 500 }));
    for (const handler of [
      () => new Response("nope", { status: 500 }),
      () => Response.json({ client_id: "https://claude.ai/something-else", client_name: "x", redirect_uris: [CALLBACK] }),
      () => new Response("not json", { status: 200 }),
    ]) {
      spy.respondAlways(handler);
      const res = await getAuthorize();
      expect(res.status).toBe(502);
      const html = await res.text();
      expect(html).toContain("The app&#39;s details could not be fetched");
      expect(html).not.toContain("something-else");
      expect(res.headers.get("Location")).toBeNull();
    }
  });

  it("is 405 for other methods, with Allow", async () => {
    for (const method of ["PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"]) {
      const res = await call(new Request(`${ORIGIN}/authorize?${await authorizeQuery()}`, { method }));
      expect(res.status, method).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET, POST");
    }
  });
});

describe("requests refused before anything is looked up", () => {
  const hostile: [string, Record<string, string | null>][] = [
    ["a missing client_id", { client_id: null }],
    ["an empty client_id", { client_id: "" }],
    ["a client_id that is not a URL", { client_id: "claude.ai" }],
    ["an http client_id", { client_id: "http://claude.ai/x" }],
    ["a foreign client_id", { client_id: "https://evil.test/x" }],
    ["a look-alike host", { client_id: "https://claude.ai.evil.test/x" }],
    ["userinfo before the host", { client_id: "https://claude.ai@evil.test/x" }],
    ["claude.com", { client_id: "https://claude.com/x" }],
    ["the owner's Home Assistant address", { client_id: "https://ha.test/api/" }],
    ["a foreign redirect_uri", { redirect_uri: "https://evil.test/callback" }],
    ["a javascript: redirect_uri", { redirect_uri: "javascript:alert(1)" }],
    ["a redirect_uri with userinfo", { redirect_uri: "https://claude.ai@evil.test/api/mcp/auth_callback" }],
    ["loopback userinfo that points elsewhere", { redirect_uri: "http://127.0.0.1@evil.test/callback" }],
    ["an https loopback redirect", { redirect_uri: "https://127.0.0.1/callback" }],
    ["a missing redirect_uri", { redirect_uri: null }],
    ["a wrong response_type", { response_type: "token" }],
    ["a missing response_type", { response_type: null }],
    ["a missing code_challenge", { code_challenge: null, code_challenge_method: null }],
  ];

  it.each(hostile)("%s is a local 400 page with no redirect, no fetch and no warning", async (_name, overrides) => {
    const log = spyConsole();
    try {
      const res = await getAuthorize(overrides);
      expect(res.status).toBe(400);
      expect(res.headers.get("Location")).toBeNull();
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(spy.requests).toEqual([]);
      expect(log.warnings()).toBe(0);
    } finally {
      log.restore();
    }
  });

  it("a repeated client_id or redirect_uri is a local 400 page with no fetch, in either order and with an encoded key", async () => {
    const base = await authorizeQuery({ client_id: null, redirect_uri: null });
    const other = "https://evil.test/x";
    const enc = (v: string) => encodeURIComponent(v);
    const urls = [
      `client_id=${enc(other)}&client_id=${enc(CLIENT_ID)}`,
      `client_id=${enc(CLIENT_ID)}&client_id=${enc(other)}`,
      `client_id=${enc(CLIENT_ID)}&client%5Fid=${enc(other)}`,
      `client%5Fid=${enc(other)}&client_id=${enc(CLIENT_ID)}`,
      `client_id=${enc(CLIENT_ID)}&client_id=${enc(CLIENT_ID)}`,
    ].map((c) => `${c}&redirect_uri=${enc(CALLBACK)}`);
    urls.push(
      `client_id=${enc(CLIENT_ID)}&redirect_uri=${enc("https://evil.test/cb")}&redirect_uri=${enc(CALLBACK)}`,
      `client_id=${enc(CLIENT_ID)}&redirect_uri=${enc(CALLBACK)}&redirect_uri=${enc("https://evil.test/cb")}`,
      `client_id=${enc(CLIENT_ID)}&redirect%5Furi=${enc("https://evil.test/cb")}&redirect_uri=${enc(CALLBACK)}`,
    );
    for (const query of urls) {
      const res = await call(new Request(`${ORIGIN}/authorize?${base}&${query}`));
      expect(res.status, query).toBe(400);
      expect(res.headers.get("Location")).toBeNull();
    }
    expect(spy.requests).toEqual([]);
  });

  it("refuses a client_id with control, whitespace, backslash, U+0080 to U+009F, line-separator or bidi characters, with no fetch and no warning", async () => {
    const log = spyConsole();
    try {
      const characters = ["\u0001", "\t", " ", "\\", "\u007f", "\u0085", "\u2028", "\u202e", "\u0080", "\u009f", "\u00e9"];
      for (const ch of characters) {
        for (const clientId of [`https://claude.ai/x${ch}y`, `https://claude.ai/x${ch}`]) {
          const res = await getAuthorize({ client_id: clientId });
          expect(res.status, JSON.stringify(clientId)).toBe(400);
        }
      }
      for (const clientId of [" https://claude.ai/x", "https://claude.ai/x ", "\nhttps://claude.ai/x"]) {
        expect((await getAuthorize({ client_id: clientId })).status, JSON.stringify(clientId)).toBe(400);
      }
      expect(spy.requests).toEqual([]);
      expect(log.warnings()).toBe(0);
    } finally {
      log.restore();
    }
  });

  it("answers an error redirect to the verified callback for what the library checks after the client lookup", async () => {
    for (const [name, overrides, error] of [
      ["a plain challenge", { code_challenge_method: "plain" }, "invalid_request"],
      ["a resource that is not the MCP URL", { resource: "https://other.test/mcp" }, "invalid_target"],
    ] as const) {
      const res = await getAuthorize(overrides);
      expect(res.status, name).toBe(302);
      const location = new URL(res.headers.get("Location")!);
      expect(`${location.origin}${location.pathname}`, name).toBe(CALLBACK);
      expect(location.searchParams.get("error"), name).toBe(error);
      expect(location.searchParams.get("state"), name).toBe("state-1");
    }
  });
});

describe("POST /authorize: the same refusals as GET, before anything is looked up", () => {
  const other = "https://evil.test/x";
  const cases: [string, () => Promise<URLSearchParams>][] = [
    ["a foreign client_id", () => authorizeQuery({ client_id: other })],
    [
      "a repeated client_id",
      async () => {
        const query = await authorizeQuery();
        query.append("client_id", other);
        return query;
      },
    ],
    ["a foreign redirect_uri", () => authorizeQuery({ redirect_uri: "https://evil.test/callback" })],
    ["a missing code_challenge", () => authorizeQuery({ code_challenge: null, code_challenge_method: null })],
  ];

  it.each(cases.flatMap(([name, query]) => (["deny", "allow"] as const).map((decision) => [name, query, decision] as const)))(
    "%s with decision=%s is a local 400 page: no redirect, no outbound request",
    async (_name, query, decision) => {
      const res = await postAuthorize({ decision, password: PASSWORD }, { query: await query(), headers: { Origin: ORIGIN } });
      expect(res.status).toBe(400);
      expect(res.headers.get("Location")).toBeNull();
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(spy.requests).toEqual([]);
    },
  );
});

describe("POST /authorize: the body", () => {
  const post = async (body: BodyInit, headers: Record<string, string> = {}) =>
    call(
      new Request(`${ORIGIN}/authorize?${await authorizeQuery()}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, ...headers },
        body,
        duplex: "half",
      } as RequestInit),
    );

  /** A chunked body with no Content-Length: `prefix`, then `pad` bytes of filler in 1 KiB chunks. */
  const chunked = (prefix: string, pad: number): ReadableStream<Uint8Array> => {
    const parts = [new TextEncoder().encode(prefix)];
    for (let left = pad; left > 0; left -= 1024) parts.push(new TextEncoder().encode("x".repeat(Math.min(1024, left))));
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = parts.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
  };

  it("a chunked body over 4 KiB that would otherwise succeed is a 400, and one under the limit is read in full", async () => {
    const small = await post(chunked("decision=deny&pad=", 3 * 1024));
    expect(small.status).toBe(302);
    const big = await post(chunked("decision=deny&pad=", 5 * 1024));
    expect(big.status).toBe(400);
    expect(big.headers.get("Location")).toBeNull();
  });

  it("the media type is judged before the body is read", async () => {
    let pulls = 0;
    const counted = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++;
            controller.enqueue(new TextEncoder().encode("decision=deny"));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
    const wrong = await post(counted(), { "Content-Type": "application/json" });
    expect(wrong.status).toBe(400);
    expect(pulls).toBe(0);
    // Control: with the right media type the same stream is read, so the counter can see a read.
    expect((await post(counted())).status).toBe(302);
    expect(pulls).toBeGreaterThan(0);
  });
});

describe("POST /authorize: the same-origin rule", () => {
  const form = { decision: "allow", password: "wrong" };

  it("an Origin equal to the Worker's origin reaches the password step", async () => {
    expect((await postAuthorize(form, { headers: { Origin: ORIGIN } })).status).toBe(401);
  });

  it("another site's Origin is 403, even with Sec-Fetch-Site: same-origin", async () => {
    for (const fetchSite of [null, "same-origin", "cross-site"]) {
      const res = await postAuthorize(form, { headers: { Origin: "https://evil.test", "Sec-Fetch-Site": fetchSite } });
      expect(res.status, String(fetchSite)).toBe(403);
      expect(await res.text()).toBe("");
    }
  });

  it("an absent Origin or Origin: null reaches the password step only with Sec-Fetch-Site: same-origin", async () => {
    for (const origin of [null, "null"]) {
      expect((await postAuthorize(form, { headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" } })).status, String(origin)).toBe(401);
      for (const fetchSite of [null, "same-site", "cross-site", "none"]) {
        const res = await postAuthorize(form, { headers: { Origin: origin, "Sec-Fetch-Site": fetchSite } });
        expect(res.status, `${origin} ${fetchSite}`).toBe(403);
        expect(await res.text()).toBe("");
      }
    }
  });
});

describe("POST /authorize: the rest", () => {
  it("a wrong content type, a missing decision and an odd decision are 400", async () => {
    expect((await postAuthorize({ decision: "allow", password: PASSWORD }, { headers: { "Content-Type": "text/plain" } })).status).toBe(400);
    expect((await postAuthorize({ password: PASSWORD })).status).toBe(400);
    for (const decision of ["", "maybe", "ALLOW", "allow deny"]) {
      expect((await postAuthorize({ decision, password: PASSWORD })).status, decision).toBe(400);
    }
    const twice = await call(
      new Request(`${ORIGIN}/authorize?${await authorizeQuery()}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
        body: `decision=deny&decision=allow&password=${PASSWORD}`,
      }),
    );
    expect(twice.status).toBe(400);
  });

  it("a media type is judged before the body is read; a charset parameter is judged as the library does", async () => {
    const res = await postAuthorize({ decision: "deny" }, { headers: { "Content-Type": "Application/X-WWW-Form-Urlencoded; charset=UTF-8" } });
    expect(res.status).toBe(302);
  });

  it("a body over 4 KiB, sent in chunks with no Content-Length, is a 400 page", async () => {
    const chunk = new TextEncoder().encode("x".repeat(1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 6) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const res = await call(
      new Request(`${ORIGIN}/authorize?${await authorizeQuery()}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(400);
  });

  it("deny redirects with access_denied, state and iss, and writes nothing", async () => {
    const { kv, calls } = countingKv();
    const res = await postAuthorize({ decision: "deny" }, { env: { OAUTH_KV: kv } });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("state-1");
    expect(location.searchParams.get("iss")).toBe(ORIGIN);
    expect(calls.put).toEqual([]);
    expect(calls.delete).toEqual([]);
  });

  it("a wrong password is 401 with the page again and a fixed line, and writes nothing", async () => {
    const { kv, calls } = countingKv();
    const res = await postAuthorize({ decision: "allow", password: WRONG }, { env: { OAUTH_KV: kv } });
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain("That password was not accepted.");
    expect(html).toContain('type="password"');
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(calls.put).toEqual([]);
    expect(calls.delete).toEqual([]);
  });

  it("a wrong password costs two client-document fetches (parse, then the page's facts), not three", async () => {
    const res = await postAuthorize({ decision: "allow", password: WRONG });
    expect(res.status).toBe(401);
    expect(spy.requests.map((r) => r.url)).toEqual([CLIENT_ID, CLIENT_ID]);
  });

  it("the right password is a 302 to the callback with code, state and iss", async () => {
    const res = await postAuthorize({ decision: "allow", password: PASSWORD, username: "someone-else" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("state-1");
    expect(location.searchParams.get("iss")).toBe(ORIGIN);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("the password compare", () => {
  const open = { SIGN_IN_LIMITER: stubLimiter(Infinity).limiter };

  it("refuses every wrong value, whatever its length, and writes nothing", async () => {
    const { kv, calls } = countingKv();
    const wrong = new Set<string>(["", PASSWORD.slice(0, -1), `${PASSWORD}x`, `x${PASSWORD}`, PASSWORD.toUpperCase(), ` ${PASSWORD}`]);
    for (let n = 0; n <= 80; n++) wrong.add("p".repeat(n));
    // One character off, at every position.
    for (let i = 0; i < PASSWORD.length; i++) wrong.add(`${PASSWORD.slice(0, i)}${PASSWORD[i] === "q" ? "r" : "q"}${PASSWORD.slice(i + 1)}`);
    for (const password of wrong) {
      const res = await postAuthorize({ decision: "allow", password }, { env: { ...open, OAUTH_KV: kv } });
      expect(res.status, JSON.stringify(password)).toBe(401);
    }
    expect(calls.put).toEqual([]);
  });

  it("an empty field never matches, and a missing field never matches", async () => {
    expect((await postAuthorize({ decision: "allow", password: "" }, { env: open })).status).toBe(401);
    expect((await postAuthorize({ decision: "allow" }, { env: open })).status).toBe(401);
  });

  it("a secret shorter than 24 characters makes GET and POST 503, with no form", async () => {
    const env = { ...open, OWNER_PASSWORD: "a".repeat(23) };
    const get = await getAuthorize({}, env);
    expect(get.status).toBe(503);
    expect(await get.text()).not.toContain('type="password"');
    expect((await postAuthorize({ decision: "allow", password: "a".repeat(23) }, { env })).status).toBe(503);
    // Exactly 24 characters is enough.
    const ok = { ...open, OWNER_PASSWORD: "a".repeat(24) };
    expect((await getAuthorize({}, ok)).status).toBe(200);
  });
});

describe("the throttle", () => {
  it("with a stub that refuses after five calls, the sixth post is 429 with Retry-After and the password is not compared", async () => {
    const { limiter, calls } = stubLimiter(5);
    const compare = vi.spyOn(crypto.subtle, "timingSafeEqual");
    for (let i = 0; i < 5; i++) {
      expect((await postAuthorize({ decision: "allow", password: "wrong" }, { env: { SIGN_IN_LIMITER: limiter } })).status).toBe(401);
    }
    const compared = compare.mock.calls.length;
    expect(compared).toBeGreaterThan(0);
    // Even the right password is not examined once the throttle refuses.
    const res = await postAuthorize({ decision: "allow", password: PASSWORD }, { env: { SIGN_IN_LIMITER: limiter } });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("Location")).toBeNull();
    expect(compare.mock.calls.length).toBe(compared);
    expect(calls()).toBe(6);
  });

  it("deny does not call the limiter", async () => {
    const { limiter, calls } = stubLimiter(0);
    const res = await postAuthorize({ decision: "deny" }, { env: { SIGN_IN_LIMITER: limiter } });
    expect(res.status).toBe(302);
    expect(calls()).toBe(0);
  });

  it("a limiter that throws makes allow a 503 page; the password is not compared and nothing is granted", async () => {
    const compare = vi.spyOn(crypto.subtle, "timingSafeEqual");
    const { kv, calls } = countingKv();
    const limiter = { limit: async () => { throw new Error("limiter down"); } } as unknown as RateLimit;
    const res = await postAuthorize({ decision: "allow", password: PASSWORD }, { env: { SIGN_IN_LIMITER: limiter, OAUTH_KV: kv } });
    expect(res.status).toBe(503);
    expect(res.headers.get("Location")).toBeNull();
    expect(compare).not.toHaveBeenCalled();
    expect(calls.put).toEqual([]);
  });

  it("the plugin's own binding is attempted: if it enforces, the sixth wrong post in a minute is throttled", async () => {
    const real = baseEnv().SIGN_IN_LIMITER!;
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      statuses.push((await postAuthorize({ decision: "allow", password: "wrong" }, { env: { SIGN_IN_LIMITER: real } })).status);
    }
    if (statuses.includes(429)) {
      expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    } else {
      // The local binding does not enforce a limit: throttling is proven only with the stub above.
      console.info("The harness's rate-limit binding did not enforce; the throttle is proven only with the stub.");
      expect(statuses.every((s) => s === 401)).toBe(true);
    }
  });
});

describe("nothing secret reaches the console", () => {
  it("no console method is called with the password, the code, state or the challenge", async () => {
    const state = "unique-state-value-7f3a";
    const challenge = await challengeFor(VERIFIER);
    const log = spyConsole();
    try {
      const query = await authorizeQuery({ state });
      await call(new Request(`${ORIGIN}/authorize?${query}`));
      await postAuthorize({ decision: "allow", password: WRONG }, { query });
      await postAuthorize({ decision: "deny" }, { query });
      const granted = await postAuthorize({ decision: "allow", password: PASSWORD }, { query });
      const code = new URL(granted.headers.get("Location")!).searchParams.get("code")!;
      const text = log.text();
      for (const secret of [PASSWORD, WRONG, code, state, challenge]) expect(text).not.toContain(secret);
      // One line per attempt, with host names only.
      const lines = text.split("\n").filter((l) => l.includes('"event":"sign_in"')).map((l) => JSON.parse(l));
      expect(lines.map((l) => l.outcome)).toEqual(["wrong_password", "denied", "granted"]);
      for (const line of lines) expect(line).toEqual({ event: "sign_in", outcome: line.outcome, clientDomain: "claude.ai", redirectHost: "claude.ai" });
    } finally {
      log.restore();
    }
  });
});
