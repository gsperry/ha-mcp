import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Env } from "../index.js";
import { HaWsError, haWsCommands, type HaWsCommand, type HaWsResult } from "../ha/ws.js";
import { isRecord, jsonResult } from "./result.js";

const LIST_NOTE =
  "The default dashboard is listed only once it has a stored config. Omit url_path to address the default dashboard, " +
  "whether or not it appears here.";

const URL_PATH_HELP =
  "The dashboard's url_path as listed by list_dashboards. Omit it (or pass null) for the default dashboard.";

/** What `get_dashboard` says when Home Assistant has no config to give. */
const NOT_FOUND_CAUSES =
  "Home Assistant answered config_not_found. Possible causes: the dashboard path does not exist (see list_dashboards); " +
  "the dashboard has no stored config yet (never saved, so it is auto-generated); its YAML file is missing; " +
  "its stored file was set aside by Home Assistant as corrupt; or Home Assistant is in recovery mode.";

/** Home Assistant's own text for an unknown dashboard; a stored-nothing dashboard says "No config found." instead. */
const UNKNOWN_CONFIG_PREFIX = "Unknown config specified";

const PREVIOUS_NULL_NOTE =
  "Home Assistant reported no stored config for this dashboard before the save. Either it was never saved (it was " +
  "auto-generated), or its stored file was missing or was set aside by Home Assistant as corrupt (the original is then " +
  "in a .corrupt. file in Home Assistant's storage folder, and Home Assistant logs an error). No tool restores the " +
  "earlier state: the dashboard is now fixed to the saved config.";

const DIFFERENT_NOTE =
  "The config read back after the save is not identical to the config that was sent (compared as compact JSON text). " +
  "Another change may have landed between the save and the read, or Home Assistant stored it differently. Compare " +
  "`config` with what you sent.";

/** A refusal raised before anything was changed. Its message is for the caller. */
class DashboardRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardRefusal";
  }
}

type Stage = "before_save" | "save_in_flight" | "saved";

interface Progress {
  stage: Stage;
  /** Compact JSON of the config stored before the save; "null" when none was stored. Undefined until read. */
  previousText: string | undefined;
}

/** Why a config is not a dashboard, or null when it is one. Applies the same rule as the input schema. */
function configProblem(config: unknown): string | null {
  const need = "A dashboard config must be an object with a `views` array of objects, or a `strategy` object, or both.";
  if (!isRecord(config)) return `${need} Got something that is not an object.`;
  const { views, strategy } = config;
  if (views === undefined && strategy === undefined) return `${need} Got neither key.`;
  if (views !== undefined && !(Array.isArray(views) && views.every(isRecord))) {
    return `${need} \`views\` must be an array of objects.`;
  }
  if (strategy !== undefined && !isRecord(strategy)) return `${need} \`strategy\` must be an object.`;
  return null;
}

