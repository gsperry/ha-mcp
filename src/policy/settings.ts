import type { Env } from "../index";
import { pyStrip } from "./python";

/** Only the exact text `true` turns the system-action block off; anything else, an empty value included, leaves it on. */
export function systemActionsAllowed(env: Pick<Env, "ALLOW_SYSTEM_ACTIONS">): boolean {
  return env.ALLOW_SYSTEM_ACTIONS === "true";
}

/** `notify.<name>` or `<name>`, trimmed and lower-cased, to the bare service name. */
function normaliseNotifyName(entry: string): string {
  const name = pyStrip(entry).toLowerCase();
  return name.startsWith("notify.") ? name.slice("notify.".length) : name;
}

/** Why `DELETE_CONFIRMATION_NOTIFY_SERVICE` names no usable service. */
export type ConfirmationServiceProblem = "absent" | "invalid" | "unsupported";

export type ConfirmationService = { ok: true; name: string } | { ok: false; reason: ConfirmationServiceProblem };

/**
 * Services of the notify domain that cannot deliver a delete code: `send_message` is an entity service with no
 * per-device name, and `persistent_notification` can be observed by a trigger the capture rule does not examine.
 */
const UNSUPPORTED_CONFIRMATION_SERVICES: ReadonlySet<string> = new Set(["send_message", "persistent_notification"]);

/**
 * The notify service that delivers delete confirmation codes, written `notify.<name>` or `<name>`. A blank or absent
 * setting is `absent`; a name that is not lower-case letters, digits and underscores is `invalid`; `send_message` and
 * `persistent_notification` are `unsupported`.
 */
export function deleteConfirmationService(env: Pick<Env, "DELETE_CONFIRMATION_NOTIFY_SERVICE">): ConfirmationService {
  const raw = env.DELETE_CONFIRMATION_NOTIFY_SERVICE;
  const name = typeof raw === "string" ? normaliseNotifyName(raw) : "";
  if (name === "") return { ok: false, reason: "absent" };
  if (!/^[a-z0-9_]+$/.test(name)) return { ok: false, reason: "invalid" };
  if (UNSUPPORTED_CONFIRMATION_SERVICES.has(name)) return { ok: false, reason: "unsupported" };
  return { ok: true, name };
}

/**
 * The legacy notify services the model may call. When `ALLOWED_NOTIFY_SERVICES` is set, even to an empty text, it
 * is the whole list. When it is absent the list is the notify service that delivers delete confirmation codes
 * (`DELETE_CONFIRMATION_NOTIFY_SERVICE`) when that names a usable service, and empty otherwise.
 */
export function allowedNotifyServices(
  env: Pick<Env, "ALLOWED_NOTIFY_SERVICES" | "DELETE_CONFIRMATION_NOTIFY_SERVICE">,
): ReadonlySet<string> {
  const raw = env.ALLOWED_NOTIFY_SERVICES;
  if (typeof raw !== "string") return new Set(defaultNotifyServices(env));
  return new Set(
    raw
      .split(",")
      .map(normaliseNotifyName)
      .filter((name) => name !== ""),
  );
}

/** The default allowlist: the delete-confirmation notify service when it is usable, so a typo is never allowlisted. */
function defaultNotifyServices(env: Pick<Env, "DELETE_CONFIRMATION_NOTIFY_SERVICE">): string[] {
  const service = deleteConfirmationService(env);
  return service.ok ? [service.name] : [];
}
