# 0005. Status codes and check order at the HTTP edge

Date: 2026-10-22
Status: Accepted

## Context

The MCP endpoint is reachable from the internet and protected by one static bearer token. Clients react differently to different failures. The SDK client treats a 405 on a GET as "this server offers no server-to-client stream" and carries on, but reports any other failure of that GET as an error, and a 401 makes it start its OAuth flow. A stateless transport can never write to a GET stream, so offering one would only produce keep-alive frames.

## Options considered

1. Check the bearer first, then the method. Rejected: an unauthenticated GET would draw a 401 and send the SDK client into an authentication flow this server does not have.
2. Hand GET and DELETE to the transport. Rejected: GET would open an SSE stream that carries nothing; DELETE ends sessions that never exist.
3. Answer 401 or 404 for non-POST requests. Rejected for the reasons above; 405 is the status the client expects.
4. A JSON or text body on error responses. Rejected for 401: it tells a scanner nothing it needs, and the contract is simplest as empty bodies.

## Decision

Checks run in this order, and the first failure answers:

1. Path other than `/mcp` (exactly): 404, empty body.
2. Method other than POST: 405 with `Allow: POST`, empty body. This precedes authentication on purpose.
3. `Origin` present and not allowed (see the Origin allowlist decision): 403, empty body.
4. Missing or wrong bearer token: 401 with `WWW-Authenticate: Bearer` and an empty body.
5. Otherwise the request goes to the transport.

The bearer check accepts only `Authorization: Bearer <token>`. Both the presented value and the configured secret are hashed with SHA-256, and the two digests, which always have the same length, are compared with `crypto.subtle.timingSafeEqual`. A comparison of raw values would have to return early on a length mismatch and so reveal the secret's length; hashing first avoids that. An empty secret or an empty presented token never authenticates. The SHA-256 step is not a password hash; the token is a long random value, and hashing serves only to equalise lengths.

## Consequences

- CORS preflights (`OPTIONS`) get a 405. Browser-based clients that call the Worker directly are not supported; the connectors this server targets call it from a server.
- The token is never logged and never appears in a response.
- The 401 carries no `error` detail, so a client cannot distinguish "no token" from "wrong token".

## Amendment, 2026-10-22: statuses that come from the transport

A request that passes the five checks above reaches the SDK transport, which has checks of its own and answers them with a JSON-RPC error body: 406 when `Accept` does not list both `application/json` and `text/event-stream` (`fw:src/server/webStandardStreamableHttp.ts:721-729`), 415 when `Content-Type` is not `application/json` (`fw:src/server/webStandardStreamableHttp.ts:733-736`), 400 for an unsupported `Mcp-Protocol-Version`, and 413 for a body over 4 MiB. The original design note's `curl -d` example sends a form content type and so gets a 415; a working request needs both headers. These statuses are the transport's, not part of the edge contract chosen above; the README troubleshooting table lists them for operators.

## Amendment, 2026-10-23: the edge reads the body once and refuses batches

A sixth check now runs after the bearer check and before the transport. The edge reads the request body with the SDK's own `readRequestBody` (a 4 MiB limit, one leading byte order mark removed by the decoder) and parses it once with `JSON.parse`. It answers what the transport would answer for the same input: 413 with the transport's body for a body over the limit, and 400 with code -32700 (`Parse error: Invalid JSON`) for a body that cannot be read, is empty, or is not JSON. A parsed JSON array, whatever it holds, is refused with 400, code -32600 and the message `Invalid Request: JSON-RPC batches are not supported`: one HTTP request then carries one tool call, which keeps a guess at a delete confirmation code to one attempt per request. Any other parsed value goes to the transport as `handleRequest(request, { parsedBody })`, so the body is decoded and parsed in one place only. The log line for `initialize` takes the same parsed value.

The check order is therefore: path, method, `Origin`, bearer, then the read and parse and batch check, then the transport. An unauthenticated request still gets the 401 and learns nothing about batches. Because the edge parses before the transport checks `Accept` (406) and `Content-Type` (415), a wrong `Content-Type` with an unparseable body, or a wrong `Accept` with an unparseable or array body, gets the edge's 400 instead of the transport's 415 or 406. A wrong `Accept` or `Content-Type` with a parseable single message still reaches the transport and gets its 406 or 415. Two byte order marks are a parse error, as before. The README's troubleshooting table has a row for the batch refusal. The reasons and the cost for clients are in 0017.

## Amendment, 2026-10-26: OAuth sign-in adds paths and a second credential

When OAuth sign-in is on ([0019](0019-oauth-sign-in.md)), the edge changes in these ways. Everything not named here is as above.

- **Paths.** "On" needs all of these: the `OAUTH_KV` namespace, the `SIGN_IN_LIMITER` rate-limit binding, a non-empty `OWNER_PASSWORD` secret, the `global_fetch_strictly_public` compatibility flag, and a request origin that the OAuth library accepts (`https`, or `http` on a loopback host). With OAuth on there are five paths: `/mcp`, `/authorize`, `/oauth/token`, `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp`. With it off, or when any one requirement is missing, only `/mcp` exists and every other path is 404 with an empty body, as before.
- **Order.** For `/mcp` the order stays path, method, `Origin`, credential, then the body steps of the amendment above. The other paths have their own short orders (the token endpoint: the library's method rule, then the edge's token pre-check; `/authorize`: method, then, for a post, the same-origin rule, then the page).
- **Credential.** The static bearer is compared first, with no KV access. Otherwise, with OAuth on, a presented token that has the exact shape the library issues for the one user (`owner:` and two parts of 16 and 32 URL-safe characters) is checked with a library call and one KV read; any other token never reaches KV. The grant's session tag must match the current password, or the token is refused.
- **401.** Still an empty body. With OAuth on the header is `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="mcp"`, with `error="invalid_token", ` ahead of `resource_metadata` when a token was presented and refused. With OAuth off it is `Bearer`, as above.
- **503.** An OAuth token whose check fails because KV cannot be read gets 503 with `Retry-After: 30` and an empty body. A 503 is not a 401, so a client does not start a refresh or a sign-in loop, and nothing is let through.
- **Browsers.** "Browser-based clients that call the Worker directly are not supported" now applies to `/mcp` only. The sign-in page is a page for a browser.
