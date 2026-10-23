/**
 * The pieces of the delete confirmation: the one-time code, the digest of the config it was issued for, the keyed
 * challenge, and the text sent to the owner's phone. See docs/adr/0017-delete-confirmation.md. Nothing here is
 * stored: the challenge carries everything the second call needs, and only the Worker's key can make one that verifies.
 */

/** Seconds a challenge lives. */
export const CHALLENGE_LIFETIME_SECONDS = 300;

const TAG_PURPOSE = "ha-mcp/delete-confirmation/v1";
const KEY_PURPOSE = "ha-mcp delete confirmation v1";
const CHALLENGE_VERSION = "dc1";
const MAX_CHALLENGE_LENGTH = 128;
const MAX_CODE_LENGTH = 32;
/** The largest multiple of 10^8 below 2^32: values at or above it are redrawn so every code is equally likely. */
const CODE_DRAW_LIMIT = 4_200_000_000;

const encoder = new TextEncoder();

/** A source of unsigned 32-bit random values; replaceable in tests. */
export type Random32 = () => number;

const randomUint32: Random32 = () => crypto.getRandomValues(new Uint32Array(1))[0]!;

/** Eight decimal digits, uniformly, with leading zeros. */
export function drawCode(random: Random32 = randomUint32): string {
  for (;;) {
    const value = random();
    if (value < CODE_DRAW_LIMIT) return String(value % 100_000_000).padStart(8, "0");
  }
}

/** The code as the phone shows it: two groups of four. */
export function groupCode(code: string): string {
  return `${code.slice(0, 4)} ${code.slice(4)}`;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** JSON with the keys of every object sorted, so that key order never changes the digest. Own `__proto__` keys are kept. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => [key, (value as Record<string, unknown>)[key]] as const)
      .filter(([, item]) => item !== undefined);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The first 16 bytes of SHA-256 of the config with sorted keys, in base64url (22 characters). */
export async function configDigest(config: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalJson(config)));
  return base64url(new Uint8Array(hash).slice(0, 16));
}

