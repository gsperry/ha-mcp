# 0009. Automation read, trigger and config-check tools

Date: 2026-10-22
Status: Accepted

## Context

Citations prefixed `ha:` are paths in home-assistant/core at tag 2026.10.2.

Four tools let a model inspect and exercise automations: `list_automations`, `get_automation`, `trigger_automation` and `check_config`. The facts that shape them, from Home Assistant Core 2026.10.2:

- The `automation.trigger` service defaults `skip_condition` to **true** (`ha:homeassistant/components/automation/__init__.py:270-278`). A caller who does not mention it therefore runs the actions with the conditions ignored: a test of "does the porch light turn on at night" would fire at noon.
- `GET /api/states` lists every loaded automation, whatever its source (`ha:homeassistant/components/api/__init__.py:208-236`). It has no filter or paging.
- An automation's `entity_id` is fixed from its alias only when it is first registered. Renaming it later keeps the old slug, and a taken slug gets a numeric suffix. The `id` state attribute is the key of its config and is stable. YAML automations written without an `id` have none.
- The REST config endpoint (`GET /api/config/automation/config/<id>`) serves only `automations.yaml` and answers 404 for any other id (`ha:homeassistant/components/config/view.py:85-96`). Automations from YAML packages and other sources are loaded but unreachable there. The admin WebSocket command `automation/config` takes an entity_id and returns the raw config of any loaded automation (`ha:homeassistant/components/automation/__init__.py:1252-1273`).
- `POST /api/config/core/check_config` is admin only and returns `{result, errors, warnings}`. It re-validates the YAML configuration. Errors in individual automations are swallowed by the automation validator, and storage dashboards are not checked (`ha:homeassistant/helpers/check_config.py:219-228`, `ha:homeassistant/components/automation/config.py:318-337`).
- An entity service call such as `automation.trigger` silently drops entities that do not exist (a log warning only) and entities that are unavailable (`ha:homeassistant/helpers/service.py:725-734`, `ha:homeassistant/helpers/target.py:155-158`), and the REST service view still answers 200 with an empty list. A typo or a broken automation would therefore be reported as triggered.
- The REST service view returns only state changes whose context equals the request's context (`ha:homeassistant/components/api/__init__.py:428-434`). An automation runs its actions under a new context that merely refers to the caller's (`ha:homeassistant/components/automation/__init__.py:699-702`), so the list of changed states is effectively always empty for this service. It says nothing about whether the run happened. Home Assistant also runs the actions of a disabled (off) automation when it is triggered this way.
- The SDK keeps only the message of a thrown error, so every Home Assistant failure reaches the model as the `HaError` message.

## Options considered

1. Pass `skip_condition` through, leaving Home Assistant's default of true. Rejected: the behaviour surprises anyone who expects an automation test to respect its conditions, and the tool name suggests "run this automation", not "run its actions".
2. Make `skip_condition` required. Rejected: it adds a round trip and a decision to every call, for the common case that has an obvious safe answer.
3. Map an entity to its config by slugifying the alias or stripping the `automation.` prefix. Rejected: it breaks after any rename and for suffixed slugs, and would read or later overwrite the wrong automation.
4. Make `get_automation` REST-only. Rejected: package automations are listed but could then never be read, and the model would have no way to explain one.
5. Make the WebSocket the only read path. Rejected: it needs an extra connection and handshake for every read, and the REST path serves the editable case with one request.
6. Page `list_automations` with a signed cursor. Rejected for the reason given in 0007: Home Assistant offers no cursor, and an offset over a stable sort gives the same guarantee.
7. Make `check_config` a gate that the write tools must pass. Rejected: it does not see individual automations, so passing proves nothing about a new one; the write call's own 400 response is the real validation.
8. Mark `trigger_automation` as not destructive. Rejected: the protocol defines `destructiveHint: false` as "additive updates only", and an automation's actions can switch things off or unlock a door.

## Decision

