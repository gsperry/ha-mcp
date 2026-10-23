import type { Env } from "../index";

/** Default time to wait for Home Assistant before giving up. */
export const HA_TIMEOUT_MS = 10_000;
/** Longest piece of a Home Assistant response body copied into an error message. */
export const HA_BODY_LIMIT = 2048;

export const AUTH_HINT =
  "Home Assistant rejected the credentials. Likely causes: the long-lived token was revoked or expired, " +
  "the token's user is not an administrator, or the user is marked local-only (Nabu Casa requests count as remote). " +
  "The request was not retried, because repeated failed logins can get the server address banned.";

// Home Assistant's own 403 is the answer its IP-ban check gives to a banned address.
export const FORBIDDEN_HINT =
  "Home Assistant itself answered 403, which it gives to an address it has banned after repeated failed logins. " +
  "Likely cause: the address Home Assistant sees for this server is banned. Remove it from ip_bans.yaml in the " +
  "Home Assistant configuration folder and restart Home Assistant. The request was not retried.";

/** A failed Home Assistant call. The message carries the status and Home Assistant's own explanation. */
export class HaError extends Error {
  readonly status: number | null;
  readonly body: string;
  /**
   * Whether a request was put on the wire. False for failures raised before anything was sent (an invalid
   * `HA_URL`, a refused path), so a caller can tell "never sent" from "sent, no answer arrived".
   */
  readonly sent: boolean;

  constructor(message: string, status: number | null = null, body = "", sent = false) {
    super(message);
    this.name = "HaError";
    this.status = status;
    this.body = body;
    this.sent = sent;
  }
}

export interface HaInit extends Omit<RequestInit, "signal"> {
  /** Override the 10 s default. */
  timeoutMs?: number;
}

function truncate(text: string): string {
  return text.length > HA_BODY_LIMIT ? `${text.slice(0, HA_BODY_LIMIT)}... [truncated]` : text;
}

export function haOrigin(env: Env): string {
  let url: URL;
  try {
    url = new URL(env.HA_URL);
  } catch {
    throw new HaError("HA_URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HaError("HA_URL must start with http:// or https://.");
  }
  return url.origin;
}

/**
 * Builds the request URL and refuses anything that, once normalised, leaves the
 * configured Home Assistant origin or the `/api/` tree.
 */
export function buildHaUrl(env: Env, path: string): URL {
  const origin = haOrigin(env);
  const url = new URL(path, origin);
  if (url.origin !== origin || !url.pathname.startsWith("/api/")) {
    throw new HaError(`Refusing to call a path outside ${"/api/"} on the configured Home Assistant host.`);
  }
  return url;
}

/** Makes one value safe to place inside a URL path. Rejects empty, `.` and `..`. */
export function pathSegment(value: string): string {
  if (value === "" || value === "." || value === "..") {
    throw new HaError(`Invalid path segment: ${JSON.stringify(value)}.`);
  }
  return encodeURIComponent(value);
}

const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const NAME = /^[a-z0-9_]+$/;

export function validateEntityId(value: string): string {
  if (!ENTITY_ID.test(value)) {
    throw new HaError(`Invalid entity_id ${JSON.stringify(value)}: expected "domain.object_id" in lower case.`);
  }
  return value;
}

export function validateDomain(value: string): string {
  if (!NAME.test(value)) {
    throw new HaError(`Invalid domain ${JSON.stringify(value)}: expected lower-case letters, digits and underscores.`);
  }
  return value;
}

export function validateService(value: string): string {
  if (!NAME.test(value)) {
    throw new HaError(`Invalid service ${JSON.stringify(value)}: expected lower-case letters, digits and underscores.`);
  }
  return value;
}

/**
 * One authenticated call to the Home Assistant REST API. Never retries.
 * Resolves to the parsed JSON body, or to the raw text when the body is not JSON.
 */
export async function haFetch(env: Env, path: string, init: HaInit = {}): Promise<unknown> {
  const url = buildHaUrl(env, path);
  const { timeoutMs = HA_TIMEOUT_MS, headers: extra, ...rest } = init;

  const headers = new Headers(extra);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${env.HA_TOKEN}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const label = `${(rest.method ?? "GET").toUpperCase()} ${url.pathname}`;

  try {
    let res: Response;
    let text: string;
    try {
      // A redirect would carry the request to a host we did not vet.
      res = await fetch(url, { ...rest, headers, redirect: "manual", signal: controller.signal });
      text = await res.text();
    } catch (err) {
      if (controller.signal.aborted) {
        throw new HaError(`${label}: Home Assistant did not answer within ${timeoutMs / 1000} s.`, null, "", true);
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new HaError(`${label}: could not reach Home Assistant (${reason}).`, null, "", true);
    }

    if (res.status === 401 || res.status === 403) {
      const hint = res.status === 401 ? AUTH_HINT : FORBIDDEN_HINT;
      throw new HaError(`${label}: HTTP ${res.status}. ${hint} ${truncate(text)}`.trim(), res.status, truncate(text), true);
    }
    if (res.status >= 300) {
      const body = truncate(text);
      throw new HaError(`${label}: HTTP ${res.status}${body ? `: ${body}` : ""}`, res.status, body, true);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  } finally {
    clearTimeout(timer);
  }
}
