import type { Env } from "../index";
import { haOrigin } from "./rest";

/** Overall limit for connecting, authenticating and running every command. */
export const WS_TIMEOUT_MS = 10_000;

/** What the helper learned about one command. */
export type HaWsResult =
  | { success: true; result: unknown }
  | { success: false; error: { code: string; message: string } };

export interface HaWsCommand {
  /** The command message without its `id`; the helper assigns ids 1..n. */
  message: { type: string; [key: string]: unknown };
  /**
   * Error codes that are an expected answer rather than a failure (for example
   * `config_not_found` when reading a config that may not exist yet). Such an
   * error is returned as this command's result.
   */
  allowErrorCodes?: string[];
  /**
   * Runs with this command's result before the next command is sent. Throw to abort the sequence; the thrown error rejects `haWsCommands` and nothing further is sent.
   * `commands` is read lazily (`commands[index]` when a command is sent, `commands.length` after each check), so a check may append commands to the array it was given;
   * the safety policy relies on this to walk scripts and groups on one connection. A check that appends nothing ends the sequence.
   */
  check?: (result: HaWsResult) => void | Promise<void>;
}

/** Failure of the WebSocket exchange. `code` is HA's error code when it sent one. */
export class HaWsError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "HaWsError";
    this.code = code;
  }
}

const AUTH_INVALID_HINT =
  "Home Assistant rejected the access token (auth_invalid). Likely causes: the token was revoked or is invalid, " +
  "the token's user is inactive, or the user is marked local-only (Nabu Casa requests count as remote). " +
  "Not retrying: repeated failed logins can get this address banned.";

const UNAUTHORIZED_HINT =
  " The token's user may lack administrator rights, which these commands require.";

/** Shared between the exchange and its caller so late events are ignored once the call has ended. */
interface Control {
  done: boolean;
}

/**
 * Opens one WebSocket to Home Assistant, authenticates, and runs `commands`
 * strictly one at a time on that connection. Command k+1 is sent only after
 * command k's result has arrived (and its `check` has passed). The first
 * failure, or an abort from `check`, stops the sequence, sends nothing more and
 * rejects. The socket is closed on every path. Never retries.
 */
export async function haWsCommands(env: Env, commands: HaWsCommand[]): Promise<HaWsResult[]> {
  if (commands.length === 0) return [];

  const url = new URL("/api/websocket", haOrigin(env));
  const controller = new AbortController();
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const control: Control = { done: false };

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new HaWsError(`Home Assistant WebSocket timed out after ${WS_TIMEOUT_MS / 1000} s.`));
    }, WS_TIMEOUT_MS);
  });
  // The timeout may lose the race; do not report it as unhandled.
  timeout.catch(() => undefined);

  const run = async (): Promise<HaWsResult[]> => {
    const response = await fetch(url.toString(), {
      headers: { Upgrade: "websocket" },
      signal: controller.signal,
    });
    const ws = response.webSocket;
    if (controller.signal.aborted) {
      // The timeout already rejected the call; do not leave a late socket open.
      try {
        ws?.accept();
        ws?.close(1000, "timed out");
      } catch {
        // Already closed.
      }
      throw new HaWsError("Home Assistant WebSocket upgrade finished after the time limit.");
    }
    if (!ws) {
      throw new HaWsError(
        `Home Assistant did not upgrade the connection to a WebSocket (HTTP ${response.status}). ` +
          "Check HA_URL and that the endpoint allows WebSocket connections.",
      );
    }
    socket = ws;
    ws.accept();
    return exchange(ws, env.HA_TOKEN, commands, control);
  };

  try {
    return await Promise.race([run(), timeout]);
  } finally {
    control.done = true;
    if (timer !== undefined) clearTimeout(timer);
    try {
      socket?.close(1000, "done");
    } catch {
      // Already closed.
    }
  }
}

function exchange(
  ws: WebSocket,
  token: string,
  commands: HaWsCommand[],
  control: Control,
): Promise<HaWsResult[]> {
  return new Promise<HaWsResult[]>((resolve, reject) => {
    const results: HaWsResult[] = [];
    let phase: "auth_required" | "auth" | "commands" | "finished" = "auth_required";
    let index = 0; // zero-based index of the command in flight; its id is index + 1

    const finish = (fn: () => void): void => {
      phase = "finished";
      fn();
    };

    /**
     * Sends one message. A throw from `send` (the socket is already closing, say) rejects the call at once
     * instead of leaving it to the time limit. It carries no `code`, so callers treat it like any other
     * connection failure. This also covers the send made from the result handler, which runs as a discarded
     * promise where a throw would otherwise go unnoticed.
     */
    const send = (message: Record<string, unknown>): void => {
      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        finish(() => reject(new HaWsError(`Sending to the Home Assistant WebSocket failed (${reason}).`)));
      }
    };

    const sendCurrent = (): void => {
      if (control.done) return;
      const command = commands[index]!;
      send({ ...command.message, id: index + 1 });
    };

    const handleResult = async (msg: Record<string, unknown>): Promise<void> => {
      const command = commands[index]!;
      let result: HaWsResult;
      if (msg["success"] === true) {
        result = { success: true, result: msg["result"] };
      } else {
        const err = (msg["error"] ?? {}) as { code?: unknown; message?: unknown };
        const code = typeof err.code === "string" ? err.code : "unknown_error";
        const message = typeof err.message === "string" ? err.message : "No message from Home Assistant.";
        if (!command.allowErrorCodes?.includes(code)) {
          finish(() =>
            reject(
              new HaWsError(
                `Home Assistant rejected command ${index + 1} (${command.message.type}): ${code}: ${message}` +
                  (code === "unauthorized" ? UNAUTHORIZED_HINT : ""),
                code,
              ),
            ),
          );
          return;
        }
        result = { success: false, error: { code, message } };
      }

      try {
        await command.check?.(result);
      } catch (error) {
        finish(() => reject(error));
        return;
      }
      if (phase === "finished" || control.done) return;

      results.push(result);
      index += 1;
      if (index >= commands.length) {
        finish(() => resolve(results));
      } else {
        sendCurrent();
      }
    };

    ws.addEventListener("message", (event: MessageEvent) => {
      if (phase === "finished" || control.done || typeof event.data !== "string") return;
      let msg: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        msg = parsed as Record<string, unknown>;
      } catch {
        finish(() => reject(new HaWsError("Home Assistant sent a message that is not a valid JSON object.")));
        return;
      }
      const type = msg["type"];

      if (phase === "auth_required") {
        if (type !== "auth_required") {
          finish(() => reject(new HaWsError(`Expected auth_required from Home Assistant, got ${String(type)}.`)));
          return;
        }
        phase = "auth";
        send({ type: "auth", access_token: token });
      } else if (phase === "auth") {
        if (type === "auth_ok") {
          phase = "commands";
          sendCurrent();
        } else if (type === "auth_invalid") {
          finish(() => reject(new HaWsError(AUTH_INVALID_HINT, "auth_invalid")));
        } else {
          finish(() => reject(new HaWsError(`Unexpected message during authentication: ${String(type)}.`)));
        }
      } else if (type === "result" && msg["id"] === index + 1) {
        void handleResult(msg);
      }
      // Anything else (events, results for other ids) is ignored.
    });

    ws.addEventListener("close", () => {
      if (phase !== "finished") {
        finish(() => reject(new HaWsError("Home Assistant closed the WebSocket before the commands completed.")));
      }
    });
    ws.addEventListener("error", () => {
      if (phase !== "finished") {
        finish(() => reject(new HaWsError("The Home Assistant WebSocket reported an error.")));
      }
    });
  });
}