- **`skip_condition` is inverted.** `trigger_automation` takes `skip_condition` defaulting to `false` and always sends it explicitly in the request body, so omitting it means the conditions are checked. The description says so. `variables` is a loose record sent unchanged. The entity id is validated and must be in the `automation` domain. Before sending anything the tool reads the automation's state: a 404 is reported as "no such automation" (or disabled in the registry, which leaves no state) and a state of `unavailable` or `unknown` is refused, in both cases with nothing sent, because Home Assistant would otherwise answer 200 and do nothing. After the call it reads the state again and returns `{entity_id, skip_condition, state_before, last_triggered_before, last_triggered_after, note}`. It does not return changed states, for the reason above. The REST service view awaits the service call to completion under shield (`ha:homeassistant/components/api/__init__.py:443-456`), which awaits `async_trigger` (`ha:homeassistant/components/automation/__init__.py:266-270`) and so the whole action run (`:789`); `last_triggered` is set when the run starts (`ha:homeassistant/helpers/script.py:2004-2005`) and the run is awaited (`:2008`). Home Assistant therefore answers only after the run ends. An unchanged `last_triggered` after a successful call means the run did not start: the conditions were not met, it was already running in single mode or at its maximum runs (`ha:homeassistant/helpers/script.py:1926-1938`), or a condition or variables template failed (`ha:homeassistant/components/automation/__init__.py:715-721`, `:740-756`). The note says so. An automation whose actions outlast the 10 second client timeout returns the timeout error, which says it may still have run. If the read-back fails the trigger is still reported as sent, with `last_triggered_after` null. If the connection drops during the trigger call, the error says the automation may still have run.
- **`list_automations`** reads `/api/states`, keeps `automation.*`, sorts by `entity_id` and returns rows `{id, entity_id, alias, enabled, state, last_triggered}`. `id` is the `id` attribute or null; `alias` is the friendly name; `enabled` is true when the state is `on` (an unavailable automation is not enabled, and its `state` says why). `search` is a case-insensitive substring of alias or entity_id. Paging follows 0007: `limit` default 200, maximum 500, minimum 1; `offset`; the reply carries `total`, `count`, `offset` and `next_offset` (null on the last page). The description says package automations are listed but not editable.
- **`get_automation`** takes exactly one of `id` and `entity_id`. By `id` it asks the REST config endpoint directly, with the id encoded as a path segment. By `entity_id` it reads that entity's state, takes its `id` attribute, and asks the config endpoint. The result is `{id, entity_id, config, editable: true}`; `entity_id` is null when the caller read by `id` and the REST read succeeded, because no state was read. When the config endpoint answers 404, or the entity has no `id` attribute, the tool reads the config over the admin WebSocket (`automation/config`) and returns it with `editable: false`. If only an `id` was given and the config endpoint does not know it, the tool looks for a loaded automation whose `id` attribute matches, and reports that no such automation exists when there is none. Only a 404 triggers the fallback: a 401 fails at once with the credentials hint and a 403 with the address-ban message (0002), neither is retried, and neither opens a WebSocket. Every failure of the WebSocket fallback is reported as the same tool error, naming the entity and saying that reading its config over the WebSocket failed, followed by the cause: Home Assistant's error code and message, a timeout, a network error thrown by the upgrade request, or an invalid `HA_URL`. The wrapping is done in `readConfigOverWebSocket` in `src/tools/automations.ts` (lines 79-94), not in the WebSocket helper.
- **`check_config`** posts to the check endpoint and returns `{result, errors, warnings}` as Home Assistant gives them. Its description states that it validates YAML configuration only, not individual automations or dashboards.
- **Annotations.** `list_automations`, `get_automation` and `check_config` are `readOnlyHint: true`. `trigger_automation` is `readOnlyHint: false` and `destructiveHint: true`. All set `openWorldHint` (true only for the trigger).
- **Layout.** The tools live in `src/tools/automations.ts`, with the listing and config-read helpers exported so the write tools can reuse them.

## Consequences

- A trigger costs three requests (state, trigger, state) instead of one.
- A caller who wants Home Assistant's original behaviour must pass `skip_condition: true`.
- `list_automations` costs a full `/api/states` fetch per page, as `list_entities` does.
- An entity read by `entity_id` costs one extra request for its state before the config read. A package automation costs a state read, a failed config read and a WebSocket exchange.
- The fallback depends on the WebSocket reaching Home Assistant through the remote-access proxy, which the local test harness cannot show. If it fails there, `get_automation` still works for every automation in `automations.yaml`, and reports the WebSocket failure for the others.
- `check_config` cannot confirm that an automation is valid. Only the write call can.
- The fallback config is raw: it may include blueprint references or YAML-only constructs. It is returned as Home Assistant holds it.

## Amendment, 2026-10-22

The fallback used to wrap only a failure that was an `HaWsError`; a network error from the upgrade request or an invalid `HA_URL` escaped with its own text and without the entity's name. It now wraps every failure, as described in the `get_automation` entry above. The 401 and 403 wording follows the REST client change in 0002.
