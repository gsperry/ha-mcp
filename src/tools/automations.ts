import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Env } from "../index.js";
import { AUTH_HINT, FORBIDDEN_HINT, HA_TIMEOUT_MS, HaError, haFetch, pathSegment, validateEntityId } from "../ha/rest.js";
import { AutomationConfig } from "../ha/schemas.js";
import { haWsCommands, HaWsError } from "../ha/ws.js";
import {
  CHALLENGE_LIFETIME_SECONDS,
  configDigest,
  drawCode,
  issueChallenge,
  normaliseCode,
  NOTIFICATION_TITLE,
  notificationMessage,
  parseChallenge,
  verifyChallenge,
} from "../policy/confirmation.js";
import { checkAutomationTrigger, checkAutomationWrite, PolicyRefusal } from "../policy/index.js";
import { allowedNotifyServices, deleteConfirmationService, systemActionsAllowed } from "../policy/settings.js";
import { DEFAULT_LIMIT, MAX_LIMIT } from "./entities.js";
import { isRecord, jsonResult } from "./result.js";

/** One automation as `/api/states` reports it. */
export interface AutomationState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

/**
 * Every automation entity, whatever its source (the UI file, YAML packages,
 * blueprints), sorted by entity_id. The list holds every loaded automation but
 * only some of them have a config the REST config endpoint can serve.
 */
export async function fetchAutomationStates(env: Env): Promise<AutomationState[]> {
  const body = await haFetch(env, "/api/states");
  if (!Array.isArray(body)) throw new HaError("GET /api/states: Home Assistant returned something other than a list.");
  return body
    .filter((s): s is AutomationState => isRecord(s) && typeof s.entity_id === "string" && s.entity_id.startsWith("automation."))
    .map((s) => ({ ...s, attributes: isRecord(s.attributes) ? s.attributes : {} }))
    .sort((a, b) => (a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0));
}

/** The `id` attribute: the key of the config in `automations.yaml`. Null for automations defined without one. */
export function automationConfigId(state: AutomationState): string | null {
  const id = state.attributes.id;
  return typeof id === "string" && id !== "" ? id : null;
}

function automationRow(state: AutomationState): Record<string, unknown> {
  const alias = state.attributes.friendly_name;
  return {
    id: automationConfigId(state),
    entity_id: state.entity_id,
    alias: typeof alias === "string" ? alias : null,
    enabled: state.state === "on",
    state: state.state,
    last_triggered: state.attributes.last_triggered ?? null,
  };
}

/** One automation's current state; a 404 becomes a plain "no such automation" error. */
async function readAutomationState(env: Env, entityId: string): Promise<AutomationState> {
  let body: unknown;
  try {
    body = await haFetch(env, `/api/states/${pathSegment(entityId)}`);
  } catch (err) {
    if (err instanceof HaError && err.status === 404) {
      throw new HaError(`No automation ${entityId} exists in Home Assistant, or it is disabled in the entity registry and so has no state (${err.message}). Nothing was sent; use list_automations to find the entity_id.`);
    }
    throw err;
  }
  if (!isRecord(body)) throw new HaError(`GET /api/states/${entityId}: unexpected answer from Home Assistant.`);
  return {
    entity_id: entityId,
    state: typeof body.state === "string" ? body.state : "unknown",
    attributes: isRecord(body.attributes) ? body.attributes : {},
  };
}

/** The stored config for a UI automation, or null when the config endpoint has no such id. */
export async function readAutomationConfig(env: Env, id: string, timeoutMs?: number): Promise<unknown | null> {
  try {
    return await haFetch(env, `/api/config/automation/config/${pathSegment(id)}`, timeoutMs === undefined ? {} : { timeoutMs });
  } catch (err) {
    if (err instanceof HaError && err.status === 404) return null;
    throw err;
  }
}

/** Reads any loaded automation's config over the admin WebSocket (read-only). */
async function readConfigOverWebSocket(env: Env, entityId: string): Promise<unknown> {
  let results;
  try {
    results = await haWsCommands(env, [{ message: { type: "automation/config", entity_id: entityId } }]);
  } catch (err) {
    // Every failure of the fallback, including a network error from the upgrade request or an invalid
    // HA_URL, is reported as the failed read it is, naming the entity.
    const reason = err instanceof Error ? err.message : String(err);
    throw new HaError(`${entityId} is not in automations.yaml, and reading its config over the WebSocket failed: ${reason}`);
  }
  const first = results[0];
  const config = first?.success === true && isRecord(first.result) ? first.result.config : undefined;
  if (config === undefined) throw new HaError(`Home Assistant returned no config for ${entityId} over the WebSocket.`);
  return config;
}

// ---------------------------------------------------------------------------------------------
// Writes: upsert_automation and delete_automation. See docs/adr/0012-automation-write-safety.md.
// ---------------------------------------------------------------------------------------------

/** The POST and the DELETE get longer than the other calls: giving up on a slow write is the dangerous case. */
const WRITE_TIMEOUT_MS = 20_000;
/** An acknowledged write must report before the client's own 60 s request limit, so the steps after it share this budget. */
const DEADLINE_MS = 55_000;
/**
 * The steps before the POST must end by this time after the call began: the budget less 20 s for the POST and 5 s for the
 * confirmation read.
 */
const PRE_WRITE_LIMIT_MS = 30_000;
/** A step is not started with less than this left of the budget. */
const MIN_STEP_MS = 1_000;
const POLL_READS = 6;
const POLL_GAP_MS = 1_000;
/** No poll read starts more than this long after the first one started, however slow the earlier reads were. */
const POLL_WINDOW_MS = 5_000;
const POLL_READ_TIMEOUT_MS = 4_000;