/** Compact JSON text of a value Home Assistant returned; a missing value reads as null. */
function textOf(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

/**
 * Picks the dashboard the way Home Assistant does and refuses one that cannot be
 * written. A null path means the `lovelace` item if listed, else the storage
 * default, which is never listed and is always storage.
 */
function checkTarget(list: HaWsResult, urlPath: string | null): void {
  if (!list.success) throw new DashboardRefusal("Home Assistant could not list the dashboards.");
  const items = list.result;
  if (!Array.isArray(items) || !items.every(isRecord)) {
    throw new DashboardRefusal("Home Assistant returned an unexpected dashboard list, so the target could not be checked.");
  }
  const wanted = urlPath ?? "lovelace";
  const item = items.find((i) => i.url_path === wanted);
  if (item === undefined) {
    if (urlPath === null) return; // the storage default
    const paths = items.map((i) => i.url_path).filter((p): p is string => typeof p === "string");
    throw new DashboardRefusal(
      `Unknown dashboard ${JSON.stringify(urlPath)}. Available url_path values: ${paths.length ? paths.map((p) => JSON.stringify(p)).join(", ") : "none listed"}. ` +
        "The default dashboard is addressed by omitting url_path.",
    );
  }
  if (item.mode !== "storage") {
    throw new DashboardRefusal(
      `The dashboard ${urlPath === null ? "that an omitted url_path resolves to (\"lovelace\")" : JSON.stringify(urlPath)} ` +
        `is defined in a file (mode ${JSON.stringify(item.mode ?? null)}) and cannot be saved through Home Assistant. Edit the file instead.`,
    );
  }
}

/** Builds the error text for a failure, saying how far the call got. */
function failureText(error: unknown, progress: Progress): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof HaWsError ? error.code : undefined;
  const previous =
    progress.previousText === undefined
      ? ""
      : progress.previousText === "null"
        ? " No config was stored for this dashboard before the save."
        : ` Previous config (the only undo; keep it): ${progress.previousText}`;

  if (progress.stage === "before_save") {
    const hint =
      code === "unknown_command"
        ? " The dashboard commands are unavailable: Home Assistant may be in recovery mode."
        : "";
    return `${message}${hint} Stage: before_save. Nothing was changed: no save was sent.`;
  }
  if (progress.stage === "save_in_flight") {
    if (code === "unauthorized" || code === "config_not_found") {
      return `${message} Stage: save_in_flight. Home Assistant refused the save and nothing was changed.${previous}`;
    }
    if (code !== undefined) {
      return (
        `${message} Stage: save_in_flight. Home Assistant answered the save with an error, so whether it was applied is not known. ` +
        `Read the dashboard with get_dashboard before doing anything else.${previous}`
      );
    }
    return (
      `${message} Stage: save_in_flight. The connection failed or timed out after the previous config was read, so whether ` +
      "the save was applied is unknown. Home Assistant does not cancel a save that reached it. " +
      `Read the dashboard with get_dashboard before doing anything else.${previous}`
    );
  }
  return (
    `${message} Stage: saved. Home Assistant acknowledged the save, so the dashboard probably holds the new config; ` +
    `only reading it back failed. Read it with get_dashboard to confirm.${previous}`
  );
}

