/**
 * OAuth sign-in for the claude.ai connector (see docs/adr/0019-oauth-sign-in.md).
 *
 * The Worker is its own authorization server, built on Cloudflare's workers-oauth-provider in its
 * role-split form: the library serves the two discovery documents and the token endpoint, and
 * validates access tokens; this module owns the sign-in page, the edge checks in front of the
 * library, and the token check for `/mcp`. OAuth is on only when every binding it needs is present
 * (`getOAuth` returns null otherwise), and then the Worker behaves exactly as it does without OAuth.
 *
 * Nothing here is kept at module scope: the library objects are built for each request, as the MCP
 * server is.
 */
import {
  AuthorizationError,
  authorizationErrorRedirect,
  OAuthAuthorizationServer,
  OAuthError,
  OAuthResourceServer,
  type AuthRequest,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "./index.js";

const AUTHORIZE_PATH = "/authorize";
const TOKEN_PATH = "/oauth/token";
const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";
const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
const OAUTH_PATHS: ReadonlySet<string> = new Set([AUTHORIZE_PATH, TOKEN_PATH, AS_METADATA_PATH, RESOURCE_METADATA_PATH]);

/** The one user id; it appears in token prefixes and storage keys and is not secret. */
const USER_ID = "owner";
const SCOPE = "mcp";
/** A password shorter than this is refused at request time, so a weak value cannot be set by accident. */
export const MIN_PASSWORD_LENGTH = 24;
const SESSION_LABEL = "ha-mcp oauth session v1";
const LIMITER_KEY = "owner-sign-in";

const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 2592000;

const TOKEN_BODY_LIMIT = 8 * 1024;
const SIGN_IN_BODY_LIMIT = 4 * 1024;

const FORM_TYPE = "application/x-www-form-urlencoded";
const CLAUDE_CLIENT_PREFIX = "https://claude.ai/";
const CLAUDE_ORIGIN = "https://claude.ai";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/** The shape of every access token the library issues for the one user id. */
const ACCESS_TOKEN_SHAPE = /^owner:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{32}$/;

const encoder = new TextEncoder();

/**
 * Reads the compatibility flag that CIMD client lookups need, with the library's own expression
 * (`hasGlobalFetchStrictlyPublic` in its source). Kept as a member of an object so a test can
 * replace it: `Cloudflare.compatibilityFlags` is read-only.
 */
export const compatibility = {
  globalFetchStrictlyPublic(): boolean {
    return !!(typeof Cloudflare !== "undefined" && Cloudflare.compatibilityFlags ? Cloudflare.compatibilityFlags : null)
      ?.global_fetch_strictly_public;
  },
};

/** What a request that reaches a stub resource server would run: nothing can, because `/mcp` is never routed to it. */
export const unreachableResourceHandler = {
  fetch(): Response {
    throw new Error("the resource server's handler is not reachable");
  },
};

/** The authorization-server role never uses the execution context; the library's signature still asks for one. Fresh for each call. */
const noContext = (): ExecutionContext => ({}) as ExecutionContext;

export interface OAuth {
  readonly env: Env & { OAUTH_KV: KVNamespace; OWNER_PASSWORD: string; SIGN_IN_LIMITER: RateLimit };
  /** `https://host`, the issuer. */
  readonly origin: string;
  /** The MCP endpoint's exact URL, the one resource tokens are issued for. */
  readonly resource: string;
  readonly server: OAuthAuthorizationServer<Env>;
  readonly resourceServer: OAuthResourceServer<Env>;
  readonly api: OAuthHelpers;
}

export function isOAuthPath(pathname: string): boolean {
  return OAUTH_PATHS.has(pathname);
}

/** `https`, or `http` on a loopback host (what `wrangler dev` serves); the library accepts nothing else. */
function hasAcceptedOrigin(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname));
}

function logOAuthError(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: "oauth_error", ...fields }));
}

/**
 * Builds the OAuth objects for this request, or returns null when OAuth is off for it: a binding or
 * the password is missing, the compatibility flag is unset, the request's origin is one the library
 * refuses, or the library refuses the options. Null means the Worker behaves as it does without OAuth.
 * A bound password that is too short does not turn OAuth off; the sign-in page reports it.
 */