const WAIT_TEXT =
  "Ask the user to wait at least 30 seconds, or to confirm that nothing else is saving automations, before any further write " +
  "by this server or in the Home Assistant interface (30 seconds is a rule of thumb, not a guarantee: a slow disk write can take " +
  "longer), because an abandoned write can still be running and can overwrite a later change.";

const REWRITE_WARNING =
  "Home Assistant rewrites the whole of automations.yaml from a parsed copy on every write: hand-written comments and formatting " +
  "are lost, an entry without an id is given a random one, and tags such as !include or !secret may be written out differently.";

const UPDATE_NOTE =
  "Home Assistant reloads the automation in the background, so entity_id and state are not reported for an update; " +
  "list_automations shows the loaded state after a moment. Note that a configuration error elsewhere can stop the reload: the new " +
  "config is then stored but the old automation keeps running with the old behaviour. If the change does not take effect, run " +
  "check_config, fix what it reports, and make the call again (an unchanged config reloads once the error is gone).";

const NOT_FOUND_NOTE =
  "The automation is stored; do not create it again. Home Assistant did not show it within the polling time. Possible causes: " +
  "it is still loading; Home Assistant ignored a duplicate id; a registry entry removed earlier was restored as disabled; " +
  "a configuration error elsewhere can stop the reload (run check_config and fix what it reports); or the automations file is not " +
  "included by Home Assistant's configuration (a first deployment: the owner adds the `automation` include for automations.yaml).";

const UNCONFIRMED_NOTE =
  "The automation is stored; do not create it again. Home Assistant's state could not be confirmed (see the state_unconfirmed warning), " +
  "so entity_id and state are null. Use list_automations after a moment to see whether it loaded.";

const ID_GUARD_HINT =
  "An automation from a YAML package or another file cannot be edited through this server; omit `id` to create a new automation. " +
  "This can also be a leftover registry entry of a UI automation that was removed from automations.yaml by hand (a false positive " +
  "for a caller-supplied id): the owner removes the entry in Home Assistant (Settings, Entities).";

interface Warning {
  code: string;
  message: string;
}

/** An error whose message is already complete for the caller. */
class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

const NOTHING_CHANGED = "Nothing was changed.";

/** Maps any failure before the irreversible call to a message that says so. */
function beforeFailure(err: unknown, stage: "before_write" | "before_delete"): Error {
  if (err instanceof Refusal || err instanceof PolicyRefusal) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`${message} Stage: ${stage}. ${NOTHING_CHANGED}`);
}

/** Compact JSON text of a value Home Assistant returned. */
function compact(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

const CREDENTIAL_CODES = ["auth_invalid", "unauthorized"];

type RegistryRead = { ok: true; entries: Record<string, unknown>[] } | { ok: false; reason: string };

/**
 * One command over the WebSocket: the entity registry list. Credential failures stop the call (a Refusal);
 * any other failure is reported as unavailable, because the read changed nothing and the caller decides what that means.
 */
async function readRegistry(env: Env): Promise<RegistryRead> {
  let results;
  try {
    results = await haWsCommands(env, [{ message: { type: "config/entity_registry/list" } }]);
  } catch (err) {
    if (err instanceof HaWsError && err.code !== undefined && CREDENTIAL_CODES.includes(err.code)) {
      throw new Error(
        `${err.message} Home Assistant refused the credentials on the WebSocket although the REST call worked: the token may have ` +
          "been revoked, its user may not be an administrator, or the user may be local-only. Nothing was retried.",
      );
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const first = results[0];
  if (!first?.success || !Array.isArray(first.result)) {
    return { ok: false, reason: "Home Assistant returned something other than a list of registry entries." };
  }
  return { ok: true, entries: first.result.filter(isRecord) };
}

/** The registry entry of the automation with this config id, if any (platform automation, unique_id equal to the id). */
function findRegistryEntry(entries: Record<string, unknown>[], id: string): Record<string, unknown> | undefined {
  return entries.find(
    (e) =>
      e.platform === "automation" &&
      typeof e.entity_id === "string" &&
      e.entity_id.startsWith("automation.") &&
      e.unique_id === id,
  );
}

/** What a delete drops from the registry. `aliases` is reported only when the list carries it. */
function lostMetadata(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["entity_id", "area_id", "labels", "categories", "name", "icon", "disabled_by", "hidden_by", "options"]) {
    out[key] = entry[key] ?? null;
  }
  if ("aliases" in entry) out.aliases = entry.aliases;
  return out;
}

const REGISTRY_UNAVAILABLE = (reason: string): Warning => ({
  code: "registry_check_unavailable",
  message: `The entity registry could not be read over the WebSocket (${reason}). Nothing was retried.`,
});

/** A generated id: the time in milliseconds and six random digits, joined as text (the result exceeds 2^53, so never a number). */
function generateId(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `${Date.now()}${String(random[0]! % 1_000_000).padStart(6, "0")}`;
}

function previousClause(previous: unknown): string {
  return previous === null
    ? "There was no previous config: this id was new."
    : `Previous config (the only undo; keep it): ${compact(previous)}`;
}

function writeFailure(err: unknown, id: string, previous: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof HaError ? err.status : null;
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return new Error(
      `${message} Stage: write_in_flight, refused. Home Assistant refused the write and nothing was stored for id ${id}. ${previousClause(previous)}`,
    );
  }
  const create = previous === null;
  return new Error(
    `${message} Stage: write_in_flight, outcome unknown for id ${id}. The write may not have happened, may have happened completely, ` +
      "or may have reached automations.yaml without the reload. Nothing was repeated. " +
      `${WAIT_TEXT} Then read it with get_automation (id ${id}). If it returns the config you sent, call upsert_automation again ` +
      "with the same id and config, which is safe (it replaces the same automation and makes Home Assistant reload it). " +
      (create
        ? "If get_automation does not find it, the write did not land: create it again with the same id when the entity registry can be read " +
          "(that call is idempotent for this id), or without `id` when the call is refused with registry_check_unavailable. "
        : "If get_automation still returns the previous config, the write did not land and the same call is safe. ") +
      "Do not omit `id` before waiting and looking, because a late write would then leave two copies. " +
      `${previousClause(previous)}`,
  );
}

function acknowledgedFailure(err: unknown, id: string, previous: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(
    `${message} Stage: write_acknowledged. Home Assistant acknowledged the write for id ${id}, so the automation is probably stored; ` +
      "only reading it back failed. For a 404, another client may have deleted it or it is stored under another key. " +
      `Read it with get_automation to confirm. ${previousClause(previous)}`,
  );
}

/** Time left of the overall budget, never below the smallest step. */
function remaining(startedAt: number): number {
  return DEADLINE_MS - (Date.now() - startedAt);
}

async function pollForEntity(
  env: Env,
  id: string,
  startedAt: number,
): Promise<{ entity: AutomationState | null; warning: Warning | null }> {
  let firstStart = 0;
  for (let attempt = 0; attempt < POLL_READS; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, POLL_GAP_MS));
      if (Date.now() - firstStart > POLL_WINDOW_MS) break;
    }
    const left = remaining(startedAt);
    if (left < MIN_STEP_MS) {
      return {
        entity: null,
        warning: {
          code: "state_unconfirmed",
          message: "The time budget for this call ran out before Home Assistant's state could be read. The automation is stored.",
        },
      };
    }
    if (attempt === 0) firstStart = Date.now();
    try {
      const body = await haFetch(env, "/api/states", { timeoutMs: Math.min(POLL_READ_TIMEOUT_MS, left) });
      if (!Array.isArray(body)) throw new HaError("GET /api/states: Home Assistant returned something other than a list.");
      const hit = body.find(
        (s): s is AutomationState =>
          isRecord(s) &&
          typeof s.entity_id === "string" &&
          s.entity_id.startsWith("automation.") &&
          isRecord(s.attributes) &&
          s.attributes.id === id,
      );
      if (hit) return { entity: hit, warning: null };
    } catch (err) {
      return {
        entity: null,
        warning: {
          code: "state_unconfirmed",
          message: `Home Assistant's state could not be read after the write (${err instanceof Error ? err.message : String(err)}). The automation is stored.`,
        },
      };
    }
  }
  return { entity: null, warning: { code: "entity_not_found", message: "No automation with this id appeared in Home Assistant's states." } };
}

