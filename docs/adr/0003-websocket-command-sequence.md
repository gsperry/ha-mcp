# 0003. Run Home Assistant WebSocket commands as one sequential sequence

Date: 2026-10-22
Status: Accepted

## Context

Some Home Assistant data is reachable only over its WebSocket API: the entity registry, the dashboard list and the stored dashboard configs. The original design opened one socket per command. A dashboard save needs four steps (list the dashboards, read the previous config, save, read back), which would mean four connections and four authentications. Every authentication is a login that Home Assistant records, and a failed one counts towards an IP ban, so fewer handshakes is also safer.

The protocol (Home Assistant Core 2026.10.2): the server sends `auth_required`, the client answers `auth` with the access token, and the server replies `auth_ok` or `auth_invalid` (`homeassistant/components/websocket_api/auth.py`, lines 25-46). Command ids must strictly increase within a connection, otherwise the server answers `id_reuse` (`connection.py`, lines 200-255). A success result is `{id, type: "result", success: true, result}` (`messages.py`, lines 63-65) and an error result carries `error: {code, message}` (`messages.py`, lines 81-104).

Some callers need a command that is allowed to fail in a known way (reading a dashboard config that has never been stored returns `config_not_found`), and some need to stop before a later command is sent when an earlier result shows the action is unsafe (refusing to save into a dashboard in YAML mode).

## Options considered

1. One socket per command. Rejected: four authentications for one dashboard save, and no way to make the later commands depend on the earlier results without reconnecting.
2. Pipeline all commands on one socket without waiting for results. Rejected: a failed or refused step could not prevent the later ones, and the save would already be on the wire when an earlier check fails.
3. One socket, commands sent strictly one at a time. Chosen.

## Decision

`haWsCommands(env, commands)` in `src/ha/ws.ts` opens one connection, authenticates once and runs the commands in order with ids 1..n. Command k+1 is sent only after command k's result has arrived.

- Each command may list `allowErrorCodes`. An error with a listed code is returned as that command's result (`{ success: false, error }`) and the sequence continues. Any other `success: false` stops the sequence at once, sends nothing further and rejects with Home Assistant's `code` and `message`.
- Each command may carry a `check(result)` callback that runs before the next command is sent. If it throws, nothing further is sent and the helper rejects with that error. Callers use this to refuse a write before it is issued.
- `auth_invalid` rejects immediately with a message naming the likely causes (token revoked or invalid, user inactive, user marked local-only; the checks are in `homeassistant/components/http/auth_util.py`, lines 15-40). A command rejected with `unauthorized` gets an added hint that the user may lack administrator rights. There is no retry of any kind, including after a close or a timeout.
- The whole exchange, including the upgrade request, has a 10 s limit. This is long enough for a registry or dashboard read through a remote proxy and short enough to sit well inside a Worker request. On timeout the fetch is aborted, the helper rejects and the socket is closed.
- The socket is closed on every path: success, error, abort, timeout.
- A throw from the socket's `send` rejects the call at once with an `HaWsError` that has no `code`, instead of leaving it to the 10 s limit. This covers the `auth` message, the first command after `auth_ok` (both sent from the message listener) and a later command sent from the result handler, which runs as a discarded promise (`src/ha/ws.ts`, lines 139-152). Because the error has no `code`, callers classify it as they classify a timeout or a close: a transport failure whose effect on Home Assistant is unknown. Nothing further is sent and the socket is closed.
- The token is sent only in the `auth` message. It is not part of any error message.
- The socket is opened with `fetch("https://<host>/api/websocket", { headers: { Upgrade: "websocket" } })` and the `webSocket` property of the response, as the Cloudflare Workers documentation describes. The URL keeps the `https` scheme of the configured address instead of using `wss://`. A response without a `webSocket` is an error naming the HTTP status. `HA_URL` is validated with the same origin check as the REST client, so an invalid or non-http(s) value is a clear error and no request is made. If the upgrade resolves after the time limit, the late socket is closed.

## Consequences

- A dashboard save needs one connection instead of four.
- Callers can express "this error is fine" and "stop before the write" without extra connections.
- A failed step leaves later steps unsent, so the caller never has to undo a command it did not send.
- Tests drive a fake server through `WebSocketPair` and a fetch spy. That is the local test runtime and not proof of production behaviour. Whether a Worker can open this WebSocket through the Nabu Casa remote-access address with an `https` URL and an `Upgrade` header is unproven; it needs a run against the real instance. If it does not work, the tools that depend on this helper cannot work in production.

## Amendment, 2026-10-22

The send-throw rule in the Decision list was added after the first version of this record. Before it, a throw from `send` inside the helper settled nothing: in the message listener it surfaced as an uncaught exception (or, in the local test runtime, as the socket's error event), and from the result handler it became an unhandled rejection of a discarded promise, so the call ran to the 10 s timeout. The rule is implemented by one `send` wrapper in `exchange` (`src/ha/ws.ts`, lines 139-146) that every send goes through.

## Amendment, 2026-10-22: the command list is read lazily

The safety policy (0016) walks scripts, scenes, groups and blueprints on one connection, and it cannot know in advance which commands it needs: each answer decides the next. It does this by appending commands to the array it gave the helper, from inside a command's `check`. The helper already allowed this and its behaviour is unchanged: `commands[index]` is read when a command is sent and `commands.length` after each check, so a command appended during a check is sent next, in order, on the same connection and with the next id; a check that appends nothing ends the sequence; a check that throws stops it and nothing it appended is sent. What changed is that this is now a stated contract: the doc comment of `check` in `src/ha/ws.ts` says so, and `test/ha/ws.test.ts` has two tests (appending from a check, including after an `await`, and the two ways of stopping). The whole exchange, appended commands and any REST reads a check makes included, still has the single 10 s limit.
