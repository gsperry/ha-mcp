import type { Env } from "../index";
import {
  drive,
  localCheck,
  Session,
  callNeedsHomeAssistant,
  walkNeedsHomeAssistant,
  type LocalOptions,
} from "./resolve";
import { PolicyRefusal } from "./refusal";
import { allowedNotifyServices, systemActionsAllowed } from "./settings";
import { analyzeCall, newBudget, walkAutomation, type CallFinding, type Problem, type WalkResult } from "./walker";

export { PolicyRefusal } from "./refusal";

function options(env: Env, checkTriggers: boolean): LocalOptions {
  return { block: !systemActionsAllowed(env), notify: allowedNotifyServices(env), checkTriggers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks one `call_service` before it is sent. Returns when the call may go on; throws `PolicyRefusal` when it may
 * not. A call that needs nothing from Home Assistant to be judged never opens the WebSocket.
 */
export async function checkServiceCall(
  env: Env,
  call: { domain: string; service: string; data?: Record<string, unknown> | undefined },
): Promise<void> {
  const opts = options(env, false);
  const problems: Problem[] = [];
  const finding: CallFinding = analyzeCall(
    call.domain.trim().toLowerCase(),
    call.service.trim().toLowerCase(),
    // A REST body has no separate target, but a `target` mapping in it is read as one rather than ignored.
    { data: call.data, target: isRecord(call.data?.target) ? call.data.target : undefined },
    "direct",
    "the call",
    problems,
  );
  const walk: WalkResult = { calls: [finding], devices: [], scenes: [], waits: [], triggers: [], problems };
  localCheck(walk, opts);
  if (!opts.block || !callNeedsHomeAssistant(finding)) return;

  const session = new Session(env, opts);
  await drive(env, session.processCall(finding, 0));
}

/**
 * Checks an automation config that is about to be written. Throws `PolicyRefusal` when it may not be written. The
 * capture rule and the legacy-notify rule apply with the system-action block on or off; the rest only with it on.
 */
export async function checkAutomationWrite(env: Env, config: Record<string, unknown>): Promise<void> {
  const opts = options(env, true);
  const session = new Session(env, opts);
  const instance = isRecord(config.use_blueprint);

  if (!instance) {
    const walk = walkAutomation(config, newBudget());
    localCheck(walk, opts);
    if (!opts.block || !walkNeedsHomeAssistant(walk)) return;
    await drive(
      env,
      (async function* () {
        yield* session.processWalk(walk, 0);
      })(),
    );
    return;
  }

  // A blueprint instance is expanded by Home Assistant, so this always needs the WebSocket.
  await drive(
    env,
    (async function* () {
      if (opts.block) yield* session.loadPlatforms();
      const merged = yield* session.expandBlueprint("automation", config);
      const walk = walkAutomation(merged, newBudget());
      localCheck(walk, opts);
      if (opts.block) yield* session.processWalk(walk, 0);
    })(),
  );
}

/** Checks an automation about to be triggered: its own actions are what would run. */
export async function checkAutomationTrigger(env: Env, entityId: string): Promise<void> {
  const opts = options(env, false);
  if (!opts.block) return;
  const session = new Session(env, opts);
  await drive(env, session.triggerAutomation(entityId.trim().toLowerCase()));
}
