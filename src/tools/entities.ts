import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../index.js";
import { HaError, haFetch, pathSegment, validateDomain, validateEntityId } from "../ha/rest.js";
import { isRecord, jsonResult } from "./result.js";

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 500;

interface State {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

function asStates(body: unknown): State[] {
  if (!Array.isArray(body)) throw new HaError("GET /api/states: Home Assistant returned something other than a list.");
  return body.filter((s): s is State => isRecord(s) && typeof s.entity_id === "string");
}

function friendlyName(state: State): string | null {
  const name = state.attributes?.friendly_name;
  return typeof name === "string" ? name : null;
}

export function registerEntityTools(server: McpServer, env: Env): void {
  server.registerTool(
    "list_entities",
    {
      description:
        "Lists Home Assistant entities, sorted by entity_id, as compact {entity_id, name, state} rows. " +
        "Use it to find an entity_id or to survey a domain. Filter with `domain` (for example light) and `search` " +
        "(case-insensitive substring of entity_id or friendly name). Results are paged: the reply has `total`, " +
        "`count`, `offset` and `next_offset` (null on the last page); pass next_offset as `offset` for the next page. " +
        "Set include_attributes to add each entity's attributes, which makes rows much larger.",
      inputSchema: {
        domain: z.string().optional().describe("Only entities of this domain, for example light or sensor."),
        search: z.string().optional().describe("Case-insensitive substring matched against entity_id and friendly name."),
        include_attributes: z.boolean().default(false).describe("Add the attributes of every returned entity."),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe(`Page size, 1 to ${MAX_LIMIT}.`),
        offset: z.number().int().min(0).default(0).describe("Number of matching entities to skip."),
      },
      annotations: { title: "List entities", readOnlyHint: true, openWorldHint: false },
    },
    async ({ domain, search, include_attributes, limit, offset }) => {
      const prefix = domain === undefined ? undefined : `${validateDomain(domain)}.`;
      const needle = search?.trim().toLowerCase();

      const states = asStates(await haFetch(env, "/api/states"))
        .filter((s) => prefix === undefined || s.entity_id.startsWith(prefix))
        .filter(
          (s) =>
            !needle ||
            s.entity_id.toLowerCase().includes(needle) ||
            (friendlyName(s)?.toLowerCase().includes(needle) ?? false),
        )
        .sort((a, b) => (a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0));

      const page = states.slice(offset, offset + limit).map((s) => ({
        entity_id: s.entity_id,
        name: friendlyName(s),
        state: s.state,
        ...(include_attributes ? { attributes: s.attributes } : {}),
      }));
      const end = offset + page.length;
      return jsonResult({
        total: states.length,
        offset,
        count: page.length,
        next_offset: end < states.length ? end : null,
        entities: page,
      });
    },
  );

  server.registerTool(
    "get_entity",
    {
      description:
        "Returns one entity's current state, all attributes, last_changed and last_updated. " +
        "Use it when you know the entity_id (find it with list_entities) and need its full detail.",
      inputSchema: {
        entity_id: z.string().describe('Entity id in the form "domain.object_id", for example light.kitchen.'),
      },
      annotations: { title: "Get entity", readOnlyHint: true, openWorldHint: false },
    },
    async ({ entity_id }) => {
      const body = await haFetch(env, `/api/states/${pathSegment(validateEntityId(entity_id))}`);
      if (!isRecord(body)) throw new HaError("Home Assistant returned an unexpected answer for the entity.");
      const { entity_id: id, state, attributes, last_changed, last_updated } = body;
      return jsonResult({ entity_id: id, state, attributes, last_changed, last_updated });
    },
  );
}
