import { env } from "cloudflare:test";
import { vi } from "vitest";
import worker, { type Env } from "../../src/index.js";

export const ORIGIN = "https://worker.test";
export const MCP_URL = `${ORIGIN}/mcp`;
export const PASSWORD = "test-owner-password-0123456789abcdef";
export const BEARER = "test-bearer-token";
export const CLIENT_ID = "https://claude.ai/oauth/test-client.json";
export const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/** The bindings the test configuration provides, with OAuth on. */
export const baseEnv = (): Env => env as unknown as Env;

/** A throttle that never refuses, so a test that signs in does not depend on the shared counter. */
export const allowAll: RateLimit = { limit: async () => ({ success: true }) };

/**
 * Calls the Worker's own handler with the test bindings, replacing the ones named in `overrides`
 * (an explicit `undefined` removes a binding). The sign-in throttle is `allowAll` unless a test
 * says otherwise.
 */
export function call(request: Request, overrides: Partial<Env> = {}): Promise<Response> {
  return worker.fetch(request, { ...baseEnv(), SIGN_IN_LIMITER: allowAll, ...overrides });
}

/** Empties the OAuth namespace; whether the harness isolates KV between tests is not assumed. */
export async function clearKv(): Promise<void> {
  const kv = baseEnv().OAUTH_KV!;
  for (;;) {
    const { keys, list_complete } = await kv.list();
    await Promise.all(keys.map((k) => kv.delete(k.name)));
    if (list_complete) return;
  }
}

export interface KvCalls {
  get: string[];
  put: string[];
  delete: string[];
  list: number;
  /** Total number of KV operations seen. */
  readonly total: number;
}

/** Wraps the namespace so tests can count and inspect what the code touches. `fail` makes chosen operations throw. */
export function countingKv(fail: Partial<Record<"get" | "put" | "delete" | "list", boolean>> = {}): { kv: KVNamespace; calls: KvCalls } {
  const real = baseEnv().OAUTH_KV!;
  const calls: KvCalls = {
    get: [],
    put: [],
    delete: [],
    list: 0,
    get total() {
      return this.get.length + this.put.length + this.delete.length + this.list;
    },
  };
  const kv = {
    get: (key: string, ...rest: unknown[]) => {
      calls.get.push(key);
      if (fail.get) throw new Error("KV unavailable");
      return (real.get as (...a: unknown[]) => unknown)(key, ...rest);
    },
    put: (key: string, ...rest: unknown[]) => {
      calls.put.push(key);
      if (fail.put) throw new Error("KV unavailable");
      return (real.put as (...a: unknown[]) => unknown)(key, ...rest);
    },
    delete: (key: string) => {
      calls.delete.push(key);
      if (fail.delete) throw new Error("KV unavailable");
      return real.delete(key);
    },
    list: (...rest: unknown[]) => {
      calls.list++;
      if (fail.list) throw new Error("KV unavailable");
      return (real.list as (...a: unknown[]) => unknown)(...rest);
    },
  } as unknown as KVNamespace;
  return { kv, calls };
}

/** A limiter that allows `allowed` calls and refuses the rest, counting every call. */
export function stubLimiter(allowed: number): { limiter: RateLimit; calls: () => number } {
  let n = 0;
  return {
    limiter: { limit: async () => ({ success: ++n <= allowed }) },
    calls: () => n,
  };
}

/**
 * A client metadata document as Claude publishes one; built when the Worker asks for it. The
 * document names the URL that was fetched as its own client id, as a valid one must.
 */
export function clientDocument(redirectUris: string[] = [CALLBACK], name = "Claude") {
  return (request: Request): Response =>
    Response.json(
      {
        client_id: request.url,
        client_name: name,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      // No caching, so the Cache API holds nothing between tests.
      { headers: { "Cache-Control": "no-store" } },
    );
}

const b64url = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const VERIFIER = "v".repeat(64);

export async function challengeFor(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

/** The query of a good authorization request; entries in `overrides` replace, and `null` removes. */
export async function authorizeQuery(overrides: Record<string, string | null> = {}): Promise<URLSearchParams> {
  const params: Record<string, string> = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK,
    code_challenge: await challengeFor(VERIFIER),
    code_challenge_method: "S256",
    state: "state-1",
    resource: MCP_URL,
    scope: "mcp",
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete params[k];
    else params[k] = v;
  }
  return new URLSearchParams(params);
}

export async function getAuthorize(overrides: Record<string, string | null> = {}, extra: Partial<Env> = {}): Promise<Response> {
  return call(new Request(`${ORIGIN}/authorize?${await authorizeQuery(overrides)}`), extra);
}

/** Posts the sign-in form the way the page's browser does: same origin, form encoded. */
export async function postAuthorize(
  form: Record<string, string>,
  options: { query?: URLSearchParams; headers?: Record<string, string | null>; env?: Partial<Env> } = {},
): Promise<Response> {
  const query = options.query ?? (await authorizeQuery());
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN });
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return call(new Request(`${ORIGIN}/authorize?${query}`, { method: "POST", headers, body: new URLSearchParams(form) }), options.env);
}

export function postToken(form: Record<string, string>, headers: Record<string, string> = {}, overrides: Partial<Env> = {}): Promise<Response> {
  return call(
    new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(form),
    }),
    overrides,
  );
}

/** Signs in with the right password and returns the authorization code. */
export async function signIn(overrides: Record<string, string | null> = {}, envOverrides: Partial<Env> = {}): Promise<string> {
  const res = await postAuthorize(
    { decision: "allow", password: PASSWORD },
    { query: await authorizeQuery(overrides), env: envOverrides },
  );
  if (res.status !== 302) throw new Error(`sign-in answered ${res.status}`);
  const code = new URL(res.headers.get("Location")!).searchParams.get("code");
  if (!code) throw new Error("no code in the redirect");
  return code;
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export async function exchange(code: string, extra: Record<string, string> = {}, envOverrides: Partial<Env> = {}): Promise<Response> {
  return postToken(
    {
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
      resource: MCP_URL,
      ...extra,
    },
    {},
    envOverrides,
  );
}

/** The whole flow: sign in and exchange the code. */
export async function obtainTokens(): Promise<Tokens> {
  const res = await exchange(await signIn());
  if (res.status !== 200) throw new Error(`exchange answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as Tokens;
}

export function refresh(refreshToken: string, envOverrides: Partial<Env> = {}): Promise<Response> {
  return postToken({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID, resource: MCP_URL }, {}, envOverrides);
}

/** Calls `tools/list` on `/mcp` with the given Authorization header value. */
export function mcpList(authorization: string | null, overrides: Partial<Env> = {}, headers: Record<string, string> = {}): Promise<Response> {
  return call(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        ...(authorization === null ? {} : { Authorization: authorization }),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
    overrides,
  );
}

/** Spies on every console method and returns the text written, one string per call. */
export function spyConsole() {
  const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  return {
    text: (): string => spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(" "))).join("\n"),
    warnings: (): number => spies[1]!.mock.calls.length + spies[2]!.mock.calls.length,
    restore: (): void => spies.forEach((s) => s.mockRestore()),
  };
}
