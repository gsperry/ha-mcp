import { OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFetchSpy } from "../helpers/fetch.js";
import {
  CALLBACK,
  CLIENT_ID,
  ORIGIN,
  VERIFIER,
  authorizeQuery,
  call,
  clearKv,
  clientDocument,
  countingKv,
  getAuthorize,
  spyConsole,
} from "../helpers/oauth.js";

const spy = installFetchSpy();
beforeEach(async () => {
  await clearKv();
  spy.respondAlways(clientDocument());
});
afterEach(() => vi.restoreAllMocks());

const FORM = "application/x-www-form-urlencoded";
const FOREIGN = "https://evil.test/client.json";
const TOKEN = "owner:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** The three request kinds that share the token endpoint. */
const kinds: Record<string, Record<string, string>> = {
  "an authorization code exchange": { grant_type: "authorization_code", code: TOKEN, code_verifier: VERIFIER, redirect_uri: CALLBACK },
  "a refresh": { grant_type: "refresh_token", refresh_token: TOKEN },
  "a revocation": { token: TOKEN },
};

interface Sent {
  fields: Record<string, string>;
  contentType?: string | null;
  headers?: Record<string, string>;
  body?: BodyInit;
}

/** Posts to the token endpoint with the counting KV and an Origin header (so any CORS answer would show). */
async function send(sent: Sent) {
  const { kv, calls } = countingKv();
  const headers = new Headers({ Origin: "https://claude.ai", ...(sent.headers ?? {}) });
  if (sent.contentType !== null) headers.set("Content-Type", sent.contentType ?? FORM);
  const res = await call(
    new Request(`${ORIGIN}/oauth/token`, { method: "POST", headers, body: sent.body ?? new URLSearchParams(sent.fields) }),
    { OAUTH_KV: kv },
  );
  return { res, calls };
}

/** Asserts a refusal made at the edge: the status and error, no fetch, no KV, and none of the library's headers. */
async function expectEdgeRefusal(sent: Sent, status: number, error: string): Promise<void> {
  const log = spyConsole();
  try {
    const { res, calls } = await send(sent);
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: string }).error).toBe(error);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(spy.requests).toEqual([]);
    expect(calls.total).toBe(0);
    expect(log.warnings()).toBe(0);
  } finally {
    log.restore();
  }
}