/** `HMAC-SHA256(HA_TOKEN, "ha-mcp delete confirmation v1")`, imported as a signing key. */
async function deriveKey(haToken: string): Promise<CryptoKey> {
  if (haToken === "") throw new Error("HA_TOKEN is empty, so no confirmation can be signed.");
  const root = await crypto.subtle.importKey("raw", encoder.encode(haToken), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", root, encoder.encode(KEY_PURPOSE));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function tagInput(id: string, expiry: string, digest: string, code: string): Uint8Array {
  return encoder.encode(JSON.stringify([TAG_PURPOSE, id, expiry, digest, code]));
}

/** Makes the challenge text for a code: `dc1.<expiry>.<digest>.<tag>`. */
export async function issueChallenge(haToken: string, id: string, expiry: number, digest: string, code: string): Promise<string> {
  const key = await deriveKey(haToken);
  const tag = await crypto.subtle.sign("HMAC", key, tagInput(id, String(expiry), digest, code));
  return `${CHALLENGE_VERSION}.${expiry}.${digest}.${base64url(new Uint8Array(tag))}`;
}

/** A challenge read from the caller's text. `expiry` and `digest` stay as the exact text given. */
export interface ParsedChallenge {
  expiryText: string;
  expiry: number;
  digest: string;
  tag: Uint8Array;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Reads the four fields exactly; anything else is refused. */
export function parseChallenge(text: string): ParseResult<ParsedChallenge> {
  if (text.length > MAX_CHALLENGE_LENGTH) return { ok: false, reason: "the challenge is too long" };
  const fields = text.split(".");
  if (fields.length !== 4) return { ok: false, reason: "the challenge does not have four parts" };
  const [version, expiryText, digest, tagText] = fields as [string, string, string, string];
  if (version !== CHALLENGE_VERSION) return { ok: false, reason: "the challenge has an unknown version" };
  if (!/^[0-9]{1,12}$/.test(expiryText)) return { ok: false, reason: "the challenge has a malformed expiry" };
  if (!/^[A-Za-z0-9_-]{22}$/.test(digest)) return { ok: false, reason: "the challenge has a malformed digest" };
  if (!/^[A-Za-z0-9_-]{43}$/.test(tagText)) return { ok: false, reason: "the challenge has a malformed tag" };
  const tag = fromBase64url(tagText);
  if (tag.length !== 32 || base64url(tag) !== tagText) return { ok: false, reason: "the challenge has a malformed tag" };
  return { ok: true, value: { expiryText, expiry: Number(expiryText), digest, tag } };
}

/** The eight digits of a typed code: ASCII spaces and hyphens removed, then exactly eight ASCII digits. */
export function normaliseCode(text: string): ParseResult<string> {
  if (text.length > MAX_CODE_LENGTH) return { ok: false, reason: "the code is too long" };
  const digits = text.replace(/[ -]/g, "");
  if (!/^[0-9]{8}$/.test(digits)) return { ok: false, reason: "the code is not eight digits" };
  return { ok: true, value: digits };
}

/** Whether the tag was issued by this Worker's key for exactly this id, expiry text, digest text and code. */
export async function verifyChallenge(haToken: string, id: string, challenge: ParsedChallenge, code: string): Promise<boolean> {
  const key = await deriveKey(haToken);
  return crypto.subtle.verify("HMAC", key, challenge.tag, tagInput(id, challenge.expiryText, challenge.digest, code));
}

// ---------------------------------------------------------------------------------------------
// The notification text
// ---------------------------------------------------------------------------------------------

export const NOTIFICATION_TITLE = "Confirm automation delete";

const QUOTES = /["'\u00ab\u00bb\u2018-\u201f\u2039\u203a\u300c-\u300f\u301d-\u301f\uff02\uff07]/g;

/**
 * Makes text from the config safe to place inside the notification line: format characters (bidirectional controls
 * included) are removed; control characters, lone surrogates and the line and paragraph separators become a space;
 * every quotation mark becomes a backtick; white space collapses; the result is trimmed.
 */
function neutralise(text: string): string {
  return text
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Cc}\p{Cs}\u2028\u2029]/gu, " ")
    .replace(QUOTES, "`")
    .replace(/\s+/g, " ")
    .trim();
}

function cut(text: string, limit: number, marker: string): string {
  const points = Array.from(text);
  return points.length > limit ? points.slice(0, limit).join("") + marker : text;
}

/** The alias as shown on the phone: neutralised, cut to 60 code points, or `(no alias)`. */
export function displayAlias(alias: unknown): string {
  const clean = typeof alias === "string" ? neutralise(alias) : "";
  return clean === "" ? "(no alias)" : cut(clean, 60, "...");
}

/** The id as shown on the phone: neutralised and cut to 64 code points. */
export function displayId(id: string): string {
  const clean = neutralise(id);
  return clean === "" ? "(blank id)" : cut(clean, 64, "");
}

const SAFE_ENTITY_ID = /^automation\.[a-z0-9_]+$/;

/** The entity id as shown on the phone: only a plain automation entity id is copied. */
export function displayEntity(entityId: unknown): string {
  return typeof entityId === "string" && SAFE_ENTITY_ID.test(entityId) ? `entity ${entityId}` : "entity unavailable";
}

/** The one-line message. The real id and entity id come before the alias, so look-alike text in the alias only follows them. */
export function notificationMessage(id: string, entityId: unknown, alias: unknown, code: string): string {
  return (
    `Claude asked to delete the automation with id ${displayId(id)}, ${displayEntity(entityId)}, named '${displayAlias(alias)}'. ` +
    `Confirmation code: ${groupCode(code)}. It expires in 5 minutes. ` +
    "If you did not ask for this, ignore this message and do not share the code."
  );
}
