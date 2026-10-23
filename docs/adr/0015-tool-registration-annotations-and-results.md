# 0015. Tool registration, annotations and result format

Date: 2026-10-22
Status: Accepted

## Context

The original design note registered tools with `server.tool(name, description, zodShape, handler)` and returned `content: [{ type: "text", text: JSON.stringify(result, null, 2) }]`. It said nothing about tool annotations. Three facts from the SDK (1.32.1) and the protocol change that:

- `McpServer.tool` is marked deprecated in favour of `registerTool` (`fw:src/server/mcp.ts:984-990`).
- Annotations are advisory hints that clients use to decide when to ask the user. The defaults are `readOnlyHint: false` and `destructiveHint: true` (`fw:src/spec.types.ts:1203-1216`), so a tool registered without annotations is advertised as one that may destroy data, including a plain read. A client that confirms every destructive tool would then confirm every read.
- When a handler throws, the SDK returns an error result containing only the error's message (`fw:src/server/mcp.ts:271-278`, `fw:src/server/mcp.ts:290-299`). Anything the model needs to recover must be inside that message.

Pretty-printing with two-space indentation makes each result larger, and the model pays for every character it reads. Large results (entity lists, dashboards) are where this matters.

## Options considered

1. Keep `server.tool`. Rejected: deprecated, and it offers no place for annotations or a title.
2. Leave annotations off. Rejected: every tool is advertised as destructive, which removes the signal for the tools that really are.
3. Mark `call_service` and `trigger_automation` with `destructiveHint: false` because they are "just calls". Rejected, see 0007 and 0009: the protocol reads false as "additive updates only", and a service call or an automation's actions can switch things off, unlock a door or restart Home Assistant.
4. Return structured content as well as text. Rejected, see 0007: the same payload would reach the model twice and no client here reads the structured form.
5. Keep indented JSON. Rejected: larger results for no reader that needs them; a model does not need indentation.
6. Return a plain-text summary instead of JSON. Rejected: shapes such as `previous_config` are an undo that has to be sent back unchanged, and JSON is the form that survives a round trip.

## Decision

- Every tool is registered with `registerTool`, with a description and annotations, including a display title in `annotations.title`. The description says what the tool returns and when to use it, and states any trap (for example that `list_services` without a domain is long, or that `trigger_automation` checks conditions by default).
- Read tools (`list_entities`, `get_entity`, `list_services`, `get_history`, `search_registry`, `list_automations`, `get_automation`, `check_config`, `list_dashboards`, `get_dashboard`) set `readOnlyHint: true` and `openWorldHint: false`.
- `call_service` and `trigger_automation` set `readOnlyHint: false`, `destructiveHint: true` and `openWorldHint: true`: their effects reach devices beyond the server.
- `upsert_automation`, `delete_automation` and `save_dashboard` set `readOnlyHint: false`, `destructiveHint: true` and `openWorldHint: false`: they replace or remove stored data in Home Assistant and nothing beyond it.
- Handlers return one text content item holding compact JSON (`JSON.stringify(value)`, no indentation), built by `jsonResult` in `src/tools/result.ts`, except `get_dashboard` and `save_dashboard`, which assemble the same compact JSON from text they have already serialised. No tool declares an output schema or returns `structuredContent`.
- A failure is a thrown error whose message carries what the model needs: Home Assistant's status or code and text, which stage was reached for a write, and what to do next.
- A test (`test/tools/registration.test.ts`) compares `tools/list` with `TOOL_NAMES`, requires a description and an input schema on every tool, and checks the read-only and destructive hints of the read tools, `call_service`, `trigger_automation` and the dashboard tools. The hints on `upsert_automation` and `delete_automation`, including `openWorldHint`, are asserted in `test/tools/automation-writes.test.ts`. The `openWorldHint` of the other tools is not asserted by a test.

## Consequences

- Clients can tell reads from writes, and a client that asks for confirmation on destructive tools asks only for the tools that can do damage.
- Results are smaller than the original format would have produced, and harder for a person to read in a raw log. The write tools put `previous_config` or `deleted_config` first so that a result cut off at the end loses the new value before the undo (see 0010 and 0012).
- Annotations are hints. They are not enforcement; the bearer token and the administrator rights of the Home Assistant user are.
- Tool results are not validated against a schema; the shapes in each tool's ADR are the contract, held by tests.