describe.each(Object.entries(kinds))("%s", (_name, base) => {
  const withClient = (client: Record<string, string> = { client_id: FOREIGN }) => ({ ...base, ...client });

  it("with a foreign client_id is invalid_client, whatever the media type spelling", async () => {
    for (const contentType of [FORM, `${FORM};charset=UTF-8`, `${FORM}; charset=utf-8`, "Application/X-WWW-Form-Urlencoded", `  ${FORM.toUpperCase()} ; x=y`]) {
      await expectEdgeRefusal({ fields: withClient(), contentType }, 401, "invalid_client");
    }
  });

  it("with an Authorization header of any form, with or without a client_id, is invalid_client", async () => {
    for (const authorization of ["basic dTpw", "Basic\tdTpw", "Basic", "Basic dTpw", "Bearer x", "Digest x"]) {
      await expectEdgeRefusal({ fields: withClient(), headers: { Authorization: authorization } }, 401, "invalid_client");
      await expectEdgeRefusal({ fields: withClient({ client_id: CLIENT_ID }), headers: { Authorization: authorization } }, 401, "invalid_client");
      await expectEdgeRefusal({ fields: { ...base }, headers: { Authorization: authorization } }, 401, "invalid_client");
    }
  });

  it("with a client assertion is invalid_client", async () => {
    const allowed = { client_id: CLIENT_ID };
    await expectEdgeRefusal({ fields: withClient({ ...allowed, client_assertion: "x.y.z" }) }, 401, "invalid_client");
    await expectEdgeRefusal({ fields: withClient({ ...allowed, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" }) }, 401, "invalid_client");
    await expectEdgeRefusal({ fields: withClient({ client_assertion: "x.y.z", client_assertion_type: "t" }) }, 401, "invalid_client");
  });

  it("with no client_id, or an empty one, is invalid_client", async () => {
    await expectEdgeRefusal({ fields: { ...base } }, 401, "invalid_client");
    await expectEdgeRefusal({ fields: withClient({ client_id: "" }) }, 401, "invalid_client");
  });

  it("with two non-empty client_id values is invalid_client, whatever they are", async () => {
    for (const pair of [[FOREIGN, "https://evil.test/two"], [CLIENT_ID, FOREIGN], [FOREIGN, CLIENT_ID], [CLIENT_ID, CLIENT_ID]]) {
      const body = new URLSearchParams(base);
      for (const id of pair) body.append("client_id", id);
      await expectEdgeRefusal({ fields: {}, body }, 401, "invalid_client");
    }
  });

  it("with a client_id that only looks like Claude's is invalid_client", async () => {
    for (const id of ["https://claude.ai.evil.test/x", "https://claude.ai@evil.test/x", "http://claude.ai/x", "https://claude.com/x", "https://ha.test/api/"]) {
      await expectEdgeRefusal({ fields: withClient({ client_id: id }) }, 401, "invalid_client");
    }
  });

  it("with the wrong media type, or none, is invalid_request 400", async () => {
    for (const contentType of ["application/json", "text/plain", "multipart/form-data; boundary=x", "application/x-www-form-urlencoded2"]) {
      await expectEdgeRefusal({ fields: withClient({ client_id: CLIENT_ID }), contentType }, 400, "invalid_request");
    }
    await expectEdgeRefusal({ fields: withClient({ client_id: CLIENT_ID }), contentType: null, body: "client_id=x" }, 400, "invalid_request");
  });

  it("with a charset the parser cannot read is refused at the edge, whichever way the runtime treats it, and the library sees nothing", async () => {
    // Either the runtime refuses the charset (400, the parse failure) or it accepts it and the
    // foreign client id is refused (401). In both cases nothing is fetched and the library is never
    // given a body the edge did not check.
    const library = vi.spyOn(OAuthAuthorizationServer.prototype, "fetch");
    const log = spyConsole();
    try {
      const { res, calls } = await send({ fields: withClient(), contentType: `${FORM};charset=iso-8859-1` });
      expect([400, 401]).toContain(res.status);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(spy.requests).toEqual([]);
      expect(calls.total).toBe(0);
      expect(log.warnings()).toBe(0);
      expect(library).not.toHaveBeenCalled();
    } finally {
      log.restore();
    }
  });

  it("with a body over 8 KiB sent in chunks with no Content-Length is 413", async () => {
    const chunk = new TextEncoder().encode(`${"x".repeat(1023)}&`);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 9) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const log = spyConsole();
    try {
      const { kv, calls } = countingKv();
      const res = await call(
        new Request(`${ORIGIN}/oauth/token`, { method: "POST", headers: { "Content-Type": FORM }, body, duplex: "half" } as RequestInit),
        { OAUTH_KV: kv },
      );
      expect(res.status).toBe(413);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
      expect(spy.requests).toEqual([]);
      expect(calls.total).toBe(0);
    } finally {
      log.restore();
    }
  });

  it("with exactly 8 KiB is read, not refused as too large", async () => {
    const padding = "p=" + "x".repeat(8 * 1024 - 2);
    const { res } = await send({ fields: {}, body: padding });
    expect(res.status).toBe(401); // read in full, then refused for having no client id
  });

  it("with an empty body is refused for having no client_id", async () => {
    await expectEdgeRefusal({ fields: {}, body: "" }, 401, "invalid_client");
  });
});

describe("a client id under https://claude.ai/ with characters the allow list excludes", () => {
  // Written percent-encoded in a query and in a form, as a caller would send them.
  const bad = ["\u0001", "\t", " ", "\\", "\u007f", "\u0085", "\u2028", "\u202e", "\u0080", "\u009f", "\u00e9"].flatMap((ch) => [
    `https://claude.ai/x${ch}y`,
    `https://claude.ai/x${ch}`,
  ]);
  bad.push("https://claude.ai/x ", " https://claude.ai/x", "https://claude.ai/x\n");

  it("is refused at /authorize (local 400) and at /oauth/token (invalid_client), with no fetch and no warning", async () => {
    const log = spyConsole();
    try {
      for (const id of bad) {
        expect((await getAuthorize({ client_id: id })).status, JSON.stringify(id)).toBe(400);
        const { res, calls } = await send({ fields: { ...kinds["a refresh"]!, client_id: id } });
        expect(res.status, JSON.stringify(id)).toBe(401);
        expect(((await res.json()) as { error: string }).error).toBe("invalid_client");
        expect(calls.total).toBe(0);
      }
      expect(spy.requests).toEqual([]);
      expect(log.warnings()).toBe(0);
    } finally {
      log.restore();
    }
  });

  it.each([
    ["U+0085, a control in U+0080 to U+009F that the library also refuses", "\u0085"],
    ["U+202E, a bidirectional control the library lets through", "\u202e"],
  ])("%s is refused at the edge, so it can never reach the library's warning", async (_name, ch) => {
    const log = spyConsole();
    try {
      const id = `https://claude.ai/oauth/x${ch}client.json`;
      expect((await getAuthorize({ client_id: id })).status).toBe(400);
      const { res, calls } = await send({ fields: { ...kinds["a refresh"]!, client_id: id } });
      expect(res.status).toBe(401);
      expect(calls.total).toBe(0);
      expect(spy.requests).toEqual([]);
      expect(log.warnings()).toBe(0);
    } finally {
      log.restore();
    }
  });

  it("is also refused when the characters arrive percent-encoded in the raw query or form text", async () => {
    for (const encoded of ["%01", "%09", "%20", "%5C", "%7F", "%C2%85", "%E2%80%A8", "%E2%80%AE"]) {
      // The character is percent-encoded once, at the query or form level, as a caller would send it.
      const id = `${encodeURIComponent("https://claude.ai/x")}${encoded}y`;
      const query = (await authorizeQuery({ client_id: null })).toString();
      const res = await call(new Request(`${ORIGIN}/authorize?${query}&client_id=${id}`));
      expect(res.status, id).toBe(400);
      const form = await send({ fields: {}, body: `grant_type=refresh_token&refresh_token=${TOKEN}&client_id=${id}` });
      expect(form.res.status, id).toBe(401);
    }
    expect(spy.requests).toEqual([]);
  });
});

describe("a request that passes the edge", () => {
  it("with an empty client_secret and an allowed client id reaches the library (the empty value is dropped)", async () => {
    const { res } = await send({ fields: { ...kinds["an authorization code exchange"]!, client_id: CLIENT_ID, client_secret: "" } });
    // The library looked the client up (one fetch from claude.ai) and answered about the code.
    expect(spy.requests.map((r) => r.url)).toEqual([CLIENT_ID]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("gives the library byte-identical content, including repeated, empty and percent-encoded fields", async () => {
    const sentBody = `grant_type=refresh_token&refresh_token=${TOKEN}&client_id=${encodeURIComponent(CLIENT_ID)}&client_secret=&resource=a&resource=b&empty=&x=%E2%82%AC+y%20z&dup=1&dup=2`;
    let seen: { bytes: Uint8Array; contentType: string | null; method: string; url: string } | undefined;
    const library = vi.spyOn(OAuthAuthorizationServer.prototype, "fetch").mockImplementation(async (request: Request) => {
      seen = { bytes: new Uint8Array(await request.arrayBuffer()), contentType: request.headers.get("Content-Type"), method: request.method, url: request.url };
      return new Response("stub");
    });
    const { res } = await send({ fields: {}, body: sentBody, contentType: `${FORM};charset=UTF-8` });
    expect(await res.text()).toBe("stub");
    expect(library).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(seen!.bytes)).toBe(sentBody);
    expect(seen!.contentType).toBe(`${FORM};charset=UTF-8`);
    expect(seen!.method).toBe("POST");
    expect(seen!.url).toBe(`${ORIGIN}/oauth/token`);
  });

  it("an other method goes to the library's own 405 without a lookup", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await call(new Request(`${ORIGIN}/oauth/token`, { method }));
      expect(res.status, method).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST, OPTIONS");
    }
    expect((await call(new Request(`${ORIGIN}/oauth/token`, { method: "OPTIONS" }))).status).toBe(204);
    expect(spy.requests).toEqual([]);
  });

  it("a revocation with an allowed client id and a three-part token reads at most two KV keys (an accepted exposure, not a prevented one)", async () => {
    const { res, calls } = await send({ fields: { token: TOKEN, client_id: CLIENT_ID } });
    expect(res.status).toBe(200);
    expect(calls.get.length).toBeLessThanOrEqual(2);
    expect(calls.put).toEqual([]);
  });
});
