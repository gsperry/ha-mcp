# 0007. Entity, service and history tools: paging, output shape, history cap

Date: 2026-10-22
Status: Accepted

## Context

Five tools expose Home Assistant's entity states, services and history, and let the model call a service. Five facts shape their design:

- `GET /api/states` returns every entity in one response, with no server-side filter or paging. A large house has well over a thousand entities, and each carries an attribute map, so returning the raw list would flood the model's context.
- `GET /api/services` returns every domain at once, and each field comes with a selector and, in many integrations, an example and a default, details the model rarely needs. Fields almost never carry a description: that text lives in translation files, which this endpoint does not return. Home Assistant has no per-domain filter on this endpoint.
- `GET /api/history/period` returns one list of states per entity, can return thousands of rows for a busy sensor, and treats the mere presence of the `minimal_response` and `no_attributes` query keys as switching them on, whatever their value. With no start time it reads one day before now; with no end time it reads one day from the start; a future start returns an empty list.
- Home Assistant takes a service's `name` and `description` only from its `services.yaml`, and almost no core integration defines them there (the text lives in translation files and is not returned). Most services therefore have neither. A service's `fields` may also hold sections, `{collapsed, fields: {...}}`, as `light.turn_on` does.
- The MCP SDK keeps only the message of a thrown error, so every Home Assistant failure reaches the model as the `HaError` message. `structuredContent`, if used, must be a JSON object, not an array.

## Options considered

1. Cursor-based paging for `list_entities`. Rejected: Home Assistant offers no cursor, so the Worker would have to invent and sign one, and a cursor over a list that changes between calls gives no stronger guarantee than an offset.
2. Require a filter instead of paging. Rejected: a model exploring an unfamiliar house often has no filter to give, and an error there only costs a round trip.
3. Return the raw Home Assistant lists. Rejected: unbounded size, mostly attributes the model did not ask for.
4. Return both text and `structuredContent`. Rejected: the same payload would be sent twice to the model for no gain, since no client here consumes the structured form. The tools return text content holding a JSON object, and declare no output schema.
5. Cap history per request in rows from the start of the window. Rejected: for "what happened recently" the newest states matter most, so the oldest are dropped instead.
6. Annotate `call_service` with `destructiveHint: false`. Rejected: the protocol defines false as "the tool performs only additive updates", and a service call can turn things off, unlock a door, restart Home Assistant or purge history. Its description also says it acts on the house.

## Decision

- **Offset paging.** `list_entities` sorts the matching entities by `entity_id` (so pages are stable between calls while the entity set is unchanged), then slices. Parameters: `limit` (default 200, maximum 500, minimum 1), `offset` (default 0). The reply carries `total` (matches before paging), `offset`, `count` (rows in this page) and `next_offset`, which is the offset of the next page or `null` on the last page. Filters are `domain` (matched as an `entity_id` prefix, validated as a domain name) and `search` (case-insensitive substring of `entity_id` or friendly name).
- **Compact shapes.** Each entity row is `{entity_id, name, state}`, where `name` is the `friendly_name` attribute or `null`; `include_attributes` adds `attributes`. `get_entity` returns `{entity_id, state, attributes, last_changed, last_updated}` and drops Home Assistant's context. `list_services` returns `{domains: [{domain, services: [{service, response, has_target, fields}]}]}`, filtered by `domain` in the Worker. `name` and `description` are included only when Home Assistant supplies them, which is rare. `response` is `none`, `optional` or `only`, from the service's `response` key (absent means none, `optional: false` means only). `has_target` is true when the service declares a target. Each field is `{name, required}`; fields inside a section are flattened into the same list with a `section` tag. `include_field_details` adds each field's `description`, `example`, `default` and `selector` when present. `call_service` returns `{changed_states: [{entity_id, state}]}`, plus `service_response` when `return_response` is set (which appends `?return_response`). The `data` object is a record of unknown values and is sent to Home Assistant unchanged.
- **History.** `get_history` takes one required `entity_id`, `start` (default 24 hours before now), `end` (default now) and booleans `minimal_response` and `no_attributes`, both true by default. Timestamps are normalised to UTC ISO 8601 before they are sent; an unparseable value is rejected locally. The two flags are sent only when true. The reply is `{entity_id, start, end, total, count, truncated, states}`. At most 500 states are returned: when Home Assistant sends more, the newest 500 are kept and `truncated` is true; `total` still reports how many it sent. Narrow the window to see the rest. The end time is always sent explicitly, so a long `start` is not silently cut to one day. With `minimal_response`, only the first state names the entity and carries attributes; if truncation drops it, its `entity_id` and `attributes` are copied onto the first state kept. The whole Home Assistant body is parsed before the cap is applied, so a long window on a busy sensor costs CPU and memory in the Worker; no maximum window is enforced.
- **Annotations.** `list_entities`, `get_entity`, `list_services` and `get_history` are `readOnlyHint: true`. `call_service` is `readOnlyHint: false` and `destructiveHint: true`. All five set `openWorldHint` (false for reads of the house's own state, true for `call_service`, whose effects reach beyond the server).
- **Errors.** A `call_service` call that was sent and got no answer (a timeout or an unreachable host) says the service may still have run, because Home Assistant shields the call from a dropped connection; the model should check state before retrying. A failure before anything was sent, such as an invalid `HA_URL`, does not say so: `HaError.sent` (0002) tells the two apart (`src/tools/services.ts`, lines 116-126). The tool description says that the returned list holds only the states that changed in the call's own context, so a service that changes nothing, or that Home Assistant runs under another context (`automation.trigger`, whose actions run in a new context: `ha:homeassistant/components/automation/__init__.py:699-702`, against the context filter at `ha:homeassistant/components/api/__init__.py:428-434`), returns an empty list although it did its work. Every tool throws on failure, so the SDK returns an error result carrying the message. Model-supplied path values go through the validators and `pathSegment` in the REST client before a URL is built, so invalid input never reaches Home Assistant.

## Consequences

- The placeholder tool that kept `tools/list` working before any real tool existed was removed when these tools were registered.
- A model can walk a house of any size in pages of at most 500 rows, at the price of one full `/api/states` fetch per page. If an entity appears or disappears between pages, a row can be skipped or repeated; the model can re-list to check.
- `list_services` without a domain is still large, because the Worker has to fetch every domain. The description says so.
- History past 500 states is not reachable in one call; the `truncated` flag and `total` tell the model to narrow the window.
- Tool replies are not machine-validated against an output schema; the shapes above are the contract, held by tests.

## Amendment, 2026-10-22

The Errors bullet and the `call_service` description were corrected. The "may still have run" sentence is now added only when the request was sent and no answer arrived, not for every failure without a status (an invalid `HA_URL` has none either, and nothing was sent). The description no longer says the call returns the changed states of every service: it says the list is empty for a service that changes no state or whose work runs in another context.