async function upsertAutomation(env: Env, idArg: string | undefined, config: Record<string, unknown>): Promise<CallToolResult> {
  const startedAt = Date.now();
  const warnings: Warning[] = [];
  const generated = idArg === undefined;
  let id: string;
  let body: Record<string, unknown>;
  let previous: unknown;

  try {
    // A config needs triggers and actions unless it is a blueprint automation. Home Assistant checks the rest.
    if (!isRecord(config.use_blueprint)) {
      const missing: string[] = [];
      if (!("triggers" in config) && !("trigger" in config)) missing.push("`triggers` (or `trigger`)");
      if (!("actions" in config) && !("action" in config)) missing.push("`actions` (or `action`)");
      if (missing.length > 0) {
        throw new Refusal(
          `The config needs ${missing.join(" and ")}, unless it is a blueprint automation with \`use_blueprint\`. ` +
            `Nothing was sent to Home Assistant. Stage: before_write. ${NOTHING_CHANGED}`,
        );
      }
    }

    // A body id never reaches Home Assistant, where it would override the id in the URL.
    const { id: bodyId, ...rest } = config;
    body = rest;
    id = idArg ?? generateId();
    pathSegment(id); // refuses an empty id, "." and ".." before anything is sent
    if (Object.hasOwn(config, "id") && (generated || String(bodyId) !== idArg)) {
      warnings.push({
        code: "body_id_ignored",
        message:
          `The \`id\` key inside config was removed and not sent. The automation id used is ${id}. To edit an existing automation ` +
          "pass its id as the `id` argument; omit `id` to create a new one.",
      });
    }

    // The safety policy looks at what the config would run before the first request of the existing flow.
    await checkAutomationWrite(env, body);

    // Read before write: the previous config, and whether this id is new.
    previous = await readAutomationConfig(env, id);
    if (previous !== null && generated) {
      throw new Refusal(
        `The generated id ${id} already exists. Nothing was written; call again to generate a new id. Stage: before_write. ${NOTHING_CHANGED}`,
      );
    }

    // A new id must not belong to an automation defined elsewhere.
    if (previous === null) {
      const registry = await readRegistry(env);
      if (!registry.ok) {
        if (!generated) {
          throw new Refusal(
            `registry_check_unavailable: the entity registry could not be read (${registry.reason}), and a new caller-supplied id cannot be ` +
              "checked against automations defined outside automations.yaml, so nothing was written. Omit `id` to create a new automation, " +
              "or retry when the entity registry can be read. If this id came from an earlier call whose outcome was unknown, first call " +
              "get_automation with it after waiting about 30 seconds (a rule of thumb: ask the user to wait or confirm): if the config exists, the earlier write landed and edits of that id need no " +
              `registry check; if it does not exist, the earlier write did not land and omitting \`id\` is safe. Stage: before_write. ${NOTHING_CHANGED}`,
          );
        }
        warnings.push(REGISTRY_UNAVAILABLE(registry.reason));
      } else {
        const entry = findRegistryEntry(registry.entries, id);
        if (entry) {
          throw new Refusal(
            `The id ${id} already belongs to ${String(entry.entity_id)} in the entity registry, but it is not stored in automations.yaml. ` +
              `${ID_GUARD_HINT} Nothing was sent. Stage: before_write. ${NOTHING_CHANGED}`,
          );
        }
      }
      const loaded = (await fetchAutomationStates(env)).find((s) => automationConfigId(s) === id);
      if (loaded) {
        throw new Refusal(
          `The id ${id} already belongs to the loaded automation ${loaded.entity_id}, but it is not stored in automations.yaml. ` +
            `${ID_GUARD_HINT} Nothing was sent. Stage: before_write. ${NOTHING_CHANGED}`,
        );
      }
    }
  } catch (err) {
    throw beforeFailure(err, "before_write");
  }

  // The policy check and the reads before it share the budget of the call: past this limit the confirmation could
  // no longer be reported inside the client's own time limit, so nothing is written (see the write-safety record).
  if (Date.now() - startedAt > PRE_WRITE_LIMIT_MS) {
    throw new Refusal(
      `The checks before the write took more than ${PRE_WRITE_LIMIT_MS / 1000} seconds, so the write was not made: there would not be time ` +
        `left to confirm it before the client gives up. Nothing was written. Try again. Stage: before_write. ${NOTHING_CHANGED}`,
    );
  }

  // The point of no return: every refusal above has passed.
  const path = `/api/config/automation/config/${pathSegment(id)}`;
  try {
    await haFetch(env, path, { method: "POST", body: JSON.stringify(body), timeoutMs: WRITE_TIMEOUT_MS });
  } catch (err) {
    throw writeFailure(err, id, previous);
  }

  // Confirmation: the stored config, read under Home Assistant's lock. It is what the result reports, not what was sent.
  let stored: unknown;
  try {
    stored = await readAutomationConfig(env, id, Math.min(HA_TIMEOUT_MS, Math.max(MIN_STEP_MS, remaining(startedAt))));
  } catch (err) {
    throw acknowledgedFailure(err, id, previous);
  }
  if (stored === null) {
    throw acknowledgedFailure(new HaError(`GET ${path}: Home Assistant answered 404 after the write.`, 404), id, previous);
  }

  let entityId: string | null = null;
  let state: string | null = null;
  let note: string | null = null;
  if (previous === null) {
    const { entity, warning } = await pollForEntity(env, id, startedAt);
    if (entity) {
      entityId = entity.entity_id;
      state = typeof entity.state === "string" ? entity.state : null;
      if (state === "unavailable") {
        warnings.push({
          code: "unavailable",
          message:
            "Home Assistant stored the automation but could not load it (for example a blueprint is missing). The reason is in Home Assistant's log.",
        });
      }
    } else if (warning) {
      warnings.push(warning);
      note = warning.code === "entity_not_found" ? NOT_FOUND_NOTE : UNCONFIRMED_NOTE;
    }
  } else {
    note = UPDATE_NOTE;
  }
  warnings.push({ code: "automations_file_rewritten", message: REWRITE_WARNING });

  // previous_config comes before config: a result cut off at the end loses the config first.
  return jsonResult({ id, previous_config: previous, config: stored, entity_id: entityId, state, warnings, note });
}

