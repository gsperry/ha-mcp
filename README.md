# ha-mcp

A remote [Model Context Protocol](https://modelcontextprotocol.io) server on Cloudflare Workers that lets Claude read Home Assistant state and create or edit automations and dashboards. Claude reaches it as a custom connector over streamable HTTP; the Worker talks to Home Assistant through its public HTTPS URL with a long-lived access token.

Status: early development. The original design note is in [plan.md](plan.md), kept for history; where it and this README disagree, this README and the code are right.

Steps that only a person can do are marked **Human step**. Everything else in this file is a command you can run yourself.

## Requirements

- Node.js 22 (see `.nvmrc`)
- A Cloudflare account (the Workers free plan is enough)
- A Home Assistant instance reachable over HTTPS, for example through Nabu Casa (`https://<your-instance>.ui.nabu.casa`)

## Home Assistant setup

**Human step.** Do this in Home Assistant before anything else.

1. Create a dedicated user, for example `claude-mcp`, so its token can be revoked without touching your own login.
2. Make that user an **administrator**. Reading states, services and history works for any user, but these need admin: reading and writing automation config, `check_config`, saving a dashboard, and reading the config of a YAML-defined automation.
3. Do **not** tick "Local access only" for the user. Requests that arrive through Nabu Casa count as remote, so a local-only user is refused on every call: a 401 on REST calls and `auth_invalid` on WebSocket calls.
4. Log in as that user, open Profile, then Security, and create a long-lived access token. Copy it once; Home Assistant never shows it again.
5. Turn on remote access (Settings, Home Assistant Cloud, Remote control) and note the remote URL.

### Failed logins and IP banning

Every request Home Assistant answers with a 401 is a failed login: a wrong, revoked or expired token, a non-administrator calling an administrator-only endpoint, and a local-only user reaching Home Assistant through Nabu Casa all count. Home Assistant records each one and raises a notification. If IP banning is enabled (`http: ip_ban_enabled` with a `login_attempts_threshold`), enough failed logins ban the address Home Assistant sees, and the ban stays until someone removes the entry from `ip_bans.yaml` by hand and restarts Home Assistant (the ban list is read only at startup). The address Home Assistant sees for this server's requests is expected to be a Cloudflare address rather than your home address, so banning it would block the server rather than you (confirm this in your first real run).

This server never retries a Home Assistant call and never repeats a call after a 401. Do the same in anything you build on top of it: do not put the smoke script, a client or a monitor in a retry loop. If you see a 401 from Home Assistant, fix the token first (see Troubleshooting), then try once.

## Secrets

| Name | What it is |
| --- | --- |
| `HA_URL` | Base URL of the Home Assistant instance, for example `https://<your-instance>.ui.nabu.casa` |
| `HA_TOKEN` | The long-lived access token of the dedicated administrator user |
| `MCP_BEARER_TOKEN` | A random secret that clients present to the Worker |

Generate the bearer token with:

```sh
openssl rand -base64 32
```

For a deployed Worker, set each one with `wrangler secret put <NAME>` (see Deploy). Never put them in `wrangler.toml` or commit them.

Three optional settings, `ALLOW_SYSTEM_ACTIONS`, `ALLOWED_NOTIFY_SERVICES` and `DELETE_CONFIRMATION_NOTIFY_SERVICE`, are plain variables and not secrets; see Safety policy. Deleting an automation needs the last one: see Deleting an automation.

## Install and develop

```sh
npm ci            # install exactly what package-lock.json pins
npm run fast      # typecheck and tests
npm run check     # typecheck, script typecheck, tests, and a bundle dry run (deploys nothing)
npm run dev       # wrangler dev on http://localhost:8787
```

The repo's `.npmrc` pins the public npm registry so installs do not depend on machine-level registry settings. Run `npm` from inside the checkout.

### Running locally

`wrangler dev` needs the three secrets. Either pass them on the command line:

```sh
npm run dev -- \
  --var HA_URL:https://<your-instance>.ui.nabu.casa \
  --var HA_TOKEN:<token> \
  --var MCP_BEARER_TOKEN:<bearer-token>
```

or copy `.dev.vars.example` to `.dev.vars` and fill it in (the file is gitignored; never commit it). With dummy values the Worker starts and answers MCP requests, but every tool that calls Home Assistant fails.

The test suite never reads `.dev.vars`: it uses fixed fake values, a canary file in the project root checks that nothing leaks, and no test touches the network. Running tests cannot reach your Home Assistant.

### Editor note

`tsconfig.json` covers `src/` only. Test files are typechecked through `tsconfig.test.json`, and scripts through `tsconfig.scripts.json`. `npm run typecheck` runs the first two. If your editor reports unknown globals in `test/`, point it at `tsconfig.test.json`.

## Smoke tests

### curl

With the dev server running (or against the deployed URL):

```sh
curl -sS -X POST http://localhost:8787/mcp \
  -H 'Authorization: Bearer <bearer-token>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Expect HTTP 200 and a JSON body listing 15 tools. Without the `Content-Type` header you get 415; without the `Accept` header you get 406.

### npm run smoke

```sh
SMOKE_URL=http://localhost:8787/mcp \
MCP_BEARER_TOKEN=<bearer-token> \
npm run smoke
```

| Variable | Meaning |
| --- | --- |
| `SMOKE_URL` | Full endpoint, for example `https://<worker>.workers.dev/mcp` |
| `MCP_BEARER_TOKEN` | The bearer token the Worker expects |
| `SMOKE_AUTOMATION_ID` | Optional. When set, the script also reads that automation's config |

It runs `initialize`, `tools/list` (checks all 15 tools are present), `list_entities` for the automation domain, and optionally `get_automation`. Every step is read-only. It prints a PASS or FAIL line per step, exits non-zero on any failure, and never prints the token. It stops at the first 401 from the Worker (a wrong `MCP_BEARER_TOKEN`) rather than repeating it. A 401 from Home Assistant is different: it comes back as a tool error inside an HTTP 200, so the script does not stop, and with `SMOKE_AUTOMATION_ID` set a bad `HA_TOKEN` causes two failed logins. Leave `SMOKE_AUTOMATION_ID` unset until the `list_entities` step passes. Against a local Worker with dummy Home Assistant values, the first two steps pass and the Home Assistant step fails; that is expected.

### MCP Inspector (optional)

**Human step.** The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) is handy for calling tools by hand. It is not pinned by this repo: `npx` downloads the latest version and opens a browser UI, so run it only if you are happy with that. It was not run while writing this guide.

