# 0008. Registry search tool: joins, filters, cap and output shape

Date: 2026-10-22
Status: Accepted

## Context

Citations prefixed `ha:` are paths in home-assistant/core at tag 2026.10.2.

Home Assistant's registry list commands return only identifiers. An entity row carries `entity_id`, `name`, `original_name`, `platform`, `device_id`, `area_id`, `disabled_by` and `hidden_by`, but no device or area name. A device row carries `id`, `name`, `name_by_user` and `area_id`. An area row carries `area_id` and `name`. A model that writes automations needs the real entity ids and the exact area and device names, so the three lists have to be joined. The lists are only available over the WebSocket API. In Home Assistant 2026.10.2 the three list commands do not require an administrator (`ha:homeassistant/components/config/entity_registry.py:39-43`, `ha:homeassistant/components/config/device_registry.py:75-80` and `ha:homeassistant/components/config/area_registry.py:23-27` declare no admin requirement); only the commands that create, update or remove registry entries do.

Two entity list commands exist. `config/entity_registry/list` returns every entry. `config/entity_registry/list_for_display` leaves out disabled entities and abbreviates the fields.

An entity's area can come from two places: the entity's own `area_id`, or, when that is null, the `area_id` of its device. Home Assistant treats the entity's own assignment as the override.

## Options considered

1. Use `list_for_display`. Rejected: it hides disabled entities, so the tool could never find them, and its abbreviated keys differ from the full registry rows.
2. Return the raw registry rows. Rejected: they carry many fields the model does not need (labels, options, timestamps), several thousand rows in a large house, and no names.
3. Page the results with an offset. Rejected: the tool exists to narrow a large registry with filters, and paging an unfiltered registry gives the model little. A fixed cap with the total tells it to refine the filter.
4. Run the three commands on separate connections. Rejected: each connection costs a handshake and an authentication, and every authentication is a login Home Assistant counts. One connection runs the three commands one after another.

## Decision

- `search_registry` makes one WebSocket exchange with three commands, in this order: `config/entity_registry/list`, `config/device_registry/list`, `config/area_registry/list`. If any command fails, the exchange stops and the tool returns an error carrying Home Assistant's error code and message (for example `unauthorized`); nothing is retried.
- **Join.** Each entity is matched to its device by `device_id` and to an area by `area_id`. The entity's own `area_id` wins; only when it is null does the device's `area_id` apply. The area name is looked up from the area list; an unknown area id gives a null name. The device name is the device's `name_by_user` when set, otherwise its `name`.
- **Entity name.** The row's `name` is the entity's `name`, otherwise its `original_name`, otherwise null. An entity that takes the name of its device (a main-feature entity with `has_entity_name` set and both names null) therefore gets a null `name`, although Home Assistant shows it under the device name; the `device` field carries that name.
- **Filters**, all optional and combined with AND:
  - `query`: case-insensitive substring of the entity id, the entity `name`, its `original_name`, the device's `name_by_user` or `name`, or the area name.
  - `area`: matches the resolved area, by area name (case-insensitive) or by `area_id`. An entity that overrides its device's area is only in the area it overrides to.
  - `domain`: the entity id prefix before the dot, validated as a lower-case domain name.
  - `include_disabled`, default false: entities with any `disabled_by` value are left out unless it is true.
- **Output.** `{total, count, truncated, entities}`. Rows are sorted by `entity_id` and have the keys `entity_id`, `name`, `platform`, `device_id`, `device`, `area_id`, `area`, `disabled_by` and `hidden_by`. `hidden_by` is included because Home Assistant leaves hidden entities out when a service call targets an area or device (`ha:homeassistant/helpers/target.py:278-283`), so a hidden entity listed with an area is not reached by an area target. At most 200 rows are returned; `total` is the number of matches before the cap, and `truncated` is true when `total` is greater than `count`.
- The tool is annotated `readOnlyHint: true` and `openWorldHint: false`. Its description says that entities without a unique id are not in the registry.

## Consequences

- The model can find real entity ids, area names and device names in one call, and can see disabled entities when it asks.
- A large house with a broad query is cut at 200 rows. The model has to narrow with `area`, `domain` or `query`; there is no way to read past the cap.
- The tool takes the whole of all three registries into the Worker for every call, so its cost grows with the size of the house. Each registry list is one WebSocket message, so a very large house is bounded by the Worker's memory and CPU limits, which have not been measured against a real instance.
- It works only where the WebSocket connection to Home Assistant works.