/** The time the notify call may take: longer than the push service's own 10 s, so that Home Assistant's answer arrives first. */
const NOTIFY_TIMEOUT_MS = 15_000;

/** A refusal of a delete that says nothing was deleted. */
function deleteRefusal(message: string): Refusal {
  return new Refusal(`${message} Nothing was deleted.`);
}

function notFoundRefusal(id: string): Refusal {
  return new Refusal(
    `No config with id ${id} is stored in automations.yaml, so it either does not exist or is defined elsewhere (a YAML package; ` +
      `see list_automations). Nothing was deleted. Stage: before_delete. ${NOTHING_CHANGED}`,
  );
}

const SETTING_REASONS = {
  absent: "is not set",
  invalid: "is not a notify service name (lower-case letters, digits and underscores, optionally after `notify.`)",
  unsupported: "names `send_message` or `persistent_notification`, which cannot deliver a code",
} as const;

const NOT_SET_UP =
  "Confirmation is not set up: tell the owner, and do not look for another way to delete. Nothing was sent to Home Assistant.";

/**
 * The checks every delete call makes first, before any request to Home Assistant: the system-action block must be on,
 * the code service must be named and usable, it must be on the allowlist the policy uses, and the key must exist.
 * Returns the name of the notify service.
 */
function confirmationSetup(env: Env): string {
  // `systemActionsAllowed` is true when ALLOW_SYSTEM_ACTIONS turns the block off: the same test the policy uses.
  if (systemActionsAllowed(env)) {
    throw deleteRefusal(
      "Deletes need the system-action block on, and ALLOW_SYSTEM_ACTIONS turns it off here, so no delete is made or confirmed. " +
        "Confirmation is not set up while the block is off: tell the owner, who turns the block back on to delete, and do not look for " +
        "another way. Nothing was sent to Home Assistant.",
    );
  }
  const service = deleteConfirmationService(env);
  if (!service.ok) {
    throw deleteRefusal(`DELETE_CONFIRMATION_NOTIFY_SERVICE ${SETTING_REASONS[service.reason]}. ${NOT_SET_UP}`);
  }
  if (!allowedNotifyServices(env).has(service.name)) {
    throw deleteRefusal(
      `DELETE_CONFIRMATION_NOTIFY_SERVICE names notify.${service.name}, but ALLOWED_NOTIFY_SERVICES is set and does not list it. ${NOT_SET_UP}`,
    );
  }
  if (env.HA_TOKEN === "") {
    throw deleteRefusal(`HA_TOKEN is empty, so a confirmation cannot be signed. ${NOT_SET_UP}`);
  }
  return service.name;
}

const NEW_CODE = "Call delete_automation again with only `id` for a new code.";
const UNUSABLE_CODE = "A code that may have arrived on the owner's phone cannot be used, because no challenge was returned.";