```sh
npx @modelcontextprotocol/inspector
```

Choose the Streamable HTTP transport, set the URL to the Worker's `/mcp` endpoint, add the header `Authorization: Bearer <bearer-token>`, and connect using its proxy mode, not direct browser mode. Do not use direct browser mode: a browser sends an `Origin` header and a preflight `OPTIONS` request, and this server answers the preflight with 405 and any non-Claude `Origin` with 403, by design.

## Deploy

**Human step.** Deploying changes your Cloudflare account, so run these yourself:

```sh
npx wrangler login                   # once
npx wrangler secret put HA_URL
npx wrangler secret put HA_TOKEN
npx wrangler secret put MCP_BEARER_TOKEN
npx wrangler deploy
```

The Worker is served at `https://ha-mcp.<your-account>.workers.dev`; the MCP endpoint is that URL plus `/mcp`. A custom domain can be added later without code changes, but you would then re-enter the new URL in each client.

Then run `npm run smoke` against the deployed URL (also a human step, since it uses your real token), with `SMOKE_AUTOMATION_ID` set to an automation id you know if you want that step to run. Passing all steps proves the Worker can reach Home Assistant through Nabu Casa.

## Connecting Claude

### claude.ai connector

This server authenticates with a fixed bearer token, not OAuth, so the connector sends the token as a request header. Every step below is a human step.

1. **Human step.** In claude.ai, open Settings, Connectors, Add custom connector.
2. **Human step.** Enter the Worker's MCP URL, for example `https://ha-mcp.<your-account>.workers.dev/mcp`. Use the Worker's `/mcp` URL, never your Home Assistant URL: the connector talks to this server, which talks to Home Assistant.
3. **Human step.** On the second step of the dialog, set Authentication to **No sign-in**. Leave the OAuth client options empty.
4. **Human step.** Under Request headers, add a header named `authorization` with the value `Bearer <MCP_BEARER_TOKEN>`, using the same value as the `MCP_BEARER_TOKEN` secret. Claude sends the value exactly as entered, so type the word `Bearer`, one space, then the token. An `Authorization` header cannot be used on a connection that signs in with OAuth, which is why Authentication must be No sign-in.
5. **Human step.** Add the connector and enable it in a conversation.

