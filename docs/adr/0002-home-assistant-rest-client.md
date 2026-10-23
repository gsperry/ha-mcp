# 0002. Home Assistant REST client: timeout, error shape and path confinement

Date: 2026-10-22
Status: Accepted

## Context

Every tool that talks to Home Assistant over REST needs the same transport rules. Three facts shape them:

- Home Assistant counts each rejected bearer token as a failed login and, when IP banning is enabled, can ban the caller's address permanently after a threshold. A client that retries after a 401 multiplies the damage.
- The MCP SDK keeps only `error.message` when a thrown error becomes an error result, so Home Assistant's explanation must be inside the message.
- Tools build URLs from model-supplied values (entity ids, automation ids). The WHATWG `URL` parser resolves `.`, `..` and `%2e%2e` segments, so an unchecked value can leave the `/api/` tree, and a protocol-relative or absolute value can leave the host and take the bearer token with it.

## Options considered

1. Retry once on 401 or on a network error. Rejected: every extra 401 is a failed login, and a retried write can be applied twice.
2. Let `fetch` follow redirects. Rejected: the redirect target is not vetted against the configured host. Redirects are treated as errors instead.
3. Check the raw path string for `..`. Rejected: encoded and mixed forms slip past string checks. The URL is built first and the normalised result is checked.
4. Rely on `AbortSignal.timeout`. Rejected: an explicit `AbortController` and timer can be shortened per call, which keeps the timeout test fast and deterministic.
5. Return the `Response` and let each tool interpret it. Rejected: every tool would repeat status handling and could forget the body in the message.

## Decision

`haFetch(env, path, init)` in `src/ha/rest.ts`:

- Builds the URL with `new URL(path, origin of HA_URL)` and refuses it unless the resulting origin equals that origin and the pathname starts with `/api/`. A path or trailing slash on `HA_URL` is ignored, and a non-http(s) `HA_URL` is refused.
- Sends `Authorization: Bearer <token>` (the caller cannot override it) and `Content-Type: application/json` unless the caller set one.
- Aborts after 10 seconds (overridable per call with `timeoutMs`, used by tests), never retries, and uses `redirect: "manual"` so any 3xx is an error.
- Resolves to the parsed JSON body, or the raw text when the body is not JSON.
- Throws `HaError` (with `status`, `body` and, since the amendment below, `sent`) for every failure. The message has the form `METHOD /path: HTTP <status>: <body>`; for a 401 or 403 it is `METHOD /path: HTTP <status>. <hint> <body>`, where the hint is described below. The body is truncated to 2048 characters, so a proxy error page cannot flood a tool result. A 401 adds a hint naming the likely causes (token revoked, user not an administrator, user marked local-only) and stating that the call was not retried. A 403 adds a different hint, covered in the amendment below. Timeouts and network failures also throw `HaError`, with a message that never contains the token.
- `pathSegment(value)` rejects an empty value, `.` and `..`, then applies `encodeURIComponent`, so a `/` or an encoded dot inside an id stays inside one path segment. `validateEntityId` (`^[a-z0-9_]+\.[a-z0-9_]+$`), `validateDomain` and `validateService` (`^[a-z0-9_]+$`) reject anything else before it reaches a path.

## Consequences

- A revoked token costs exactly one failed login per tool call; the model sees the likely causes and can stop.
- Tools cannot reach another host or another part of the Home Assistant API through the REST helper, even with hostile ids.
- Truncation is by characters, not bytes, so a body of multi-byte text can exceed 2 KB of bytes slightly; the message stays bounded either way.
- The 10 second limit is a judgment call. Slow endpoints (a large `/api/states` on a small host, `check_config`) have not been timed against a real instance and may need a per-call override.
- Behaviour against the real Nabu Casa URL (certificate, proxy status codes) is unproven locally.
- Known issue, 2026-10-22 (resolved, see the amendment below): the credentials hint was attached to 403 as well as 401, and it named a revoked token, a non-administrator and a local-only user. That is wrong for a 403 from Home Assistant itself. Home Assistant answers 401 for those causes: an unauthenticated request, which covers a bad, revoked or expired token and a local-only user reaching it remotely (`ha:homeassistant/helpers/http.py:72-73`), and a non-administrator on an administrator-only endpoint (`ha:homeassistant/components/http/decorators.py:76-81`, turned into a 401 at `ha:homeassistant/helpers/http.py:99-100`). Home Assistant answers 403 when the caller's address is banned (`ha:homeassistant/components/http/ban.py:85`). A 403 therefore pointed the model at the credentials when the cause is the address ban, and re-checking the token does not help.

## Amendment, 2026-10-22

Two changes to the helper in `src/ha/rest.ts` (lines 8-21 for the hints, 109-151 for `haFetch`):

- **A 403 has its own message.** It says that Home Assistant itself answered 403, which it gives to an address it has banned after repeated failed logins (`ha:homeassistant/components/http/ban.py:81-85`), names the cause (the address Home Assistant sees for this server is banned), gives the cure (remove the address from `ip_bans.yaml` in the Home Assistant configuration folder and restart Home Assistant) and says the request was not retried. It still ends with Home Assistant's response body. A 401 keeps the credentials hint, so the known issue above no longer applies. The statements in other records that a 401 or 403 "carries the credentials hint" now hold for the 401 only (0009, 0012).
- **`HaError.sent` tells "never sent" from "sent, no answer".** It is true for every error raised after the request was put on the wire (a timeout, a network failure, any HTTP status) and false for errors raised before anything was sent (an invalid `HA_URL`, a refused path, a rejected id). A caller that must not claim an action may have run can read it together with `status === null`: no answer arrived and `sent` is true. 0007 uses this for `call_service`.