/** Describes a failed notify call without repeating Home Assistant's own text, which can repeat the message. */
function notifyFailure(err: unknown, service: string): Error {
  const status = err instanceof HaError ? err.status : null;
  const sent = err instanceof HaError ? err.sent : true;
  const tail = `${UNUSABLE_CODE} Nothing was deleted and nothing was retried. Tell the owner, then ask again with only \`id\` if it is still wanted.`;
  if (status === 400) {
    return new Error(
      `Home Assistant did not accept the notification request for notify.${service} (HTTP 400), so a notification may not have been ` +
        `sent: check that DELETE_CONFIRMATION_NOTIFY_SERVICE names a notify service that exists. Stage: before_delete. ${tail}`,
    );
  }
  if (status === 401) {
    return new Error(`The notification request for notify.${service} got HTTP 401. ${AUTH_HINT} Stage: before_delete. Nothing was deleted.`);
  }
  if (status === 403) {
    return new Error(`The notification request for notify.${service} got HTTP 403. ${FORBIDDEN_HINT} Stage: before_delete. Nothing was deleted.`);
  }
  if (status !== null) {
    return new Error(
      `The notification request for notify.${service} failed (HTTP ${status}), and a notification may or may not have been sent. Stage: before_delete. ${tail}`,
    );
  }
  if (!sent) {
    return new Error(`The notification request for notify.${service} was not sent. Stage: before_delete. Nothing was deleted.`);
  }
  return new Error(
    `Home Assistant gave no answer to the notification request for notify.${service}, and it finishes a call whose client has left, so a ` +
      `notification may have been sent. Stage: before_delete. ${tail}`,
  );
}

/** Call 1: reads what would be deleted, sends a one-time code to the owner's phone and returns the challenge. Deletes nothing. */
async function requestDeleteConfirmation(env: Env, id: string, service: string): Promise<CallToolResult> {
  let challenge: string;
  let message: string;
  let alias: string | null;
  let entityId: string | null;
  const expiry = Math.floor(Date.now() / 1000) + CHALLENGE_LIFETIME_SECONDS;

  try {
    pathSegment(id);
    const config = await readAutomationConfig(env, id);
    if (config === null) throw notFoundRefusal(id);
    // Informational: the entity id lets the owner see which automation this is whatever its alias says. A failed read
    // only makes the notification say so; a credential failure stops the call before anything is sent to the phone.
    const registry = await readRegistry(env);
    const entry = registry.ok ? findRegistryEntry(registry.entries, id) : undefined;
    entityId = typeof entry?.entity_id === "string" ? entry.entity_id : null;
    alias = isRecord(config) && typeof config.alias === "string" ? config.alias : null;
    const code = drawCode();
    challenge = await issueChallenge(env.HA_TOKEN, id, expiry, await configDigest(config), code);
    message = notificationMessage(id, entityId, alias, code);
  } catch (err) {
    throw beforeFailure(err, "before_delete");
  }

  try {
    await haFetch(env, `/api/services/notify/${pathSegment(service)}`, {
      method: "POST",
      body: JSON.stringify({ title: NOTIFICATION_TITLE, message }),
      timeoutMs: NOTIFY_TIMEOUT_MS,
    });
  } catch (err) {
    throw notifyFailure(err, service);
  }

  return jsonResult({
    status: "confirmation_required",
    id,
    alias,
    entity_id: entityId,
    challenge,
    expires_at: new Date(expiry * 1000).toISOString(),
    expires_in_seconds: CHALLENGE_LIFETIME_SECONDS,
    note:
      "Nothing was deleted. A one-time code was sent to the owner's phone. Tell the owner which automation you want to delete (its alias, " +
      "id and entity_id) and ask them to read you the code from the notification. Then call delete_automation again with the same `id`, " +
      "this `challenge` exactly as given and the `code` the owner told you. Never guess, invent, search for or reuse a code. If nothing " +
      "arrives within about a minute, ask the owner whether it did, and if not call again with only `id` for a new code. Ask once per " +
      "delete: reuse this challenge until it expires.",
  });
}

/** What a valid challenge and code vouch for: the digest of the config the owner was shown the code for. */
interface Approval {
  digest: string;
}

/** Call 2, first part: checks the challenge and the code locally. No request is made to Home Assistant. */
async function checkConfirmation(env: Env, id: string, challengeText: string, codeText: string): Promise<Approval> {
  const challenge = parseChallenge(challengeText);
  if (!challenge.ok) {
    throw deleteRefusal(`The challenge is not valid: ${challenge.reason}. Nothing was sent to Home Assistant. ${NEW_CODE}`);
  }
  const code = normaliseCode(codeText);
  if (!code.ok) {
    throw deleteRefusal(
      `The code is not valid: ${code.reason}. Pass the eight digits the owner read from the notification. Nothing was sent to Home Assistant.`,
    );
  }
  if (challenge.value.expiry < Math.floor(Date.now() / 1000)) {
    throw deleteRefusal(`The challenge has expired. Nothing was sent to Home Assistant. ${NEW_CODE}`);
  }
  if (!(await verifyChallenge(env.HA_TOKEN, id, challenge.value, code.value))) {
    throw deleteRefusal(
      "The code does not match: it is wrong, the challenge was altered, or the challenge was issued for another automation. " +
        `Nothing was sent to Home Assistant. ${NEW_CODE}`,
    );
  }
  return { digest: challenge.value.digest };
}

/**
 * The delete. The config read must still be the version the code was issued for. Every check that can refuse comes
 * before the DELETE, which follows the checks directly.
 */
