import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../index.js";
import { HaError, haFetch, pathSegment, validateDomain, validateService } from "../ha/rest.js";
import { checkServiceCall } from "../policy/index.js";
import { isRecord, jsonResult } from "./result.js";

function fieldRow(name: string, raw: unknown, section: string | null, details: boolean): Record<string, unknown> {
  const f = isRecord(raw) ? raw : {};
  const row: Record<string, unknown> = { name, required: f.required === true };
  if (section !== null) row.section = section;
  if (details) {
    for (const key of ["description", "example", "default", "selector"]) {
      if (f[key] !== undefined) row[key] = f[key];
    }
  }
  return row;
}

/**
 * Lists a service's fields. A key may be a field or a section that groups
 * fields (`{collapsed, fields: {...}}`); section members are flattened into the
 * list and tagged with the section name.
 */
function describeFields(fields: unknown, details: boolean): Record<string, unknown>[] {
  if (!isRecord(fields)) return [];
  const rows: Record<string, unknown>[] = [];
  for (const [name, raw] of Object.entries(fields)) {
    if (isRecord(raw) && isRecord(raw.fields) && raw.selector === undefined) {
      for (const [inner, innerRaw] of Object.entries(raw.fields)) rows.push(fieldRow(inner, innerRaw, name, details));
    } else {
      rows.push(fieldRow(name, raw, null, details));
    }
  }
  return rows;
}

/** How a service treats response data: absent key means none, `optional: false` means only. */
function responseMode(response: unknown): "none" | "optional" | "only" {
  if (!isRecord(response)) return "none";
  return response.optional === false ? "only" : "optional";
}

export function registerServiceTools(server: McpServer, env: Env): void {
  server.registerTool(
    "list_services",
    {
      description:
        "Lists the services (actions) Home Assistant offers, grouped by domain. Each service has its field names, " +
        "whether each field is required (fields inside a collapsed section are listed with a `section` tag), " +
        "`has_target` (it acts on entities, devices or areas, so pass entity_id and similar in data), and `response` " +
        "(none, optional or only: how it treats call_service's return_response). A service's `name` and `description` " +
        "are present only for the few services that define them, so most have neither. Use it to learn what " +
        "call_service can do and which fields to send. " +
        "Pass `domain` to see one domain; without it every domain is returned, which is long. " +
        "Set include_field_details to add each field's description, example, default and selector, when Home Assistant gives them.",
      inputSchema: {
        domain: z.string().optional().describe("Only this domain, for example light."),
        include_field_details: z.boolean().default(false).describe("Add description, example, default and selector to each field, when Home Assistant gives them."),
      },
      annotations: { title: "List services", readOnlyHint: true, openWorldHint: false },
    },
    async ({ domain, include_field_details }) => {
      const wanted = domain === undefined ? undefined : validateDomain(domain);
      const body = await haFetch(env, "/api/services");
      if (!Array.isArray(body)) throw new HaError("GET /api/services: Home Assistant returned something other than a list.");

      const domains = body
        .filter(isRecord)
        .filter((d) => typeof d.domain === "string" && (wanted === undefined || d.domain === wanted))
        .map((d) => ({
          domain: d.domain,
          services: Object.entries(isRecord(d.services) ? d.services : {}).map(([service, raw]) => {
            const s = isRecord(raw) ? raw : {};
            return {
              service,
              ...(typeof s.name === "string" ? { name: s.name } : {}),
              ...(typeof s.description === "string" ? { description: s.description } : {}),
              response: responseMode(s.response),
              has_target: s.target !== undefined,
              fields: describeFields(s.fields, include_field_details),
            };
          }),
        }));
      return jsonResult({ domains });
    },
  );

  server.registerTool(
    "call_service",
    {
      description:
        "Calls a Home Assistant service, which acts on the house: it can switch lights, change climate settings, " +
        "unlock doors, run scripts or trigger automations. Use list_services to find the domain, service and fields. " +
        "Target entities with `data`, for example {\"entity_id\": \"light.kitchen\"}. Returns the entities whose state " +
        "changed as {entity_id, state}; a service that changes no state, or whose effect Home Assistant runs in " +
        "another context (automation.trigger, for example, since the automation's own actions are not reported), " +
        "returns an empty list even though it did its work. Set return_response for services that produce data (such as weather forecasts); " +
        "the reply then also carries `service_response`. Home Assistant rejects return_response on services that give " +
        "no response, and requires it on services that only respond. The server refuses system actions (restart or stop " +
        "Home Assistant, purge history, backups, add-ons, shell and Python commands and others), including when a script, " +
        "scene, group or area would run one; a refusal says which rule applied and that nothing was sent.",
      inputSchema: {
        domain: z.string().describe("Service domain, for example light."),
        service: z.string().describe("Service name, for example turn_on."),
        data: z.record(z.string(), z.unknown()).optional().describe("Service data, sent to Home Assistant unchanged."),
        return_response: z.boolean().default(false).describe("Ask Home Assistant to return the service's response data."),
      },
      // The protocol reads destructiveHint false as "additive updates only". A service can turn things off,
      // unlock, restart or purge, so the hint stays at its true default, stated here on purpose.
      annotations: { title: "Call service", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ domain, service, data, return_response }) => {
      const path =
        `/api/services/${pathSegment(validateDomain(domain))}/${pathSegment(validateService(service))}` +
        (return_response ? "?return_response" : "");
      // The safety policy decides before anything that acts on the house is sent.
      await checkServiceCall(env, { domain, service, data });
      let body: unknown;
      try {
        body = await haFetch(env, path, { method: "POST", body: JSON.stringify(data ?? {}) });
      } catch (err) {
        if (err instanceof HaError && err.status === null && err.sent) {
          // The request went out and no answer came. Home Assistant shields the call from a dropped
          // connection, so it may still have run. A failure before anything was sent says nothing of the kind.
          throw new HaError(
            `${err.message} The service may still have run in Home Assistant: check the entity's state before calling it again.`,
          );
        }
        throw err;
      }

      const compact = (states: unknown): unknown[] =>
        Array.isArray(states)
          ? states.filter(isRecord).map((s) => ({ entity_id: s.entity_id, state: s.state }))
          : [];

      if (return_response) {
        if (!isRecord(body)) throw new HaError("Home Assistant returned an unexpected answer for the service call.");
        return jsonResult({ changed_states: compact(body.changed_states), service_response: body.service_response ?? null });
      }
      return jsonResult({ changed_states: compact(body) });
    },
  );
}
