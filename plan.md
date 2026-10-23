# Home Assistant MCP on Cloudflare Workers — Build Plan

Oct 20, 2026 · @Guy Sperry

> **Note, 2026-10-22.** This design note is kept for history. What was built differs from it in the places listed below, and the decisions that supersede it are recorded in `docs/adr/` (see the [index](docs/adr/README.md)). The [README](README.md) describes how to set up and run the server as built. Corrections, each also marked inline with **Correction**:
>
> - A new MCP server and a new `WebStandardStreamableHTTPServerTransport` are built for every request, from a `createServer(env)` factory.
> - Tools are registered with `registerTool`, with annotations, not `server.tool`.
> - Non-POST requests get 405 and a bad `Origin` gets 403; 401 is only for a missing or wrong bearer token.
> - Automation writes return `{"result":"ok"}` and Home Assistant reloads in the background; the tool reads the config back.
> - An `id` in the request body overrides the id in the URL, so the tool strips it.
> - `triggers` and `actions` are required; `alias` is optional in Home Assistant.
> - `skip_condition` defaults to true in Home Assistant; `trigger_automation` always sends it, defaulting to false.
> - The curl smoke test needs `Content-Type: application/json` as well as `Accept`.
> - Tests use `@cloudflare/vitest-plugin`, not `@cloudflare/vitest-pool-workers`.
> - The project starts from a pinned skeleton, not `npm create cloudflare@latest`.
> - The Home Assistant user needs administrator rights for specific endpoints and must not be local-only.
> - `DELETE` does not reload; a background hook removes the registry entry.
> - `check_config` validates YAML configuration only, not individual automations or storage dashboards.

## Goal and constraints

Build a remote MCP server that lets Claude (phone, voice, web, desktop) create and edit Home Assistant automations and dashboards, not just read state. The driver: capturing automation ideas from the phone without going back to the laptop.

Constraints already decided:

- Node.js / TypeScript, not Python.
- No containers on the Home Assistant Green (underpowered); the Synology is not on site yet; the MacBook must not need to be awake.
- No new monthly subscription. Cloudflare Workers free tier is fine (same plan as the existing Jeni day-board Worker).
- Home Assistant is already reachable over HTTPS via Nabu Casa; no Cloudflare Tunnel into the Green is needed.
- Must work as a custom connector in claude.ai, so it speaks streamable HTTP on the public internet with real auth.

## Architecture

One Cloudflare Worker is the whole server. Claude calls it as a custom connector; the Worker calls Home Assistant through the Nabu Casa URL with a long-lived access token held as a Worker secret.

Request path: Claude client → `https://ha-mcp.<your-domain>/mcp` (streamable HTTP, bearer auth) → Worker → `https://<id>.ui.nabu.casa/api/...` (REST) or `wss://<id>.ui.nabu.casa/api/websocket` (WebSocket) → Home Assistant Green.

Key choices:

- Runtime: Cloudflare Workers, TypeScript, `@modelcontextprotocol/sdk` with its streamable HTTP transport. Use the `agents` package (`McpAgent`) from Cloudflare if you want stateful sessions backed by Durable Objects; a stateless Worker that handles each `/mcp` POST independently is simpler and enough here.
- Transport: streamable HTTP only. No SSE legacy endpoint, no stdio.
- HA access: REST for state, services, and automation config; WebSocket for anything that only exists there (dashboard config, config entries, device/entity registry). Open a WebSocket per tool call, authenticate, send the command, close. Workers support outbound WebSocket via `fetch` with `Upgrade: websocket`.
- Secrets: `HA_URL`, `HA_TOKEN`, `MCP_BEARER_TOKEN` as Worker secrets via `wrangler secret put`. Nothing in `wrangler.toml` vars.
- No state: the Worker holds nothing between calls. Home Assistant is the source of truth.

## Tool surface

Keep it to roughly a dozen tools. Every write tool returns what HA now has, so Claude can confirm. **Correction:** there are 15 tools, and each write tool also returns the previous value, which is the only undo for a dashboard. Names below are suggestions; keep them verb-first and predictable.