async function deleteAutomation(env: Env, id: string, approval: Approval): Promise<CallToolResult> {
  const warnings: Warning[] = [];
  let deleted: unknown;
  let lost: Record<string, unknown> | null = null;
  let note: string | null = null;

  try {
    pathSegment(id);
    deleted = await readAutomationConfig(env, id);
    if (deleted === null) throw notFoundRefusal(id);
    if ((await configDigest(deleted)) !== approval.digest) {
      throw deleteRefusal(
        "The automation changed after the code was sent, so the owner did not approve this version. " +
          `Stage: before_delete. ${NEW_CODE}`,
      );
    }
    // Informational, not a guard: a transport failure only costs the report.
    const registry = await readRegistry(env);
    if (!registry.ok) {
      warnings.push(REGISTRY_UNAVAILABLE(registry.reason));
    } else {
      const entry = findRegistryEntry(registry.entries, id);
      if (entry) lost = lostMetadata(entry);
      else note = "The automation has no entity registry entry, so no registry metadata is lost.";
    }
  } catch (err) {
    throw beforeFailure(err, "before_delete");
  }

  const path = `/api/config/automation/config/${pathSegment(id)}`;
  try {
    await haFetch(env, path, { method: "DELETE", timeoutMs: WRITE_TIMEOUT_MS });
  } catch (err) {
    throw deleteFailure(err, id, deleted, lost);
  }

  warnings.push({ code: "automations_file_rewritten", message: REWRITE_WARNING });
  const removal =
    "Home Assistant removes the entity and its registry entry in the background after answering, so the entity may be listed for a moment. ";
  return jsonResult({
    id,
    deleted_config: deleted,
    lost_registry_metadata: lost,
    warnings,
    note: removal + (note ?? (lost === null ? "" : "Re-apply lost_registry_metadata by hand if the automation is restored.")),
  });
}

/** The two-call delete: `id` alone asks for a code, `id` with `challenge` and `code` deletes. */
async function deleteWithConfirmation(env: Env, id: string, challenge: string | undefined, code: string | undefined): Promise<CallToolResult> {
  const service = confirmationSetup(env);
  if (challenge === undefined && code === undefined) return requestDeleteConfirmation(env, id, service);
  if (challenge === undefined || code === undefined) {
    throw deleteRefusal(
      "`challenge` and `code` must be given together. To start a delete pass only `id`; to finish it pass `id`, the `challenge` and the `code`. " +
        "Nothing was sent to Home Assistant, so no new notification was started.",
    );
  }
  const approval = await checkConfirmation(env, id, challenge, code);
  return deleteAutomation(env, id, approval);
}

function deleteFailure(err: unknown, id: string, deleted: unknown, lost: Record<string, unknown> | null): Error {
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof HaError ? err.status : null;
  const kept = `Deleted config (the only undo; keep it): ${compact(deleted)} Registry metadata: ${lost === null ? "not known" : compact(lost)}.`;
  if (status === 400) {
    return new Error(`${message} Stage: delete_in_flight, refused. The entry was already gone (another client removed it between the read and the call); this call deleted nothing. ${kept}`);
  }
  if (status === 401 || status === 403 || status === 404) {
    return new Error(`${message} Stage: delete_in_flight, refused. Home Assistant refused the delete and nothing was removed for id ${id}. ${kept}`);
  }
  return new Error(
    `${message} Stage: delete_in_flight, outcome unknown for id ${id}. Nothing was repeated. ${WAIT_TEXT} Then call get_automation with id ${id}. ` +
      "If it returns the config with editable true, the delete did not happen: if it is still wanted, repeat delete_automation with the two calls " +
      "(reuse the challenge and code while the challenge has not expired, otherwise call with only `id` for a new code). " +
      "If it finds nothing at all and list_automations does not list the id, the delete completed and nothing more is needed " +
      "(restoring the deleted config is only for undoing the delete). " +
      "If it returns the config with editable false, or list_automations still lists the id, the entry is gone from automations.yaml but " +
      `Home Assistant did not finish: run call_service with automation.reload and data {"id": "${id}"} to stop the automation ` +
      "(a reload without data restarts every automation). If that call answers an error, run check_config, fix what it reports and " +
      "reload again; until then the automation keeps firing. After the reload the id may stay listed as unavailable until its registry " +
      "entry is removed: that is expected, so do not reload again. Then either remove the leftover registry entry in Home Assistant " +
      "(Settings, Entities) if the delete was wanted, or undo the delete by calling upsert_automation with the deleted config and " +
      "without `id` (a copy under a new id; a restore with the same id is refused while the registry entry remains) and re-apply the " +
      `registry metadata by hand. ${kept}`,
  );
}