export function registerDashboardTools(server: McpServer, env: Env): void {
  server.registerTool(
    "list_dashboards",
    {
      description:
        "Lists the Home Assistant dashboards as Home Assistant returns them: id, url_path, title, icon, mode " +
        "(storage dashboards can be saved with save_dashboard; yaml dashboards are defined in files and cannot) and " +
        "show_in_sidebar. The default dashboard appears only once it has a stored config; address it by omitting url_path. " +
        "Use it to find a url_path before get_dashboard or save_dashboard.",
      inputSchema: {},
      annotations: { title: "List dashboards", readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const [list] = await haWsCommands(env, [{ message: { type: "lovelace/dashboards/list" } }]);
      const items = list?.success ? list.result : undefined;
      if (!Array.isArray(items)) throw new Error("Home Assistant returned something other than a list of dashboards.");
      return jsonResult({ dashboards: items, note: LIST_NOTE });
    },
  );

  server.registerTool(
    "get_dashboard",
    {
      description:
        "Returns one dashboard's stored config exactly as Home Assistant holds it: a `views` array, a `strategy` object, or " +
        "both. Use it before save_dashboard, which replaces the whole config, and keep the copy until a save is confirmed. " +
        "A dashboard that was never saved has no stored config and is reported as not found. Omit url_path for the default dashboard.",
      inputSchema: { url_path: z.string().nullable().optional().describe(URL_PATH_HELP) },
      annotations: { title: "Get dashboard", readOnlyHint: true, openWorldHint: false },
    },
    async ({ url_path }) => {
      const [read] = await haWsCommands(env, [
        {
          message: { type: "lovelace/config", ...(url_path == null ? {} : { url_path }) },
          allowErrorCodes: ["config_not_found"],
        },
      ]);
      if (!read?.success) throw new Error(NOT_FOUND_CAUSES);
      return { content: [{ type: "text", text: textOf(read.result) }] };
    },
  );

  server.registerTool(
    "save_dashboard",
    {
      description:
        "Replaces a storage dashboard's whole config with `config` (a `views` array, a `strategy` object, or both; send every " +
        "view and card to keep, with every key as get_dashboard returned it). The change is live at once and Home Assistant " +
        "keeps no history. Run get_dashboard first, edit that copy, and never rebuild a config from a read that looks truncated: " +
        "a truncated copy that still has a `views` array is accepted and would drop views. Returns compact JSON with " +
        "`previous_config` (what was stored just before; save it again to undo, and null if nothing was stored), then `config` " +
        "(read back after the save), and `notes` when there is something to know. Omit url_path for the default dashboard. " +
        "YAML dashboards, unknown dashboards and configs with neither views nor strategy are refused before anything is sent. " +
        "Last write wins: a person editing the dashboard in Home Assistant can be overwritten, and the earlier version is in " +
        "previous_config. A dashboard that was auto-generated cannot be returned to that state by any tool. Keep your own " +
        "get_dashboard copy until the save is confirmed, and treat a missing result as possibly applied: read the dashboard to " +
        "find out. A config larger than about 4 MiB is refused by the server before it runs; split such a dashboard or edit it " +
        "in Home Assistant.",
      inputSchema: {
        url_path: z.string().nullable().optional().describe(URL_PATH_HELP),
        config: z
          .looseObject({
            views: z.array(z.looseObject({})).optional().describe("The dashboard's views, each an object, with every key kept."),
            strategy: z.record(z.string(), z.unknown()).optional().describe("A strategy object, for a generated dashboard."),
          })
          .describe("The complete new config. Unknown keys at every level are sent to Home Assistant unchanged."),
      },
      annotations: { title: "Save dashboard", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ url_path, config }): Promise<CallToolResult> => {
      const problem = configProblem(config);
      if (problem !== null) throw new Error(`${problem} Nothing was sent to Home Assistant.`);

      const path = url_path ?? null;
      const target = path === null ? {} : { url_path: path };
      const progress: Progress = { stage: "before_save", previousText: undefined };
      // Compared with the read-back config, as text, after the save.
      const sentText = textOf(config);

      const commands: HaWsCommand[] = [
        {
          message: { type: "lovelace/dashboards/list" },
          check: (result) => checkTarget(result, path),
        },
        {
          message: { type: "lovelace/config", ...target },
          allowErrorCodes: ["config_not_found"],
          check: (result) => {
            if (!result.success) {
              if (path !== null && result.error.message.startsWith(UNKNOWN_CONFIG_PREFIX)) {
                throw new DashboardRefusal(
                  `Unknown dashboard ${JSON.stringify(path)}: it no longer exists. The default dashboard is addressed by omitting url_path.`,
                );
              }
              progress.previousText = "null";
            } else {
              // Serialised here, before the save, so the cost is not paid afterwards.
              progress.previousText = textOf(result.result);
            }
            progress.stage = "save_in_flight";
          },
        },
        {
          message: { type: "lovelace/config/save", ...target, config },
          check: () => {
            progress.stage = "saved";
          },
        },
        { message: { type: "lovelace/config", ...target } },
      ];

      let results: HaWsResult[];
      try {
        results = await haWsCommands(env, commands);
      } catch (error) {
        throw new Error(failureText(error, progress));
      }

      const readBack = results[3];
      const currentText = textOf(readBack?.success ? readBack.result : null);
      const notes: string[] = [];
      if (progress.previousText === "null") notes.push(PREVIOUS_NULL_NOTE);
      if (currentText !== sentText) notes.push(DIFFERENT_NOTE);

      // Built from the texts already made, so nothing is serialised twice. previous_config first: a result
      // cut off at the end loses `config` before it loses the undo.
      const text =
        `{"previous_config":${progress.previousText ?? "null"},"config":${currentText}` +
        (notes.length > 0 ? `,"notes":${JSON.stringify(notes)}` : "") +
        "}";
      return { content: [{ type: "text", text }] };
    },
  );
}