export function getOAuth(env: Env, url: URL): OAuth | null {
  const { OAUTH_KV, SIGN_IN_LIMITER, OWNER_PASSWORD } = env;
  if (!OAUTH_KV || !SIGN_IN_LIMITER || !OWNER_PASSWORD) return null;
  if (!hasAcceptedOrigin(url)) return null;
  if (!compatibility.globalFetchStrictlyPublic()) return null;
  const origin = url.origin;
  const resource = `${origin}/mcp`;
  try {
    const server = new OAuthAuthorizationServer<Env>({
      issuer: origin,
      resources: [resource],
      scopesSupported: [SCOPE, "offline_access"],
      clientIdMetadataDocumentEnabled: true,
      accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
      tokenExchangeCallback: async ({ props, env: callbackEnv }) => {
        // A refresh is refused, and the library removes the grant, once the password has changed.
        if (!(await sessionCurrent(props, callbackEnv.OWNER_PASSWORD ?? ""))) {
          throw new OAuthError("invalid_grant", { description: "The sign-in has ended; sign in again" });
        }
      },
      onError: ({ status, code, internal }) => {
        logOAuthError({ status, code, category: internal.category, reason: internal.reason });
      },
    });
    const resourceServer = new OAuthResourceServer<Env>({
      resourceMetadata: {
        resource,
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
        resource_name: "ha-mcp",
      },
      requiredScopes: [SCOPE],
      handler: unreachableResourceHandler,
      validateToken: () => async () => null,
    });
    return {
      env: env as OAuth["env"],
      origin,
      resource,
      server,
      resourceServer,
      api: server.getOAuthApi(env),
    };
  } catch {
    logOAuthError({ category: "configuration" });
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Secrets: comparison and session tag
// ---------------------------------------------------------------------------------------------

/** Constant-time string comparison: both sides are hashed, so length and content leak nothing. */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}

/** The first 32 hexadecimal characters of `HMAC-SHA256(password, label)`: a one-way function of the password. */
async function sessionTag(password: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(SESSION_LABEL)));
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** Whether a grant's props carry the tag of the current password. */
async function sessionCurrent(props: unknown, password: string): Promise<boolean> {
  if (typeof props !== "object" || props === null) return false;
  const { v, gen } = props as { v?: unknown; gen?: unknown };
  if (v !== 1 || typeof gen !== "string") return false;
  return constantTimeEqual(gen, await sessionTag(password));
}

/** The props every grant carries; exported so tests can create a session the way the page does. */
export async function sessionProps(password: string): Promise<{ v: 1; gen: string }> {
  return { v: 1, gen: await sessionTag(password) };
}

// ---------------------------------------------------------------------------------------------
// The /mcp credential check and its 401
// ---------------------------------------------------------------------------------------------

export type TokenCheck = "valid" | "refused" | "unavailable";

/**
 * Checks an OAuth access token for `/mcp`. A token that does not have the shape the library issues
 * never reaches KV. An unreachable KV is "unavailable", never "valid".
 */
export async function checkAccessToken(oauth: OAuth, presented: string): Promise<TokenCheck> {
  if (!ACCESS_TOKEN_SHAPE.test(presented)) return "refused";
  try {
    const token = await oauth.server.validateToken<unknown>(oauth.resource, presented, oauth.env);
    if (!token) return "refused";
    return (await sessionCurrent(token.props, oauth.env.OWNER_PASSWORD)) ? "valid" : "refused";
  } catch {
    return "unavailable";
  }
}

/** The 401 for `/mcp`. Empty body; with OAuth on, the header names the metadata so Claude can start sign-in. */
export function unauthorized(oauth: OAuth | null, tokenPresented: boolean): Response {
  if (!oauth) return new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  const error = tokenPresented ? 'error="invalid_token", ' : "";
  const challenge = `Bearer ${error}resource_metadata="${oauth.origin}${RESOURCE_METADATA_PATH}", scope="${SCOPE}"`;
  return new Response(null, { status: 401, headers: { "WWW-Authenticate": challenge } });
}

export function unavailable(): Response {
  return new Response(null, { status: 503, headers: { "Retry-After": "30" } });
}

// ---------------------------------------------------------------------------------------------
// Reading request bodies
// ---------------------------------------------------------------------------------------------

/**
 * Reads at most `limit` bytes, counting the stream itself, not `Content-Length` (a chunked body has
 * none). Returns null when the body is larger.
 */
