import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../index.js";
import { HaError, haFetch, pathSegment, validateEntityId } from "../ha/rest.js";
import { isRecord, jsonResult } from "./result.js";

/** Most states a history reply carries. The newest are kept. */
export const HISTORY_CAP = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

function toIso(label: string, value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new HaError(`Invalid ${label} ${JSON.stringify(value)}: expected an ISO 8601 timestamp.`);
  return new Date(ms).toISOString();
}

export function registerHistoryTools(server: McpServer, env: Env): void {
  server.registerTool(
    "get_history",
    {
      description:
        `Returns the recorded state changes of one entity over a time window, oldest first, capped at ${HISTORY_CAP} ` +
        "states (when there are more, the newest are kept and `truncated` is true). Use it to see what an entity did " +
        "and when. `start` defaults to 24 hours ago; `end` defaults to now. Attributes are left out by default; " +
        "set no_attributes to false to include them, and minimal_response to false for full state objects. " +
        "Only changes Home Assistant records as significant are included.",
      inputSchema: {
        entity_id: z.string().describe('Entity id, for example sensor.outdoor_temperature.'),
        start: z.string().optional().describe("ISO 8601 start time. Default: 24 hours ago."),
        end: z.string().optional().describe("ISO 8601 end time. Default: now."),
        minimal_response: z.boolean().default(true).describe("Only state and timestamps for each change after the first."),
        no_attributes: z.boolean().default(true).describe("Leave attributes out."),
      },
      annotations: { title: "Get history", readOnlyHint: true, openWorldHint: false },
    },
    async ({ entity_id, start, end, minimal_response, no_attributes }) => {
      const id = validateEntityId(entity_id);
      const now = Date.now();
      const startIso = start === undefined ? new Date(now - DAY_MS).toISOString() : toIso("start", start);
      const endIso = end === undefined ? new Date(now).toISOString() : toIso("end", end);

      // Home Assistant treats the presence of these two keys as the switch, whatever their value.
      const query = new URLSearchParams({ filter_entity_id: id, end_time: endIso });
      if (minimal_response) query.set("minimal_response", "");
      if (no_attributes) query.set("no_attributes", "");

      const body = await haFetch(env, `/api/history/period/${pathSegment(startIso)}?${query.toString()}`);
      if (!Array.isArray(body)) throw new HaError("Home Assistant returned something other than a list of histories.");
      const first: unknown = body[0];
      const all = Array.isArray(first) ? first : [];
      let states = all.length > HISTORY_CAP ? all.slice(all.length - HISTORY_CAP) : all;
      // With minimal_response only the first state names the entity and carries attributes. If truncation
      // dropped it, carry its identity onto the first state that is kept.
      const head: unknown = all[0];
      if (states !== all && isRecord(head) && isRecord(states[0]) && states[0].entity_id === undefined) {
        const { entity_id: headId, attributes } = head;
        states = [{ ...(states[0] as Record<string, unknown>), entity_id: headId ?? id, ...(attributes !== undefined ? { attributes } : {}) }, ...states.slice(1)];
      }

      return jsonResult({
        entity_id: id,
        start: startIso,
        end: endIso,
        total: all.length,
        count: states.length,
        truncated: all.length > HISTORY_CAP,
        states,
      });
    },
  );
}
