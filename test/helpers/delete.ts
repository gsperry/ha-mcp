import type { Env } from "../../src/index";
import type { FetchSpy } from "./fetch";
import { callToolWithEnv, type ToolReply } from "./mcp";

/** The settings that make deletes work: a phone service for the codes. */
export const CONFIRM_SETTINGS: Partial<Env> = { DELETE_CONFIRMATION_NOTIFY_SERVICE: "notify.mobile_app_phone" };

export interface SentNotification {
  path: string;
  title: string;
  message: string;
}

/** Every notify request the Worker sent, in order, with its decoded body. */
export async function sentNotifications(spy: FetchSpy): Promise<SentNotification[]> {
  const out: SentNotification[] = [];
  for (const request of spy.requests) {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !path.startsWith("/api/services/notify/")) continue;
    const body = JSON.parse(await request.clone().text()) as { title: string; message: string };
    out.push({ path, title: body.title, message: body.message });
  }
  return out;
}

/** The eight digits in a notification message ("Confirmation code: 1234 5678"). */
export function codeIn(message: string): string {
  const match = /Confirmation code: (\d{4}) (\d{4})\./.exec(message);
  if (!match) throw new Error(`No code in the notification: ${message}`);
  return `${match[1]}${match[2]}`;
}

/** The code of the most recent notification. */
export async function lastCode(spy: FetchSpy): Promise<string> {
  const all = await sentNotifications(spy);
  const last = all[all.length - 1];
  if (!last) throw new Error("No notification was sent.");
  return codeIn(last.message);
}

/** Call 1 of a delete. */
export async function requestDelete(id: string, settings: Partial<Env> = CONFIRM_SETTINGS): Promise<ToolReply> {
  return callToolWithEnv(settings, "delete_automation", { id });
}

/** Call 2 of a delete. */
export async function finishDelete(id: string, challenge: string, code: string, settings: Partial<Env> = CONFIRM_SETTINGS): Promise<ToolReply> {
  return callToolWithEnv(settings, "delete_automation", { id, challenge, code });
}

/**
 * Both calls, as the model makes them: call 1, the code read from the phone, call 2. `between` runs after call 1 and
 * before call 2 (a test clears its request log there). Returns both replies; `second` is undefined when call 1 failed.
 */
export async function deleteInTwoCalls(
  spy: FetchSpy,
  id: string,
  options: { settings?: Partial<Env>; between?: () => void } = {},
): Promise<{ first: ToolReply; second: ToolReply | undefined; challenge: string | undefined; code: string | undefined }> {
  const settings = options.settings ?? CONFIRM_SETTINGS;
  const first = await requestDelete(id, settings);
  if (first.isError || first.json?.status !== "confirmation_required") {
    return { first, second: undefined, challenge: undefined, code: undefined };
  }
  const code = await lastCode(spy);
  options.between?.();
  const second = await finishDelete(id, first.json.challenge as string, code, settings);
  return { first, second, challenge: first.json.challenge as string, code };
}