export function registerAutomationTools(server: McpServer, env: Env): void {
  server.registerTool(
    "list_automations",
    {
      description:
        "Lists every automation Home Assistant has loaded, sorted by entity_id, as {id, entity_id, alias, enabled, state, last_triggered} rows. " +
        "`id` is the key of the automation's stored config (pass it to get_automation) and is null for automations defined " +
        "in YAML without an id. Automations from YAML packages are listed but are not editable through this server. " +
        "Use it to find an automation before reading or triggering it. Filter with `search` (case-insensitive substring of " +
        "alias or entity_id). Results are paged: the reply has `total`, `count`, `offset` and `next_offset` (null on the last " +
        "page); pass next_offset as `offset` for the next page.",
      inputSchema: {
        search: z.string().optional().describe("Case-insensitive substring matched against alias and entity_id."),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe(`Page size, 1 to ${MAX_LIMIT}.`),
        offset: z.number().int().min(0).default(0).describe("Number of matching automations to skip."),
      },
      annotations: { title: "List automations", readOnlyHint: true, openWorldHint: false },
    },
    async ({ search, limit, offset }) => {
      const needle = search?.trim().toLowerCase();
      const rows = (await fetchAutomationStates(env))
        .map(automationRow)
        .filter(
          (r) =>
            !needle ||
            String(r.entity_id).toLowerCase().includes(needle) ||
            (typeof r.alias === "string" && r.alias.toLowerCase().includes(needle)),
        );
      const page = rows.slice(offset, offset + limit);
      const next = offset + limit < rows.length ? offset + limit : null;
      return jsonResult({ total: rows.length, count: page.length, offset, next_offset: next, automations: page });
    },
  );

  server.registerTool(
    "get_automation",
    {
      description:
        "Returns one automation's stored config as {id, entity_id, config, editable}; entity_id is null when you read by id " +
        "and the config is found in automations.yaml (look it up with list_automations). Identify it with `id` (the config id from " +
        "list_automations) or with `entity_id`, which is resolved through the entity's `id` attribute, never through its name. " +
        "Automations stored in automations.yaml (created in the UI or through this server) return editable true. An automation " +
        "defined elsewhere, such as a YAML package, has no stored config the editor can reach: its config is then read over the " +
        "admin WebSocket and returned with editable false; it cannot be changed through this server. Use it before editing an automation.",
      inputSchema: {
        id: z.string().min(1).optional().describe("The automation's config id (the `id` field from list_automations)."),
        entity_id: z.string().optional().describe("The automation's entity_id, for example automation.porch_light."),
      },
      annotations: { title: "Get automation", readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, entity_id }) => {
      if ((id === undefined) === (entity_id === undefined)) {
        throw new HaError("Pass exactly one of `id` and `entity_id`.");
      }

      let entityId: string | null = null;
      let configId: string | null = id ?? null;

      if (entity_id !== undefined) {
        entityId = validateEntityId(entity_id);
        if (!entityId.startsWith("automation.")) throw new HaError(`${entityId} is not an automation entity.`);
        const state = await haFetch(env, `/api/states/${pathSegment(entityId)}`);
        if (!isRecord(state)) throw new HaError(`GET /api/states/${entityId}: unexpected answer from Home Assistant.`);
        configId = automationConfigId({ entity_id: entityId, state: "", attributes: isRecord(state.attributes) ? state.attributes : {} });
      }

      if (configId !== null) {
        const config = await readAutomationConfig(env, configId);
        if (config !== null) return jsonResult({ id: configId, entity_id: entityId, config, editable: true });
      }

      // No stored config: either the entity has no id, or the config endpoint does not know it
      // (the automation comes from a YAML package or another file). Find the entity for the WebSocket read.
      if (entityId === null) {
        const match = (await fetchAutomationStates(env)).find((s) => automationConfigId(s) === configId);
        if (!match) {
          throw new HaError(`No automation with id ${JSON.stringify(configId)} is stored or loaded in Home Assistant.`);
        }
        entityId = match.entity_id;
      }
      const config = await readConfigOverWebSocket(env, entityId);
      return jsonResult({ id: configId, entity_id: entityId, config, editable: false });
    },
  );

  server.registerTool(
    "trigger_automation",
    {
      description:
        "Runs an automation's actions now, which acts on the house (lights, locks, climate and so on). By default the " +
        "automation's conditions are CHECKED, so it does nothing when they are not met: skip_condition is false unless you " +
        "set it to true. Set skip_condition true only when the user wants the actions to run whatever the conditions say. " +
        "A disabled (off) automation's actions still run when triggered this way. The automation must exist and be loaded: " +
        "an unknown or unavailable one is refused before anything is sent. `variables` are made available to the automation's templates. " +
        "Returns {entity_id, skip_condition, state_before, last_triggered_before, last_triggered_after, note}. Home Assistant " +
        "does not report what the actions changed, so compare last_triggered_before and last_triggered_after to see whether the " +
        "run started. Home Assistant answers only after the run has finished, so an unchanged last_triggered means the run did NOT start " +
        "(conditions not met, already running in single mode or at its maximum runs, or a condition or variables template error). " +
        "An automation whose actions take longer than 10 seconds returns a timeout error that says it may still have run. " +
        "Use list_automations to find the entity_id. The server first reads the automation's actions and refuses to trigger one " +
        "that would run a system action or something it cannot check; a refusal says why and that nothing was triggered.",
      inputSchema: {
        entity_id: z.string().describe("The automation, for example automation.porch_light."),
        skip_condition: z.boolean().default(false).describe("Run the actions without checking the conditions. Default false."),
        variables: z.record(z.string(), z.unknown()).optional().describe("Variables passed to the automation, sent to Home Assistant unchanged."),
      },
      // The actions can do anything a service call can, so the hint stays at its true default, stated on purpose.
      annotations: { title: "Trigger automation", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ entity_id, skip_condition, variables }) => {
      const entityId = validateEntityId(entity_id);
      if (!entityId.startsWith("automation.")) throw new HaError(`${entityId} is not an automation entity.`);
      // Home Assistant drops a missing or unavailable entity from an entity service call without an error
      // and still answers 200, so look the automation up first.
      const before = await readAutomationState(env, entityId);
      // "unknown" is defensive: a loaded automation is always on or off (entity.py:1073-1074 with automation/__init__.py:534-536).
      if (before.state === "unavailable" || before.state === "unknown") {
        throw new HaError(
          `${entityId} is ${before.state} in Home Assistant (its config failed to load or it is not ready), so triggering it would do nothing. Nothing was sent.`,
        );
      }

      // The safety policy reads the automation's config and walks it before it is triggered.
      await checkAutomationTrigger(env, entityId);

      // Home Assistant's own default is true. Always send the value so the omitted case means "check conditions".
      const payload: Record<string, unknown> = { entity_id: entityId, skip_condition };
      if (variables !== undefined) payload.variables = variables;

      try {
        await haFetch(env, "/api/services/automation/trigger", { method: "POST", body: JSON.stringify(payload) });
      } catch (err) {
        if (err instanceof HaError && err.status === null) {
          throw new HaError(
            `${err.message} The automation may still have run in Home Assistant: check its last_triggered before triggering it again.`,
          );
        }
        throw err;
      }

      // Home Assistant answers after the run ends, so an unchanged value means the run did not start.
      let after: AutomationState | null = null;
      try {
        after = await readAutomationState(env, entityId);
      } catch {
        // The trigger was sent; failing to read back must not report it as failed.
      }
      return jsonResult({
        entity_id: entityId,
        skip_condition,
        state_before: before.state,
        last_triggered_before: before.attributes.last_triggered ?? null,
        last_triggered_after: after ? (after.attributes.last_triggered ?? null) : null,
        note: after
          ? "The trigger was sent and Home Assistant answered after the run finished. If last_triggered_after equals " +
            "last_triggered_before, the run did not start: the conditions were not met, it was already running in single " +
            "mode or at its maximum runs, or a condition or variables template failed."
          : "The trigger was sent, but the automation's state could not be read back.",
      });
    },
  );

  server.registerTool(
    "check_config",
    {
      description:
        "Asks Home Assistant to validate its YAML configuration files and returns {result, errors, warnings}, where result is " +
        "valid or invalid and errors and warnings are text or null. It checks YAML configuration only: it does not validate an " +
        "individual automation (save errors come back when the automation is written) and does not check dashboards. " +
        "Use it to diagnose a configuration problem or before asking the user to restart Home Assistant. It changes nothing.",
      inputSchema: {},
      annotations: { title: "Check configuration", readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const body = await haFetch(env, "/api/config/core/check_config", { method: "POST", body: "{}" });
      if (!isRecord(body)) throw new HaError("POST /api/config/core/check_config: unexpected answer from Home Assistant.");
      return jsonResult({ result: body.result ?? null, errors: body.errors ?? null, warnings: body.warnings ?? null });
    },
  );

  server.registerTool(
    "upsert_automation",
    {
      description:
        "Creates a new automation or REPLACES an existing one in Home Assistant, which acts on the house at once. Send the full config " +
        "as get_automation returned it (variables, max, trace, trigger_variables and every other key included): the whole stored " +
        "automation is replaced, so a missing key is deleted. A blueprint automation is sent as `use_blueprint` ({path, input}) with no " +
        "triggers or actions. Pass `id` only to edit an existing automation stored in automations.yaml; omit `id` to create a new " +
        "automation (an id is generated). An `id` key inside `config` is ignored with a warning. Automations from YAML packages or other " +
        "files cannot be edited through this server, and a new id that belongs to one is refused. Run get_automation first and keep " +
        "your own copy until the write is confirmed. Returns compact JSON with `id`, `previous_config` (null for a create), `config` " +
        "(the stored config, read back), `entity_id` and `state` (a create only; null for an update, whose reload is in the " +
        "background), `warnings` and `note`. Undo an update by calling this again with the same `id` and `previous_config`; undo a " +
        "create with delete_automation (two calls; the owner reads you a code; needs the system-action block on). Last write wins: a person editing the same automation in Home Assistant can be overwritten, " +
        "and the earlier version is in previous_config. Home Assistant rewrites the whole of automations.yaml, which drops " +
        "hand-written comments. The server refuses a config whose actions would run a system action or something it cannot check, " +
        "and one that waits for the call_service event; a refusal says why and that nothing was written. An error says how far the call got; if the outcome is unknown, wait, read the automation with " +
        "get_automation, and then call this again with the same `id` and config if it is safe. Nothing is retried automatically.",
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe("The id of an existing automation stored in automations.yaml, to edit it. Omit to create a new automation."),
        config: AutomationConfig,
      },
      annotations: { title: "Create or replace an automation", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ id, config }) => upsertAutomation(env, id, config),
  );

  server.registerTool(
    "delete_automation",
    {
      description:
        "Deletes one automation stored in automations.yaml, in two calls that need the owner's phone. Call 1: pass only `id`. Nothing is " +
        "deleted. The server sends a one-time 8-digit code to the owner's phone as a Home Assistant notification and returns " +
        '{status: "confirmation_required", id, alias, entity_id, challenge, expires_at}; you are never shown the code. Tell the owner ' +
        "which automation you want to delete (its alias, id and entity_id), then ask them to read you the code from the notification on " +
        "their phone. Never guess, invent, search for or reuse a code. Call 2: pass the same `id`, the `challenge` exactly as returned, and " +
        "the `code` the owner told you; it returns {id, deleted_config, lost_registry_metadata, warnings, note}. A wrong code, an expired " +
        "or altered challenge, a challenge for another id, or an automation that changed after the code was sent is refused and nothing is " +
        "deleted; call again with only `id` for a new code (about five minutes of life). Ask once per delete and reuse the challenge until " +
        "it expires. If an error says confirmation is not set up, tell the owner; do not look for another way. " +
        "`deleted_config` is the config exactly as it was stored: pass it to upsert_automation with the same id to undo. A delete " +
        "also removes the automation's entity registry entry: its area, labels, categories, name, voice-assistant options, aliases " +
        "and custom entity id are lost, and `lost_registry_metadata` lists what to re-apply by hand. Home Assistant keeps the removed " +
        "registry entry for 30 days and restores it if an automation with the same id is created again; this server does not rely on " +
        "or promise that. Automations from YAML packages cannot be deleted through this server. Use list_automations to find the " +
        "id. An error says how far the call got and nothing is retried.",
      inputSchema: {
        id: z.string().describe("The config id of the automation to delete (the `id` from list_automations)."),
        challenge: z
          .string()
          .optional()
          .describe("Call 2 only: the `challenge` text exactly as call 1 returned it. Give it together with `code`."),
        code: z
          .string()
          .optional()
          .describe("Call 2 only: the 8-digit code the owner read from the notification on their phone. Never guess it. Give it together with `challenge`."),
      },
      annotations: { title: "Delete an automation", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ id, challenge, code }) => deleteWithConfirmation(env, id, challenge, code),
  );
}
