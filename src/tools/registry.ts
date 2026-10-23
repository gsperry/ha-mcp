import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../index.js";
import { haWsCommands } from "../ha/ws.js";
import { HaError, validateDomain } from "../ha/rest.js";
import { isRecord, jsonResult } from "./result.js";

/** Most rows a registry search returns. */
export const REGISTRY_CAP = 200;

type Row = Record<string, unknown>;

function asRows(label: string, value: unknown): Row[] {
  if (!Array.isArray(value)) throw new HaError(`${label}: Home Assistant returned something other than a list.`);
  return value.filter(isRecord);
}

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

export function registerRegistryTools(server: McpServer, env: Env): void {
  server.registerTool(
    "search_registry",
    {
      description:
        "Searches Home Assistant's entity registry joined to its device and area registries. Returns compact rows " +
        `{entity_id, name, platform, device_id, device, area_id, area, disabled_by, hidden_by}, sorted by entity_id and capped at ` +
        `${REGISTRY_CAP} (the reply has \`total\`, \`count\` and \`truncated\`). An entity's own area wins over its ` +
        "device's area. Use it to find real entity_ids and the exact area and device names before writing " +
        "automations or dashboards. Filter with `query` (case-insensitive substring of entity_id, name, device name " +
        "or area name), `area` (an area name or area_id), and `domain` (for example light). Disabled entities are " +
        "left out unless include_disabled is true. Only entities in the registry " +
        "appear; entities without a unique id (some YAML-defined ones) are not listed here.",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive substring matched against entity_id, name, device name and area name."),
        area: z.string().optional().describe("Only entities in this area, by area name (case-insensitive) or area_id."),
        domain: z.string().optional().describe("Only entities of this domain, for example light or sensor."),
        include_disabled: z.boolean().default(false).describe("Also return disabled entities."),
      },
      annotations: { title: "Search registry", readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, area, domain, include_disabled }) => {
      const prefix = domain === undefined ? undefined : `${validateDomain(domain)}.`;

      // One connection, three commands. A failure of any of them rejects with HA's error code and
      // message. These list commands carry no admin requirement in HA, so a failure is not
      // expected to be about permissions.
      const results = await haWsCommands(env, [
        { message: { type: "config/entity_registry/list" } },
        { message: { type: "config/device_registry/list" } },
        { message: { type: "config/area_registry/list" } },
      ]);
      const [entityResult, deviceResult, areaResult] = results;
      const entities = asRows("config/entity_registry/list", entityResult?.success ? entityResult.result : undefined);
      const devices = new Map<string, Row>();
      for (const d of asRows("config/device_registry/list", deviceResult?.success ? deviceResult.result : undefined)) {
        const id = str(d.id);
        if (id !== null) devices.set(id, d);
      }
      const areas = new Map<string, string>();
      for (const a of asRows("config/area_registry/list", areaResult?.success ? areaResult.result : undefined)) {
        const id = str(a.area_id);
        if (id !== null) areas.set(id, str(a.name) ?? id);
      }

      const needle = query?.toLowerCase();
      const wantedArea = area?.toLowerCase();

      const rows: Row[] = [];
      for (const e of entities) {
        const entityId = str(e.entity_id);
        if (entityId === null) continue;
        const disabledBy = str(e.disabled_by);
        if (disabledBy !== null && !include_disabled) continue;
        if (prefix !== undefined && !entityId.startsWith(prefix)) continue;

        const deviceId = str(e.device_id);
        const device = deviceId === null ? undefined : devices.get(deviceId);
        const deviceName = device === undefined ? null : (str(device.name_by_user) ?? str(device.name));
        const areaId = str(e.area_id) ?? (device === undefined ? null : str(device.area_id));
        const areaName = areaId === null ? null : (areas.get(areaId) ?? null);
        const name = str(e.name) ?? str(e.original_name);

        if (wantedArea !== undefined && !(areaId?.toLowerCase() === wantedArea || areaName?.toLowerCase() === wantedArea)) continue;
        if (needle !== undefined) {
          const fields = [entityId, str(e.name), str(e.original_name), deviceName, device === undefined ? null : str(device.name), areaName];
          if (!fields.some((f) => f !== null && f.toLowerCase().includes(needle))) continue;
        }

        rows.push({
          entity_id: entityId,
          name,
          platform: str(e.platform),
          device_id: deviceId,
          device: deviceName,
          area_id: areaId,
          area: areaName,
          disabled_by: disabledBy,
          hidden_by: str(e.hidden_by),
        });
      }
      rows.sort((a, b) => ((a.entity_id as string) < (b.entity_id as string) ? -1 : 1));
      const page = rows.slice(0, REGISTRY_CAP);
      return jsonResult({ total: rows.length, count: page.length, truncated: rows.length > page.length, entities: page });
    },
  );
}