Request headers is a beta feature in claude.ai, and bugs have been reported against it. A connector's authentication settings cannot be edited after it is added, so to change the token or any other authentication setting, remove the connector and add it again.

If the connection fails, check this first: a 401 from the Worker means the header was not sent or the token is wrong. Compare the header value with the `MCP_BEARER_TOKEN` secret, check that it starts with `Bearer ` and has no stray spaces or line breaks, and see Troubleshooting. Claude Code (below) sends custom headers too.

Once connected, check that the tool list appears, then try it from the phone: ask Claude to create an automation, for example "when the garage door has been open for 10 minutes after sunset, turn on the porch light". It should look up the real entity ids, call `upsert_automation`, then `get_automation`. Check the result in the Home Assistant automations screen. This phone test is a human step.

### Claude Code

**Human step.**

```sh
claude mcp add --transport http ha-mcp https://ha-mcp.<your-account>.workers.dev/mcp \
  --header "Authorization: Bearer <bearer-token>"
```

## Rolling back

Redeploying a build from before delete confirmation silently restores single-call deletes (no code, no phone) and an empty default notify allowlist, and nothing on the server records that this happened. Do not roll back past that change without knowing. Automations or scripts the model writes under the older build stay after you redeploy this one and are not re-checked, so after any such period do the review step under Deleting an automation, and delete what it finds in Home Assistant.

## Token rotation

**Human step** for every item; each secret rotates independently.

- `HA_TOKEN`: create a new long-lived token for the same Home Assistant user, run `npx wrangler secret put HA_TOKEN`, then delete the old token in Home Assistant. Nothing changes for clients.
- `MCP_BEARER_TOKEN`: generate a new value with `openssl rand -base64 32`, run `npx wrangler secret put MCP_BEARER_TOKEN`, then update every client: remove the claude.ai connector and add it again with the new `authorization` header value (its authentication cannot be edited in place, see claude.ai connector), and run `claude mcp remove ha-mcp` and `claude mcp add` again with the new header. Clients fail with 401 until you do.
- `HA_URL`: if the remote URL changes, run `npx wrangler secret put HA_URL`.

## Tools

Fifteen tools. Read tools are annotated read-only; `upsert_automation`, `delete_automation` and `save_dashboard` are annotated destructive; `call_service` and `trigger_automation` act on the house.

| Tool | Purpose |
| --- | --- |
| `list_entities` | Entities as `{entity_id, name, state}` rows, filterable by domain or substring, paged |
| `get_entity` | One entity's state, attributes and timestamps |
| `list_services` | Services by domain with their fields |
| `call_service` | Call any Home Assistant service (acts on the house) |
| `get_history` | Recorded state changes of one entity over a time window, capped |
| `search_registry` | Entity registry joined to devices and areas, to find real entity ids, areas and device names |
| `list_automations` | All loaded automations with id, entity id, alias, state and last triggered, paged |
| `get_automation` | One automation's full stored config, and whether it is editable here |
| `trigger_automation` | Run an automation now; conditions are checked unless you set `skip_condition` |
| `check_config` | Ask Home Assistant to validate its YAML configuration |
| `upsert_automation` | Create or replace an automation; returns the previous and current config |
| `delete_automation` | Delete an automation; returns the deleted config so it can be restored |
| `list_dashboards` | Dashboards with url path, title and mode |
| `get_dashboard` | One dashboard's stored config |
| `save_dashboard` | Replace a storage dashboard's whole config; returns the previous config |

`check_config` validates YAML configuration files only. It does not validate an individual automation (the error from the write itself is the check) and does not check storage dashboards.

## What writes change