| Tool | Purpose | HA mechanism |
| --- | --- | --- |
| `list_entities` | Entities with state and friendly name, filterable by domain or substring. Needed so Claude can find real entity\_ids before writing automations. | REST `GET /api/states` |
| `get_entity` | One entity: state, attributes, last\_changed | REST `GET /api/states/{entity_id}` |
| `search_registry` | Devices, areas, and entity registry entries (area names, device names, disabled entities) | WS `config/entity_registry/list`, `config/device_registry/list`, `config/area_registry/list` |
| `list_services` | Services for a domain with their fields, so Claude writes valid action blocks | REST `GET /api/services` |
| `call_service` | Call any service (turn on, set temp, run script). Reuse of what the built-in MCP already does, kept for completeness. | REST `POST /api/services/{domain}/{service}` |
| `get_history` | State history for an entity over a window, for debugging why an automation fired | REST `GET /api/history/period/{ts}?filter_entity_id=` |
| `list_automations` | All automations: id, alias, enabled, last\_triggered | REST `GET /api/states` filtered to `automation.*` |
| `get_automation` | Full config of one automation | REST `GET /api/config/automation/config/{id}` |
| `upsert_automation` | Create or replace an automation from a JSON config (alias, description, triggers, conditions, actions, mode). Generates an id if none given. | REST `POST /api/config/automation/config/{id}`; HA writes `automations.yaml` and reloads. **Correction:** the POST returns only `{"result":"ok"}` and the reload runs afterwards, so the tool reads the config back and polls states by the `id` attribute |
| `delete_automation` | Remove by id | REST `DELETE /api/config/automation/config/{id}` |
| `trigger_automation` | Fire one manually for testing, optionally skipping conditions. **Correction:** HA defaults `skip_condition` to true, so the tool always sends it and defaults it to false | `automation.trigger` service |
| `list_dashboards` | Lovelace dashboards with their url\_path and mode | WS `lovelace/dashboards/list` |
| `get_dashboard` | Full config of one dashboard (views, cards) | WS `lovelace/config` with `url_path` |
| `save_dashboard` | Replace a dashboard config | WS `lovelace/config/save` with `url_path` and `config` |
| `check_config` | Run HA's config check before trusting a write | REST `POST /api/config/core/check_config`. **Correction:** this checks YAML configuration only, not individual automations or storage dashboards |

Schema notes for Claude Code: use `zod` schemas for every tool input; put the automation config shape in one shared schema (triggers / conditions / actions as arrays of objects, `mode` enum of single, restart, queued, parallel). Accept the newer plural keys (`triggers`, `conditions`, `actions`) and the older singular ones; HA 2024.10+ accepts both. Truncate `list_entities` output by default (name, id, state only) and offer `include_attributes` as an option, otherwise a big house blows the context window.

## Home Assistant API details

REST: every call carries `Authorization: Bearer <HA_TOKEN>` and `Content-Type: application/json`. Base URL is the Nabu Casa remote URL (Settings → Home Assistant Cloud → Remote control shows it). Remote access must be switched on in that panel.

Automation config endpoint specifics:

- `GET /api/config/automation/config/{id}` returns the stored config; 404 if the id is not UI-managed.
- `POST /api/config/automation/config/{id}` with the full JSON body creates or fully replaces. **Correction:** the response is `{"result":"ok"}`, and an `id` key in the body overrides the id in the URL, so strip it from the body. The first write rewrites `automations.yaml` without its comments. The `id` is any string you choose; HA stores it in `automations.yaml` and exposes the entity as `automation.<slug of alias>`. Use something like a timestamp or short ulid.
- Body shape: `{ "alias": "...", "description": "...", "triggers": [...], "conditions": [...], "actions": [...], "mode": "single" }`.
- `DELETE /api/config/automation/config/{id}` removes it and reloads. **Correction:** it does not reload; a background hook removes the entity registry entry, with the same visible effect, which also loses the entity's area, labels and custom entity id. An unknown id returns 400.
- Only automations in `automations.yaml` (UI-managed) are reachable. Automations in packages or split YAML files are invisible to this endpoint. Check whether any exist before relying on `list_automations` being complete. **Correction:** the listing covers every loaded automation (it comes from states, so one disabled in the registry has no state and is not listed); it is the write tools that cannot reach package automations.

WebSocket protocol (for dashboards and registries):

1. Connect to `wss://<nabu-casa-host>/api/websocket`.
2. Server sends `{"type":"auth_required"}`.
3. Send `{"type":"auth","access_token":"<HA_TOKEN>"}`; expect `{"type":"auth_ok"}`.
4. Send commands with an incrementing integer `id`: `{"id":1,"type":"lovelace/config","url_path":"lovelace"}` (use `null` url\_path for the default dashboard; in newer versions omit it. **Correction:** at HA 2026.10 null and omitted are identical; `dashboards/list` can omit the default dashboard, and `lovelace/config` may return a strategy with no `views`).
5. Match the result by `id`, then close.

