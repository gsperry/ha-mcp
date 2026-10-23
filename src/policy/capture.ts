import { CAPTURE_EVENT_PREFIX, CAPTURE_EVENT_TYPES } from "./lists";
import { isTemplate, pyStrip } from "./python";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** A trigger list with single items accepted and items that hold only `triggers` replaced by that list. */
function flatten(value: unknown, depth = 0): unknown[] {
  const out: unknown[] = [];
  for (const item of asList(value)) {
    if (isRecord(item) && Object.keys(item).length === 1 && "triggers" in item) {
      if (depth > 20) throw new Error("triggers are nested too deeply");
      out.push(...flatten(item.triggers, depth + 1));
    } else {
      out.push(item);
    }
  }
  return out;
}

/**
 * Reads triggers the way Home Assistant does before it validates them and returns why one of them could capture the
 * `call_service` event, or null when none can. The kind comes from `trigger` or `platform`; fields under `options`
 * are laid over the trigger, and an `options` entry may never replace the kind or repeat a top-level key.
 */
export function captureProblem(triggers: unknown): string | null {
  let list: unknown[];
  try {
    list = flatten(triggers);
  } catch (error) {
    return error instanceof Error ? error.message : "the triggers cannot be read";
  }
  for (const raw of list) {
    if (!isRecord(raw)) return "a trigger is not a mapping, so it cannot be read";
    if ("trigger" in raw && "platform" in raw) return "a trigger has both `trigger` and `platform`";
    let trigger: Record<string, unknown> = raw;
    if ("options" in raw) {
      const options = raw.options;
      if (!isRecord(options)) return "a trigger's `options` is not a mapping, so it cannot be read";
      if ("platform" in options || "trigger" in options) {
        return "a trigger's `options` holds `platform` or `trigger`, which Home Assistant lets replace the trigger's kind";
      }
      const { options: _dropped, ...rest } = raw;
      for (const key of Object.keys(options)) {
        if (key in rest) return `a trigger sets \`${key}\` both at the top level and under \`options\``;
      }
      trigger = { ...rest, ...options };
    }
    const kind = trigger.trigger ?? trigger.platform;
    if (typeof kind !== "string") return "a trigger has no readable kind";
    if (pyStrip(kind).toLowerCase() !== "event") continue;

    const types = trigger.event_type;
    const items = asList(types);
    if (items.length === 0) return "an event trigger has no readable `event_type`";
    for (const type of items) {
      if (typeof type !== "string") return "an event trigger has an `event_type` that is not text";
      if (isTemplate(type)) return "an event trigger has a templated `event_type`";
      const normalised = pyStrip(type).toLowerCase();
      if (CAPTURE_EVENT_TYPES.has(normalised)) {
        return `an event trigger listens for \`${pyStrip(type)}\`, which carries the data of every service call`;
      }
      if (normalised.startsWith(CAPTURE_EVENT_PREFIX)) {
        return `an event trigger listens for \`${pyStrip(type)}\`, a companion app notification event that can carry notification text`;
      }
    }
  }
  return null;
}