- **First automation write.** Home Assistant rewrites the whole of `automations.yaml` from its own data the first time you save through this server (or the UI). Hand-written comments and formatting in that file are lost. Back it up first if you care.
- **Deleting an automation** takes two calls and a one-time code that Home Assistant sends to your phone (see Deleting an automation). It also removes its entity registry entry: area, labels, categories, name, voice-assistant options, aliases and custom entity id. The tool result lists what it can see so you can re-apply it, but aliases are not shown, so note them before deleting. Home Assistant keeps the removed entry for 30 days and restores it if an automation with the same id is created again, but do not rely on that.
- **Updates replace everything.** `upsert_automation` and `save_dashboard` replace the whole stored object; a missing key is deleted. Every unknown key you send is passed through unchanged. Read first, edit that copy, send the whole thing.
- **Undo.** Both tools return `previous_config`. To undo an automation update, upsert it again with the same `id` and `previous_config`; to undo a create, delete it (that delete needs your code, and the system-action block on). To undo a dashboard save, save `previous_config` again. Home Assistant keeps no dashboard history, so that returned copy is the only one. An undo through this server is itself a write, and the safety policy checks it like any other. Saving an automation's returned `previous_config` or `deleted_config` again is refused when it holds something the policy refuses, even though the change being undone was allowed: for example a legacy notify call that is not on the allowlist, a device step of an integration that is not on the accepted list, a trigger the capture rule refuses, or a blueprint instance while the WebSocket is down. In that case, restore the returned config in Home Assistant's own automation editor.
- **Last write wins.** If you edit the same automation or dashboard in Home Assistant at the same moment, one of you overwrites the other.
- **Read-only here.** Automations from YAML files or packages and YAML-mode dashboards are listed and readable but cannot be changed through this server. A dashboard that was auto-generated cannot be returned to that state by any tool.
- **Automation updates reload in the background.** Home Assistant answers the write before the reload finishes, so `state` is only reported for a create. Delete does not reload; Home Assistant removes the entity itself.

## Deleting an automation

`delete_automation` takes two calls and needs your phone, so a model cannot delete an automation alone.

1. Claude calls it with only the automation's `id`. Nothing is deleted. The server sends a one-time eight-digit code to your phone as a Home Assistant notification (title "Confirm automation delete") that names the automation: its id, its entity id and its alias. The reply to Claude carries a challenge and never the code.
2. You check that the notification names the automation you meant, and read the code to Claude in the chat.
3. Claude calls it again with the id, the challenge and your code. The server checks them and deletes. The reply carries the deleted config, so the automation can be restored.

The code and challenge live for five minutes. A wrong code, an expired or altered challenge, a challenge for another automation, or an automation that changed after the code was sent is refused and nothing is deleted; Claude then asks for a new code. Overwriting an automation or a dashboard needs no code. If the notification does not arrive, tell Claude, who asks again; a push that fails is only logged by Home Assistant, so the server cannot tell.