Dashboard commands: `lovelace/dashboards/list` returns every dashboard with `url_path`, `title`, `mode` (storage or yaml). Only `storage` mode dashboards are writable through `lovelace/config/save`. `lovelace/config` returns `{ views: [...] }`; `lovelace/config/save` takes `url_path` and `config` and replaces the whole thing, so get-modify-save is the pattern and the tool should do a read first if the caller sends a partial change.

Registries: `config/area_registry/list`, `config/device_registry/list`, `config/entity_registry/list`. These are the only way to learn area names and which device an entity belongs to, which Claude needs to write sensible automations.

## Auth and secrets

Two credentials, both as Worker secrets, never in git.

- `HA_TOKEN`: a Home Assistant long-lived access token. Create it under the user profile (Security tab) in HA. Make a dedicated HA user named something like `claude-mcp` and mint the token there, so it can be revoked without touching Guy's own login. The user needs administrator rights for the config and registry endpoints. **Correction:** administrator rights are needed for the automation config, `check_config` and dashboard save; registry lists and dashboard reads are not admin-gated. The user must also not be "local only", because Nabu Casa requests count as remote. Each wrong token is a failed login in HA, and IP banning can permanently ban the address, so nothing retries after a 401.
- `MCP_BEARER_TOKEN`: a random 32+ byte secret the Worker checks on every request. The claude.ai custom connector setup lets you supply this as a bearer token header. Generate with `openssl rand -base64 32`.
- `HA_URL`: the Nabu Casa remote URL, e.g. `https://abc123.ui.nabu.casa`. Can be a plain var since it is not secret, but keep it as a secret anyway so the repo stays generic.

Worker-side check, first thing in `fetch`: reject anything that is not `POST /mcp` (and `GET /mcp` if streaming responses are enabled) with a matching `Authorization: Bearer` header. Return 401 with no body on mismatch. Also reject if the `Origin` header is present and not a claude.ai or anthropic.com origin, as a cheap guard against browser-based misuse. **Correction:** the order is path, method, Origin, bearer. GET and DELETE return 405 (POST already answers directly, so no GET stream is needed in stateless mode); a bad Origin returns 403; 401 is kept for a missing or wrong bearer token. The method check comes first so a GET never draws a 401, which would start the SDK client's OAuth flow.

OAuth is the better long-term answer and Cloudflare has a `workers-oauth-provider` library for it, but it adds a login UI and a KV namespace. Start with the static bearer token; upgrade only if Claude's custom connector flow stops accepting static tokens.

Open point, decided 2026-10-22: use the `*.workers.dev` URL for now; a custom domain can be added later. Still open: whether the claude.ai custom connector dialog accepts a static bearer token; if it requires OAuth, this server does not support that yet. Claude Code supports `--header` today.

Rotation: both tokens can be rotated independently. Rotating `HA_TOKEN` needs only `wrangler secret put HA_TOKEN`; rotating `MCP_BEARER_TOKEN` also means re-entering it in the claude.ai connector settings.

## Project layout and implementation steps

Repo name suggestion: `ha-mcp`. Layout:

```
ha-mcp/
  wrangler.toml
  package.json
  tsconfig.json
  src/
    index.ts          # fetch handler: auth check, route /mcp to the transport
    server.ts         # createServer(env) factory: a new McpServer per request, registers tools
    ha/
      rest.ts         # typed fetch wrapper for REST
      ws.ts           # one-shot WebSocket command helper
      schemas.ts      # zod schemas: automation config, dashboard config
    tools/
      entities.ts
      services.ts
      automations.ts
      dashboards.ts
      registry.ts
  test/
    ws.test.ts        # vitest with the Workers plugin
  README.md
```

Steps, in order:

1. **Correction:** the project starts from a pinned skeleton in the repo, not `npm create cloudflare@latest`, which would pull unpinned `@latest` packages. Originally: `npm create cloudflare@latest ha-mcp` with the Hello World TypeScript template. Add `@modelcontextprotocol/sdk`, `zod`, and `agents` if going the McpAgent route. Confirm `compatibility_date` is recent and `nodejs_compat` flag is on.
2. Write `src/ha/rest.ts`: `haFetch(env, path, init)` that prepends `HA_URL`, adds the bearer header, throws a typed error on non-2xx including HA's response body (HA returns useful validation messages on bad automation config).
3. Write `src/ha/ws.ts`: `haWsCommand(env, message)` that opens the socket, handles `auth_required` / `auth_ok` / `auth_invalid`, sends one command with `id: 1`, resolves on the matching result, rejects on `success: false`, and always closes. Add a 10 s timeout.
4. Write `src/ha/schemas.ts`: zod for `AutomationConfig` (alias required, triggers required, the rest optional; **correction:** `triggers` and `actions` are required unless `use_blueprint` is used, `alias` is optional in HA, and every object that carries HA config must be loose so zod does not strip unknown keys, because the save replaces the whole object) and a loose `DashboardConfig` (`views` array of records). Do not over-constrain triggers and actions; HA validates on save and the error message is better than ours.
5. Register tools in `src/server.ts` using `registerTool(name, { title, description, inputSchema, annotations }, handler)` (**correction:** `server.tool` is deprecated; annotations mark read tools `readOnlyHint` and the destructive ones `destructiveHint`). Descriptions matter: Claude reads them to pick tools, so say what each returns and when to use it. Return `content: [{ type: "text", text: JSON.stringify(result, null, 2) }]`.
6. Wire `src/index.ts`: auth check, then hand the request to the streamable HTTP transport. Stateless mode is fine (`sessionIdGenerator: undefined`). **Correction:** build a new `McpServer` and a new `WebStandardStreamableHTTPServerTransport` for every request; a reused stateless transport throws and `connect` refuses a second transport.
7. Set secrets: `wrangler secret put HA_URL`, `HA_TOKEN`, `MCP_BEARER_TOKEN`.
8. `wrangler dev` locally with `.dev.vars` holding the same three values. Smoke test with `curl -X POST localhost:8787/mcp -H 'Authorization: Bearer ...' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` plus the required `Accept: application/json, text/event-stream` header. **Correction:** the command also needs `-H 'Content-Type: application/json'`, or the transport answers 415; the working command is in the README.
9. `wrangler deploy`. Note the `*.workers.dev` URL or attach a custom domain route.
10. Add as a custom connector in claude.ai (Settings → Connectors → Add custom connector), URL plus bearer token. Confirm the tool list appears, then test from the phone.

Acceptance test from the phone: say "when the garage door has been open for 10 minutes after sunset, turn on the porch light" and expect Claude to call `list_entities` to find the real ids, `upsert_automation`, then `get_automation` to confirm. Then check it appears in the HA automations UI.

## Testing and connecting to Claude

- Unit: vitest with `@cloudflare/vitest-plugin` (**correction:** the renamed successor of `@cloudflare/vitest-pool-workers`; use `vi.spyOn(globalThis, "fetch")` to mock). Mock `fetch` for REST; for the WebSocket helper, test the auth handshake state machine with a fake socket.
- Integration: a `scripts/smoke.ts` that runs `tools/list`, `list_entities` with a domain filter, and `get_automation` on a known id against the deployed Worker. Run it after every deploy.
- MCP Inspector (`npx @modelcontextprotocol/inspector`) pointed at the local `wrangler dev` URL is the fastest way to exercise tools by hand before involving Claude.
- Connector in claude.ai: custom connectors are an org or account setting; once added they show up on web, desktop, and mobile, which is the whole point. The voice surface uses the same connector list.
- Also add the same URL to Claude Code via `claude mcp add --transport http ha-mcp https://.../mcp --header "Authorization: Bearer ..."` so laptop sessions get it too.

## Gotchas and open questions

- Nabu Casa proxies WebSockets (the HA frontend relies on it), but confirm the Worker can complete the handshake from Cloudflare's network. If it cannot, fall back to REST-only tools and defer dashboards.
- Workers free tier: 100k requests/day and 10 ms CPU per request on the free plan; the WebSocket helper mostly waits on I/O, so CPU is fine, but keep an eye on wall-clock timeouts (set the 10 s limit).
- Dashboard saves replace the whole config. Make `save_dashboard` require the full config and have Claude do get-then-save; a `patch_dashboard` tool that adds a card to a named view is a nice second-pass feature.
- Automations in YAML packages are invisible to the config endpoint. Check whether the Green has any before assuming `list_automations` is complete.
- Large houses produce large `list_entities` results. Default to a compact shape and cap at 200 rows with a `cursor` or require a filter.
- The built-in HA MCP connector can stay installed; this one adds to it rather than replacing it. Once this is stable, dropping the built-in one avoids duplicate tool names.
- Open: does the custom connector flow in claude.ai still accept a static bearer token, or does it now require OAuth? Check on day one; it changes step 6.
- Open: custom domain or `*.workers.dev` URL? A custom domain is cleaner for token rotation and looks less like a throwaway, but needs the zone on Cloudflare.