async function readBytes(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The library's media-type predicate for form bodies: the part before `;`, trimmed and lower-cased. */
function isFormType(contentType: string | null): boolean {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase() === FORM_TYPE;
}

/**
 * Parses bytes with the parser the library uses (`formData()`), given the request's own
 * `Content-Type`, so a header that makes the parser fail fails here first. Null on failure.
 */
async function parseForm(bytes: Uint8Array, contentType: string | null): Promise<FormData | null> {
  try {
    return await new Response(bytes, { headers: { "Content-Type": contentType ?? "" } }).formData();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The client allow list
// ---------------------------------------------------------------------------------------------

/**
 * Only Claude's own client ids may start a sign-in or use the token endpoint: the library fetches
 * the document a client id names, and an open list would let an anonymous caller aim that fetch at
 * any public address. After the prefix and origin check the id must be printable ASCII without a
 * backslash, which covers everything the library itself refuses in an identifier URL and also
 * excludes what it lets through: U+2028, bidirectional controls and all other non-ASCII text.
 */
export function isAllowedClientId(clientId: string): boolean {
  if (!clientId.startsWith(CLAUDE_CLIENT_PREFIX)) return false;
  let origin: string;
  try {
    origin = new URL(clientId).origin;
  } catch {
    return false;
  }
  return origin === CLAUDE_ORIGIN && /^[\x21-\x5b\x5d-\x7e]+$/.test(clientId);
}

/** Claude's hosted callback, or a program on the owner's own computer (any port; the client's document decides the path). */
function isAllowedRedirect(redirectUri: string): boolean {
  if (redirectUri === CLAUDE_CALLBACK) return true;
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
    !parsed.username &&
    !parsed.password &&
    !parsed.hash
  );
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

/** Answers a request for one of the four OAuth paths. The caller has checked `isOAuthPath` and `getOAuth`. */
export async function handleOAuthPath(request: Request, url: URL, oauth: OAuth): Promise<Response> {
  switch (url.pathname) {
    case AS_METADATA_PATH:
      return oauth.server.fetch(request, oauth.env, noContext());
    case RESOURCE_METADATA_PATH:
      return oauth.resourceServer.fetch(request, oauth.env, noContext());
    case TOKEN_PATH:
      return handleToken(request, oauth);
    default:
      return handleAuthorize(request, url, oauth);
  }
}

function tokenRefusal(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * The token endpoint. Any method but POST goes straight to the library (its 405 and the preflight
 * answer). A POST is first examined here, so that the library is never given a client id outside the
 * allow list (it would fetch the document that id names) and never sees a body this code did not check.
 */
async function handleToken(request: Request, oauth: OAuth): Promise<Response> {
  if (request.method !== "POST") return throughLibrary(request, oauth);

  // Claude's client is public; no scheme of Authorization header is accepted, so nothing is parsed.
  if (request.headers.has("Authorization")) return tokenRefusal(401, "invalid_client", "Client authentication is not accepted");
  const contentType = request.headers.get("Content-Type");
  if (!isFormType(contentType)) return tokenRefusal(400, "invalid_request", "Content-Type must be application/x-www-form-urlencoded");

  let bytes: Uint8Array | null;
  try {
    bytes = await readBytes(request, TOKEN_BODY_LIMIT);
  } catch {
    return tokenRefusal(400, "invalid_request", "The request body could not be read");
  }
  if (bytes === null) return tokenRefusal(413, "invalid_request", "The request body is too large");

  const form = await parseForm(bytes, contentType);
  if (!form) return tokenRefusal(400, "invalid_request", "Request body must be valid application/x-www-form-urlencoded data");

  // The library drops empty values for these four parameters before it looks at them.
  const nonEmpty = (name: string): string[] => form.getAll(name).filter((v): v is string => typeof v === "string" && v !== "");
  if (nonEmpty("client_assertion").length > 0 || nonEmpty("client_assertion_type").length > 0) {
    return tokenRefusal(401, "invalid_client", "Client authentication is not accepted");
  }
  const clientIds = nonEmpty("client_id");
  if (clientIds.length !== 1 || !isAllowedClientId(clientIds[0]!)) {
    return tokenRefusal(401, "invalid_client", "Client not found");
  }

  // The library parses exactly the bytes that were checked.
  const headers = new Headers(request.headers);
  headers.delete("Content-Length");
  headers.delete("Transfer-Encoding");
  return throughLibrary(new Request(request.url, { method: "POST", headers, body: bytes }), oauth);
}

/** Runs the library's token endpoint; a thrown error becomes an OAuth-shaped 503. */
async function throughLibrary(request: Request, oauth: OAuth): Promise<Response> {
  try {
    return await oauth.server.fetch(request, oauth.env, noContext());
  } catch {
    logOAuthError({ category: "token-endpoint", reason: "library_threw" });
    return new Response(JSON.stringify({ error: "temporarily_unavailable", error_description: "Try again shortly" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "30" },
    });
  }
}

// ---------------------------------------------------------------------------------------------
// The sign-in page
// ---------------------------------------------------------------------------------------------

const PAGE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
  // Not `no-referrer`: under it browsers send `Origin: null` on a form post, which the same-origin rule would refuse.
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex",
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function pageResponse(status: number, title: string, body: string, extraHeaders: Record<string, string> = {}): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;line-height:1.5}dt{font-weight:600;margin-top:.75rem}dd{margin:0;word-break:break-all}.warn{border:2px solid #b45309;padding:.5rem .75rem}.error{color:#b91c1c;font-weight:600}input[type=password]{width:100%;box-sizing:border-box;padding:.5rem;margin:.5rem 0}button{padding:.5rem 1rem;margin-right:.5rem}</style>
</head>
<body>
${body}
</body>
</html>
`;
  return new Response(html, { status, headers: { ...PAGE_HEADERS, ...extraHeaders } });
}

function messagePage(status: number, heading: string, text: string, extraHeaders?: Record<string, string>): Response {
  return pageResponse(status, heading, `<h1>${escapeHtml(heading)}</h1>\n<p>${escapeHtml(text)}</p>`, extraHeaders);
}

const BAD_REQUEST = (): Response => messagePage(400, "Sign-in request refused", "This sign-in request is not valid. Start again from the app that sent you here.");
const NOT_SET_UP = (): Response => messagePage(503, "Sign-in is not set up", "The server is missing a setting that sign-in needs. Nothing was changed.");
const UNAVAILABLE = (): Response => messagePage(503, "Sign-in is unavailable", "Sign-in is temporarily unavailable. Try again in a minute.", { "Retry-After": "30" });
const CLIENT_UNREACHABLE = (): Response => messagePage(502, "Sign-in is unavailable", "The app's details could not be fetched. Try again in a minute.");

/** The sign-in form, with what the owner must see before entering the password. */
function signInPage(consent: ConsentDescription, status: number, error?: string): Response {
  const warning = consent.redirectIsLoopback
    ? `<p class="warn">This sends access to a program on your computer; continue only if you just started signing in from it.</p>\n`
    : "";
  const failure = error ? `<p class="error">${escapeHtml(error)}</p>\n` : "";
  const body = `<h1>Sign in to ha-mcp</h1>
${failure}<dl>
<dt>App (name as the app claims it)</dt><dd>${escapeHtml(consent.clientName)}</dd>
<dt>Published by</dt><dd>${escapeHtml(consent.clientDomain ?? "")}</dd>
<dt>Access will be sent to</dt><dd>${escapeHtml(consent.redirectHost)}</dd>
</dl>
${warning}<p>Allow gives this app every tool of this server: read and change your Home Assistant.</p>
<p><strong>Continue only if you clicked Connect yourself just now; never use a sign-in link someone sent you.</strong></p>
<form method="post">
<input type="text" name="username" value="owner" autocomplete="username" tabindex="-1" aria-hidden="true" style="position:absolute;left:-10000px;width:1px;height:1px;opacity:0">
<label for="password">Owner password</label>
<input type="password" id="password" name="password" autocomplete="current-password" maxlength="256" required>
<button type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
</form>`;
  return pageResponse(status, "Sign in to ha-mcp", body);
}

/** The same-origin rule for a form post; a defence against cross-site posts only, the password is what stops everyone else. */
function isSameOriginPost(request: Request, origin: string): boolean {
  const sent = request.headers.get("Origin");
  if (sent !== null && sent !== "null") return sent === origin;
  return request.headers.get("Sec-Fetch-Site") === "same-origin";
}

type PreCheck = { ok: true } | { ok: false };

/**
 * The checks that run before the library looks the client up (which fetches): one value each for
 * `client_id` and `redirect_uri`, the client on the allow list, `response_type=code`, a PKCE
 * challenge, and a redirect that goes only to Claude's callback or to the owner's own computer.
 * Every failure is a local page, never a redirect, and starts no fetch.
 */
function preCheckAuthorize(url: URL): PreCheck {
  const params = url.searchParams;
  if (params.getAll("client_id").length > 1 || params.getAll("redirect_uri").length > 1) return { ok: false };
  const clientId = params.get("client_id") ?? "";
  if (!isAllowedClientId(clientId)) return { ok: false };
  if (params.get("response_type") !== "code") return { ok: false };
  if (!params.get("code_challenge")) return { ok: false };
  if (!isAllowedRedirect(params.get("redirect_uri") ?? "")) return { ok: false };
  return { ok: true };
}

type Parsed = { authRequest: AuthRequest; consent?: ConsentDescription } | { response: Response };

/** `parseAuthRequest` (and, for the page, `describeConsent`), with every failure turned into its fixed answer. */
async function parseRequest(request: Request, oauth: OAuth, withConsent: boolean): Promise<Parsed> {
  try {
    const authRequest = await oauth.api.parseAuthRequest(request);
    return withConsent ? { authRequest, consent: await oauth.api.describeConsent(authRequest) } : { authRequest };
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.redirectTo) return { response: new Response(null, { status: 302, headers: { Location: error.redirectTo, "Cache-Control": "no-store" } }) };
      return { response: BAD_REQUEST() };
    }
    // A client document that cannot be fetched, or any other failure of the client lookup.
    return { response: CLIENT_UNREACHABLE() };
  }
}

function hostOf(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function logSignIn(outcome: "granted" | "wrong_password" | "rate_limited" | "denied", authRequest: AuthRequest): void {
  console.log(
    JSON.stringify({ event: "sign_in", outcome, clientDomain: hostOf(authRequest.clientId), redirectHost: hostOf(authRequest.redirectUri) }),
  );
}

async function handleAuthorize(request: Request, url: URL, oauth: OAuth): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  }
  const post = request.method === "POST";
  if (post && !isSameOriginPost(request, oauth.origin)) return new Response(null, { status: 403 });
  if (oauth.env.OWNER_PASSWORD.length < MIN_PASSWORD_LENGTH) return NOT_SET_UP();

  let decision = "";
  let password = "";
  if (post) {
    // The media type is judged before the body is read, then the bytes are read with a limit that
    // does not rely on Content-Length, then parsed.
    const contentType = request.headers.get("Content-Type");
    if (!isFormType(contentType)) return BAD_REQUEST();
    let bytes: Uint8Array | null;
    try {
      bytes = await readBytes(request, SIGN_IN_BODY_LIMIT);
    } catch {
      return BAD_REQUEST();
    }
    if (bytes === null) return BAD_REQUEST();
    const form = await parseForm(bytes, contentType);
    if (!form) return BAD_REQUEST();
    const decisions = form.getAll("decision");
    if (decisions.length !== 1 || (decisions[0] !== "allow" && decisions[0] !== "deny")) return BAD_REQUEST();
    decision = decisions[0];
    const sent = form.get("password");
    password = typeof sent === "string" ? sent : "";
  }

  if (!preCheckAuthorize(url).ok) return BAD_REQUEST();
  const parsed = await parseRequest(request, oauth, !post);
  if ("response" in parsed) return parsed.response;
  const { authRequest } = parsed;

  if (!post) return signInPage(parsed.consent!, 200);

  if (decision === "deny") {
    logSignIn("denied", authRequest);
    return new Response(null, {
      status: 302,
      headers: { Location: authorizationErrorRedirect(authRequest, "access_denied"), "Cache-Control": "no-store" },
    });
  }

  // allow: the throttle first, then the password, then the grant.
  let allowed: boolean;
  try {
    allowed = (await oauth.env.SIGN_IN_LIMITER.limit({ key: LIMITER_KEY })).success;
  } catch {
    return UNAVAILABLE();
  }
  if (!allowed) {
    logSignIn("rate_limited", authRequest);
    return messagePage(429, "Too many attempts", "Wait a minute, then try again.", { "Retry-After": "60" });
  }

  const matches = password.length > 0 && (await constantTimeEqual(password, oauth.env.OWNER_PASSWORD));
  if (!matches) {
    logSignIn("wrong_password", authRequest);
    // The request is already parsed and checked; only the page's facts are looked up again.
    try {
      return signInPage(await oauth.api.describeConsent(authRequest), 401, "That password was not accepted.");
    } catch {
      return CLIENT_UNREACHABLE();
    }
  }

  try {
    const { redirectTo } = await oauth.api.completeAuthorization({
      request: authRequest,
      userId: USER_ID,
      metadata: {},
      scope: [SCOPE],
      props: await sessionProps(oauth.env.OWNER_PASSWORD),
    });
    logSignIn("granted", authRequest);
    return new Response(null, { status: 302, headers: { Location: redirectTo, "Cache-Control": "no-store" } });
  } catch {
    return UNAVAILABLE();
  }
}