The server stores nothing. The challenge is signed with a key derived from `HA_TOKEN`, so rotating the Home Assistant token ends any open challenge. A code has eight digits and the server cannot count attempts, so a holder of the bearer token could still guess: the chance is about 3 in 100,000 per challenge at 10 requests a second, and on the free plan at most 1 in 1,000 a day (the plan's daily request cap). A paid plan has no such cap. Rotate the bearer token if you suspect it leaked.

**Human step.** Set it up once:

1. Find the notify service of your phone in Home Assistant (Developer Tools, Actions, search `notify.mobile_app`).
2. Set `DELETE_CONFIRMATION_NOTIFY_SERVICE` to it, for example `notify.mobile_app_pixel`, as a plain Worker variable (see Settings), and redeploy. Until you do, every delete is refused with a message that names the setting.
3. Deletes are refused while `ALLOW_SYSTEM_ACTIONS` is `true`. Leave it unset to delete.
4. Try one delete of a throwaway automation and check that the notification arrives and the code works.

**Checklist.** The code is only as private as the notification:

- Name the companion app's service for one phone. Do not use `persistent_notification` or `send_message` (refused), and do not name a notify group at all: a group sends the code to every member, a member that is `persistent_notification` or mirrors the message lets a model-written automation read it, and a slow member can push the call past its 15 second limit.
- Do not enable the companion app's last-notification sensor for the Home Assistant app, and do not use a notify service that copies the message into an entity.
- Do not configure `mqtt_eventstream`, and remove your own automations that listen for `call_service` or for `mobile_app_notification_*` events.
- Check once, in Developer Tools, Events, listening for `*`, that nothing but the `call_service` event of the call carries the digits during a delete request.
- The notification shows on a locked screen; set your phone accordingly.
- Read the notification before you read out the code. The model can also message your phone through the allowlisted service, including text that looks like a code request; a made-up code never works, but only read out a code for the automation you asked about.

**Review after a gap.** The policy checks what is written, never what already exists. An automation or script written while `ALLOW_SYSTEM_ACTIONS` was `true`, or under a build without these rules (a rollback, or before delete confirmation was first deployed), stays in Home Assistant after you turn the block back on or redeploy, and nothing re-checks it. Such an automation could read a later code. Before you rely on delete confirmation after any such period, review every automation created or changed through the server during it, including your own automations that the server overwrote (an overwrite keeps your id), and the scripts those automations call. Look for event triggers on `call_service`, `*`, a computed type or `mobile_app_notification*`; for `sql.query` or any other service the policy now refuses or that returns stored data (for example `file.read_file`); and for service names built from templates. Delete what the review finds in Home Assistant: turning an automation off is not enough, because a model can turn it back on (the policy does not walk `automation.turn_on`, one of the automations-on-their-own-trigger limits under Limits below). As an optional extra check, save an automation again unchanged through `upsert_automation` with the block on, which runs the current policy over it and refuses it if it holds something the policy refuses. Alternatively, exclude the `call_service` event from the recorder (`recorder: exclude: event_types: [call_service]`), which stores no copy of the message for `sql.query` to return; the cost is that the logbook loses the "triggered by action" context it reads from those rows, and it does not help against a capture trigger, so the review is still needed for that.

Wait five minutes after turning the block back on before relying on a challenge issued before the change.

## Safety policy

Home Assistant runs whatever it is asked to run as an administrator, and this server gives a model the ability to call any service, trigger automations and write automations. So the server itself refuses **system actions**, deterministically, before anything is sent to Home Assistant. A model cannot talk its way past it: no tool argument and no chat message changes the policy. Only the Worker settings below, which a person sets outside the conversation, do.

The policy covers every route the server can cause, not just the service name in the request. For `call_service`, `trigger_automation` and `upsert_automation` the server first works out what the request would run. It reads the entity list Home Assistant keeps, expands floors, areas, devices, labels and groups the way Home Assistant does, reads the scripts, automations, scenes and groups the request would reach (up to five levels deep), expands blueprints, and walks every step of what it finds, however deeply nested. Most of that is read over one WebSocket connection per request; the members of scenes and groups and the configs of `script.<key>` scripts are read over REST, up to 10 reads per request, which keeps the whole check within the free plan's subrequest limit. Nothing that changes the house is sent until every check has passed.

A refusal is a tool error that starts with "Refused by this server's safety policy". It says which rule applied and what was refused, that the server's configuration blocks it and not Home Assistant, and that nothing was sent. Read tools, `delete_automation` and `save_dashboard` are not checked by this policy (a delete has its own confirmation, below). Deleting an automation, overwriting an automation or dashboard, and locks, alarm panels and covers are not treated as system actions and are not blocked here.

### What is refused

**Blocked services and domains.** These are refused in a direct call and wherever they appear inside a script, scene, automation or blueprint the server walks:

| Refused | What it is |
| --- | --- |
| every service of `hassio`, `backup`, `shell_command`, `python_script`, `profiler`, `debugpy` | Supervisor (add-ons, host reboot and shutdown, backups and restore), backups, shell commands, Python scripts, process profiling, a debugger port. Whole domains, so new services in them stay blocked |
| `homeassistant.restart`, `homeassistant.stop` | Restart or stop Home Assistant |
| `homeassistant.set_location` | Moves the stored home location |
| `recorder.purge`, `recorder.purge_entities`, `recorder.disable` | Purge history, or stop recording |
| `update.install` | Installing an update (core, Supervisor, operating system, add-on) |
| `cloud.remote_disconnect` | Cuts remote access, which is the way this server reaches Home Assistant |
| `synology_dsm.reboot`, `synology_dsm.shutdown`, `portainer.recreate_container`, `system_bridge.power_command` | Reboot or shut down a NAS, recreate a container, or run a power command on a machine, any of which can be the one that runs Home Assistant. They name a device or nothing, so an entity check cannot see them |
| `group.set`, `scene.create` | Change what a group or scene holds while a script runs, which would undo a check made beforehand |
| `sql.query` | Runs caller-supplied SQL |
| `media_extractor.play_media` | Forwards area and device targets to media players, past the entity checks |

**Dispatch services**, which hand free text to an assistant that can act on entities the server never checked: `conversation.process`, `google_assistant_sdk.send_text_command`, `alexa_devices.send_text_command`. `assist_satellite` and `ai_task` services are allowed.

**Entity platforms** that run configured actions or commands, or stop the machine that runs Home Assistant:

`template`, `command_line`, `universal`, `wake_on_lan`, `panasonic_viera`, `hassio`, `portainer`, `proxmoxve`

Any service call that acts on an entity of one of these platforms is refused, harmless calls included, however the entity is reached: named, from an area, floor, device, label or group, as a scene member, or from a script or automation. So template switches, lights and buttons, command-line switches and covers, `universal` media players, Wake-on-LAN switches, Panasonic Viera players, Supervisor add-on switches (and the core, operating system and add-on update entities), and Portainer and Proxmox controls cannot be operated through this server, and `entity_id: all` for a domain that holds one of them is refused. The platform is read from Home Assistant's own `entity/source` list, so YAML-defined entities are covered. An entity that has no platform there (a misspelt id, a disabled entity, a registry id instead of an entity id) is refused as unknown.

**Legacy notify services.** Every service of the `notify` domain other than `send_message` is refused unless it is on the allowlist below, because a `command_line` notify service runs a shell command and has no entity to classify. `notify.send_message` is an entity service and is classified like any entity. **The allowlist is empty by default.** With neither `ALLOWED_NOTIFY_SERVICES` nor `DELETE_CONFIRMATION_NOTIFY_SERVICE` set, no legacy notify service can be called, and an owner script that calls `notify.notify` or `notify.mobile_app_<phone>` cannot be run through the server. When `ALLOWED_NOTIFY_SERVICES` is absent, the allowlist is the one notify service named in `DELETE_CONFIRMATION_NOTIFY_SERVICE` (see Deleting an automation), and only when that name is valid and is not `send_message` or `persistent_notification`; the server's own call that sends a delete code is checked against the allowlist like a model's call. So the model can call that service itself, and can send your phone text of its own, but not a valid code. A notify group on the allowlist reaches every member of the group, so list only a group whose members you trust.

**Other refusals.**

- Buttons: a button with the entity category `config`, the device class `restart`, or no entity registry entry is refused, because reboot and shutdown buttons of hosts and NAS devices look like this. An ordinary button, such as a garage opener, works.
- Anything whose effect cannot be told in advance: a templated service name, target or whole `data`; a templated mapping key; a templated media-player field of `tts.speak`, the legacy `tts` say services or `camera.play_stream`; a device action of an integration other than light, switch, fan, humidifier, remote, button, alarm control panel, climate, cover, lock, number, select, text, vacuum or water heater, or a device action with no entity; an `event` step with a computed type or a type starting with `homeassistant_`; a script, automation, scene or group that cannot be read; and a whole `data` text that is not a plain mapping.
- A request that reaches more than 20 scripts, automations, scenes or groups, nests more than five levels, needs more than 40 WebSocket commands, makes more than 10 scene, script or group reads, or holds more than 1000 steps is refused as too large to check.
- `entity_id: all` on `homeassistant.turn_on`, `turn_off` and `toggle`, which Home Assistant refuses too.
- Registry ids as targets: name the entity id instead.
- `script.<key>` for a script from a YAML package: run it with `script.turn_on` and its entity id.
- **A guard against copying secrets.** `upsert_automation` refuses an automation (or a blueprint expansion) with an event trigger on `call_service`, the wildcard `*`, or a computed event type, in its own triggers or in any `wait_for_trigger` step. Home Assistant announces every service call with its full data on that event, so such an automation could copy a code the server sends to the owner. The same guard refuses an event trigger or `wait_for_trigger` step whose type starts with `mobile_app_notification` (the companion app's received, cleared and action events), because the app can put notification text in them. So an automation written through this server cannot listen for those events, which includes the common actionable-notification button pattern; write such automations in Home Assistant itself. This guard stays on when the system-action block is off.

When Home Assistant or the WebSocket cannot be reached, a request that names an entity, or that reaches a script, automation, scene or area, is refused: the server cannot classify it and does not guess. Calls that need nothing from Home Assistant to be judged (`homeassistant.reload_all`, `persistent_notification.create`, an allowlisted notify service) still go through. Nothing is retried, and a failed login is never repeated.

**Limits.** The policy is a list of known routes plus the platform list above, not a proof. Other integrations, especially custom ones, that run configured actions behind ordinary services are not covered. Automations that Home Assistant runs later on their own trigger are not examined, and neither is a script edited after the server read it. Entities that wrap others (`switch_as_x`, `generic_thermostat`) are judged by their own platform. Review the lists above after each Home Assistant upgrade.

### Settings

All three are optional, plain Worker variables (not secrets). None has a value in this repository's `wrangler.toml`.

| Setting | Meaning |
| --- | --- |
| `ALLOW_SYSTEM_ACTIONS` | Absent by default. Only the exact text `true` turns the system-action block off; any other value, an empty one included, leaves it on, so a typo fails closed. With it off, the blocked services, platform list, dispatch list, walking and entity checks above are skipped. The capture guard and the legacy notify rule stay on. **Deletes are refused while the block is off**, in both calls, because the code could then be read back (see Deleting an automation). An automation or script the model wrote while the block was off, or while a build without the rules described here was deployed (a rollback, or before the delete confirmation was first deployed), stays in place after the block is turned on and is not re-checked: see the review step under Deleting an automation |
| `ALLOWED_NOTIFY_SERVICES` | A comma-separated list of legacy notify services the model may call, written `notify.<name>` or `<name>`, compared in lower case, for example `notify.mobile_app_pixel, persistent_notification`. When set, even to an empty text, it is the whole list. When absent, the list is the service named in `DELETE_CONFIRMATION_NOTIFY_SERVICE`, if that is usable. It applies with the block on or off |
| `DELETE_CONFIRMATION_NOTIFY_SERVICE` | Absent by default, which refuses every delete. The legacy notify service that sends the delete code to your phone, written `notify.<name>` or `<name>`, for example `notify.mobile_app_pixel`. Lower-case letters, digits and underscores only; `send_message` and `persistent_notification` are refused. It must be on the allowlist above, which it is by default when `ALLOWED_NOTIFY_SERVICES` is absent |

**Human step.** Set them yourself, for example under `[vars]` in your own Wrangler configuration, or in the Cloudflare dashboard (Workers, your Worker, Settings, Variables), then redeploy or save. Do not set `ALLOW_SYSTEM_ACTIONS` to `true` unless you want a model to be able to restart Home Assistant and run shell commands. While it is `true`, deleting an automation is refused.

### Cost and what to measure

A request that names an entity opens one WebSocket connection before the acting call, plus up to 10 REST reads for scene and group members and `script.<key>` configs: at most 11 extra subrequests on the Workers free plan, which allows 50 per request, and the whole check has 10 seconds. An `upsert_automation` for a new id is refused, with nothing written, when the checks before the write have taken more than 30 seconds. The CPU time the free plan's 10 ms per request leaves for parsing the entity list of a large house has not been measured.

**Human step.** After deploying, ask Claude to restart Home Assistant and confirm that the server refuses, then ask it to turn on a light and confirm that works.

## Troubleshooting

Status codes from the Worker itself (401, 403, 404 and 405 have empty bodies; 415, 406, 413 and 400 carry a JSON-RPC error body):

| Status | Meaning and fix |
| --- | --- |
| 401 | The bearer token is missing or wrong. Check the `Authorization: Bearer <token>` header against the `MCP_BEARER_TOKEN` secret. For the claude.ai connector, confirm the request header is named `authorization` and its value starts with `Bearer ` (see claude.ai connector). |
| 403 | The `Origin` header is not `claude.ai`, `anthropic.com` or a subdomain of either. Command-line clients send none; browsers do. Use the Inspector in proxy mode. |
| 405 | Only `POST /mcp` is served. GET, DELETE and the browser's preflight `OPTIONS` get 405 with `Allow: POST`. |
| 404 | The path is not exactly `/mcp`. |
| 415 | Add `Content-Type: application/json`. |
| 406 | Add `Accept: application/json, text/event-stream`. |
| 400 "JSON-RPC batches are not supported" | The client sent a JSON array (a batch). Send one message per request. The Worker reads each body once and refuses batches so that one request carries one tool call. |
| 413 or 400 "Parse error" | The body is over 4 MiB, cannot be read, or is not JSON. |
| 400 "Unsupported protocol version" | The client sent an `Mcp-Protocol-Version` header outside the SDK's supported list (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07). Update the client. The Worker logs the version and client name of each `initialize` request (`wrangler tail` is a human step). |

Errors from Home Assistant come back as tool errors:

- **401 from Home Assistant.** The token was revoked or expired, the user is not an administrator, or the user is "local access only" (over the WebSocket, used by the safety policy, the automation registry guard, both delete calls, `get_automation`'s fallback for package automations and the dashboard and registry tools, a bad token or a local-only user gets `auth_invalid` instead of a 401). Fix the cause, then try once; nothing is retried, and every failed attempt counts toward an IP ban.
- **403 from Home Assistant.** This is not a token, administrator or local-only problem (those are all 401). Home Assistant's own 403 means the address it sees for this server is banned. Remove that address from `ip_bans.yaml` and restart Home Assistant, then fix the cause of the failed logins before trying again.
- **"could not reach Home Assistant" or a timeout.** `HA_URL` is wrong, remote access is off, or Home Assistant is down. Most calls time out after 10 seconds; creating, replacing or deleting an automation allows 20 seconds, and the state checks after creating an automation wait up to 4 seconds each.
- **`registry_check_unavailable`.** An `upsert_automation` call that supplies a new `id` was refused because the entity registry could not be read, so the tool could not tell whether the id was already taken. Omit `id` to let the tool generate one, or retry when the registry can be read.
- **`entity_not_found` warning, or a failed reload.** The write is stored, but the automation did not show up in Home Assistant's states within the polling time. It may still be loading, an earlier registry entry may have been restored as disabled, a configuration error elsewhere may have stopped the reload, or `automations.yaml` may not be included by your configuration. Do not create it again. Run `check_config`, look in the Home Assistant log, and read the automation with `get_automation`.
- **"Confirmation is not set up" on a delete.** The message names the cause: `DELETE_CONFIRMATION_NOTIFY_SERVICE` is not set, is not a valid notify service name, is `send_message` or `persistent_notification`, or `ALLOWED_NOTIFY_SERVICES` is set and does not list it; or `ALLOW_SYSTEM_ACTIONS` is `true`, which refuses deletes. Nothing was sent to Home Assistant. See Deleting an automation.
- **A delete whose notification step failed.** The message gives the status and says a code may have arrived on your phone but cannot be used, because no challenge was returned. Nothing was deleted and nothing was retried; ask again.
- **"Refused by this server's safety policy".** The server's own policy refused the request before anything was sent; see Safety policy above. The message names the rule. When it says the check could not be completed, Home Assistant or its WebSocket could not be reached (the cause is in the message); nothing was sent and nothing was retried.
- **"outcome unknown".** A write was sent but the answer never arrived. It may or may not have been applied. Wait a few seconds, then read the automation or dashboard back before doing anything else. Nothing is retried automatically.

## Layout

`src/index.ts` is the Worker entry: it checks path, method, `Origin` and bearer token, reads and parses the body once (refusing JSON-RPC batches), then builds a new MCP server and transport for each request and hands the transport the parsed message. `src/ha/` holds the Home Assistant REST and WebSocket helpers, `src/policy/` the safety policy, `src/tools/` the tools, `docs/adr/` the recorded design decisions, and `scripts/smoke.ts` the smoke script.
