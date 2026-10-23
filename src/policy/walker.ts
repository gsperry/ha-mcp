import {
  DEVICE_BUTTON_DOMAIN,
  DEVICE_OWN_DOMAINS,
  DEVICE_TOGGLE_DOMAINS,
  INLINE_ENTITY_SERVICES,
  MAX_NESTING,
  MAX_STEPS,
  RESERVED_EVENT_PREFIX,
  mediaPlayerField,
} from "./lists";
import { isEntityId, isTemplate, parseWholeDataString, pyStrip } from "./python";

/**
 * Pure code that reads the steps of an automation or script and reports what they would do: the service calls with
 * their targets and data, device steps, scene runs, event steps and wait-for-trigger lists, plus every reason a step
 * cannot be understood. It never changes its input and never touches the network.
 */

export interface OtherTargets {
  device_id: string[];
  area_id: string[];
  floor_id: string[];
  label_id: string[];
}

export interface CallFinding {
  /** Normalised: trimmed, lower case. */
  domain: string;
  service: string;
  /** Pieces of the `entity_id` target key, normalised. May hold `all` and `none`. */
  entityPieces: string[];
  others: OtherTargets;
  /** Strings in the data that are exactly an entity id (lower case). Known ones are acted on. */
  scanned: string[];
  /** Pieces of the strict member fields. When `membersAreMedia` is true they may hold `all` and `none`. */
  members: string[];
  membersAreMedia: boolean;
  /** Where in the config the call stands, for messages. */
  where: string;
}

export interface DeviceFinding {
  domain: string;
  /** The service the step is classified as (`press`, `turn_on`, the step's type, ...). */
  service: string;
  /** An entity id or a registry id, as written (trimmed, lower case). */
  entity: string;
  where: string;
}

export interface SceneFinding {
  entity: string;
  where: string;
}

export interface Problem {
  rule: string;
  what: string;
}

export interface WalkResult {
  calls: CallFinding[];
  devices: DeviceFinding[];
  scenes: SceneFinding[];
  /** The value of every `wait_for_trigger` step, for the capture rule. */
  waits: unknown[];
  /** Triggers of an automation config (`triggers` and `trigger`, both read). */
  triggers: unknown[];
  problems: Problem[];
}

/** Steps counted across every config of one check. */
export interface Budget {
  steps: number;
  exceeded: boolean;
}

export function newBudget(): Budget {
  return { steps: 0, exceeded: false };
}

function emptyResult(): WalkResult {
  return { calls: [], devices: [], scenes: [], waits: [], triggers: [], problems: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Home Assistant's order of step types (`ACTIONS_MAP`); the first key present decides. */
const ACTIONS_ORDER = [
  "delay",
  "wait_template",
  "condition",
  "and",
  "or",
  "not",
  "event",
  "device_id",
  "scene",
  "repeat",
  "choose",
  "wait_for_trigger",
  "variables",
  "if",
  "action",
  "service",
  "service_template",
  "stop",
  "parallel",
  "sequence",
  "set_conversation_response",
] as const;

const SERVICE_NAME = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const TARGET_KEYS = ["entity_id", "device_id", "area_id", "floor_id", "label_id"] as const;

// ---------------------------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------------------------

export type CallParts = {
  data?: unknown;
  dataTemplate?: unknown;
  target?: unknown;
  /** The step-level `entity_id`. */
  entityId?: unknown;
};

/** `walked` data is rendered by Home Assistant when the step runs; `direct` data (a tool call) is plain JSON. */
export type DataMode = "walked" | "direct";

function splitPieces(text: string): string[] {
  return text.split(",").map((p) => pyStrip(p).toLowerCase()).filter((p) => p !== "");
}

/** True when a template marker sits in a string anywhere in the value, a mapping key included. */
function hasTemplate(value: unknown, depth = 0): boolean {
  if (depth > 40) return true;
  if (typeof value === "string") return isTemplate(value);
  if (Array.isArray(value)) return value.some((v) => hasTemplate(v, depth + 1));
  if (isRecord(value)) return Object.entries(value).some(([k, v]) => isTemplate(k) || hasTemplate(v, depth + 1));
  return false;
}

function hasTemplatedKey(value: unknown, depth = 0): boolean {
  if (depth > 40) return true;
  if (Array.isArray(value)) return value.some((v) => hasTemplatedKey(v, depth + 1));
  if (isRecord(value)) return Object.entries(value).some(([k, v]) => isTemplate(k) || hasTemplatedKey(v, depth + 1));
  return false;
}

/** Collects the strings of a value that are exactly an entity id, or comma pieces that are, keys included. */
function scan(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 40) return;
  if (typeof value === "string") {
    if (isTemplate(value)) return;
    const whole = pyStrip(value).toLowerCase();
    if (isEntityId(whole)) out.add(whole);
    if (value.includes(",")) for (const piece of splitPieces(value)) if (isEntityId(piece)) out.add(piece);
  } else if (Array.isArray(value)) {
    for (const v of value) scan(v, out, depth + 1);
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      scan(k, out, depth + 1);
      scan(v, out, depth + 1);
    }
  }
}

/**
 * Turns the parts of one call into a finding, and reports every reason the call cannot be judged without running
 * it (templated name, target or data, unreadable data). `where` names the step for messages.
 */
export function analyzeCall(
  nameDomain: string,
  nameService: string,
  parts: CallParts,
  mode: DataMode,
  where: string,
  problems: Problem[],
): CallFinding {
  const domain = nameDomain;
  const service = nameService;
  const label = `${domain}.${service} at ${where}`;
  const walked = mode === "walked";
  const mp = mediaPlayerField(domain, service);
  const inline = INLINE_ENTITY_SERVICES.has(`${domain}.${service}`);
  const problem = (what: string): void => void problems.push({ rule: "undecidable", what: `${label}: ${what}` });

  /** The whole `data` or `data_template` value as a mapping. */
  const asData = (raw: unknown, name: string): Record<string, unknown> => {
    if (raw === undefined || raw === null) return {};
    if (isRecord(raw)) return raw;
    if (typeof raw === "string" && walked) {
      if (isTemplate(raw)) {
        problem(`\`${name}\` is a template, which Home Assistant renders only when the step runs.`);
        return {};
      }
      const parsed = parseWholeDataString(raw);
      if (!parsed.ok) {
        problem(
          `\`${name}\` is a text that the policy cannot read as a mapping (${parsed.reason}). Home Assistant turns a whole ` +
            "`data` text into a mapping when the step runs, so what it names cannot be checked.",
        );
        return {};
      }
      return parsed.value as Record<string, unknown>;
    }
    problem(`\`${name}\` is not a mapping.`);
    return {};
  };

  const data = asData(parts.data, "data");
  const dataTemplate = asData(parts.dataTemplate, "data_template");

  let target: Record<string, unknown> = {};
  if (parts.target !== undefined && parts.target !== null) {
    if (isRecord(parts.target)) {
      target = parts.target;
    } else if (typeof parts.target === "string" && walked && isTemplate(parts.target)) {
      problem("`target` is a template, which Home Assistant renders only when the step runs.");
    } else {
      problem("`target` is not a mapping.");
    }
  }

  if (walked) {
    for (const [name, value] of [["data", data], ["data_template", dataTemplate], ["target", target]] as const) {
      if (hasTemplatedKey(value)) problem(`a mapping key in \`${name}\` is a template, which Home Assistant renders when the step runs.`);
    }
    if (inline && (hasTemplate(data) || hasTemplate(dataTemplate))) {
      problem(`a templated value in the data of ${domain}.${service}, which carries entities throughout its data.`);
    }
  }

  /** Reads one source of target-key values into pieces. */
  const pieces = (value: unknown, key: string, strictTemplateCheck: boolean): string[] => {
    const out: string[] = [];
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (item === undefined || item === null) continue;
      if (typeof item !== "string") {
        problem(`\`${key}\` holds something that is not text.`);
        continue;
      }
      if (walked && isTemplate(item) && strictTemplateCheck) {
        problem(`\`${key}\` is a template, which Home Assistant renders only when the step runs.`);
        continue;
      }
      out.push(...(key === "entity_id" || mp === key ? splitPieces(item) : splitOthers(item)));
    }
    return out;
  };
  const splitOthers = (text: string): string[] =>
    text.split(",").map((p) => pyStrip(p)).filter((p) => p !== "");

  const entityPieces: string[] = [];
  const others: OtherTargets = { device_id: [], area_id: [], floor_id: [], label_id: [] };
  const members: string[] = [];
  let membersAreMedia = false;

  for (const key of TARGET_KEYS) {
    const sources: unknown[] = [data[key], dataTemplate[key], target[key]];
    if (key === "entity_id") sources.push(parts.entityId);
    for (const src of sources) {
      if (src === undefined || src === null) continue;
      if (key === "entity_id") {
        if (mp === "entity_id") {
          // A legacy say service passes this field on to media_player.play_media.
          membersAreMedia = true;
          members.push(...pieces(src, key, true));
        } else {
          entityPieces.push(...pieces(src, key, true));
        }
      } else {
        others[key].push(...pieces(src, key, true));
      }
    }
  }

  // The media-player field of the other media-player services, read strictly.
  if (mp !== undefined && mp !== "entity_id") {
    membersAreMedia = true;
    for (const src of [data[mp], dataTemplate[mp]]) {
      if (src === undefined || src === null) continue;
      if (walked && hasTemplate(src)) {
        problem(`the media-player field \`${mp}\` is a template, which Home Assistant renders only when the step runs.`);
        continue;
      }
      const items = Array.isArray(src) ? src : [src];
      for (const item of items) {
        if (typeof item !== "string") problem(`the media-player field \`${mp}\` holds something that is not text.`);
        else members.push(...splitPieces(item));
      }
    }
  }

  // The members of the inline-entity services.
  if (`${domain}.${service}` === "scene.apply") {
    for (const src of [data.entities, dataTemplate.entities]) {
      if (src === undefined || src === null) continue;
      if (!isRecord(src)) problem("`entities` is not a mapping.");
      else for (const key of Object.keys(src)) members.push(pyStrip(key).toLowerCase());
    }
  }
  if (`${domain}.${service}` === "media_player.join") {
    for (const src of [data.group_members, dataTemplate.group_members]) {
      if (src === undefined || src === null) continue;
      const items = Array.isArray(src) ? src : [src];
      for (const item of items) {
        if (typeof item !== "string") problem("`group_members` holds something that is not text.");
        else members.push(...splitPieces(item));
      }
    }
  }

  // The generic scan: every other string in the data that is exactly an entity id.
  const found = new Set<string>();
  const skip = new Set<string>(TARGET_KEYS);
  for (const source of [data, dataTemplate, target]) {
    for (const [key, value] of Object.entries(source)) {
      if (skip.has(key)) continue;
      scan(key, found);
      scan(value, found);
    }
  }

  return {
    domain,
    service,
    entityPieces: unique(entityPieces),
    others: {
      device_id: unique(others.device_id),
      area_id: unique(others.area_id),
      floor_id: unique(others.floor_id),
      label_id: unique(others.label_id),
    },
    scanned: [...found],
    members: unique(members),
    membersAreMedia,
    where,
  };
}

function unique(list: string[]): string[] {
  return [...new Set(list)];
}

/** Splits `domain.service`, normalised, or reports why it cannot be read. */
function readName(value: unknown, where: string, problems: Problem[]): [string, string] | undefined {
  if (typeof value !== "string") {
    problems.push({ rule: "undecidable", what: `the service name at ${where} is not text.` });
    return undefined;
  }
  if (isTemplate(value)) {
    problems.push({
      rule: "undecidable",
      what: `the service name at ${where} is a template, so Home Assistant decides it only when the step runs.`,
    });
    return undefined;
  }
  const name = pyStrip(value).toLowerCase();
  if (!SERVICE_NAME.test(name)) {
    problems.push({ rule: "undecidable", what: `the service name ${JSON.stringify(value)} at ${where} cannot be read.` });
    return undefined;
  }
  const dot = name.indexOf(".");
  return [name.slice(0, dot), name.slice(dot + 1)];
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

function walkList(value: unknown, path: string, depth: number, r: WalkResult, budget: Budget): void {
  if (value === undefined || value === null) return;
  const items = Array.isArray(value) ? value : [value];
  items.forEach((item, i) => walkStep(item, Array.isArray(value) ? `${path}[${i}]` : path, depth, r, budget));
}

function deviceFinding(step: Record<string, unknown>, where: string, r: WalkResult): void {
  const bad = (what: string): void => void r.problems.push({ rule: "device action", what: `${what} (${where}).` });
  const domain = typeof step.domain === "string" ? pyStrip(step.domain).toLowerCase() : undefined;
  if (domain === undefined) return bad("a device step has no readable `domain`, so what it does cannot be determined");
  const known = domain === DEVICE_BUTTON_DOMAIN || DEVICE_TOGGLE_DOMAINS.has(domain) || DEVICE_OWN_DOMAINS.has(domain);
  if (!known) {
    return bad(
      `a device action of \`${domain}\` is that integration's own code, so what it does cannot be determined and the server refuses it`,
    );
  }
  const type = typeof step.type === "string" ? pyStrip(step.type).toLowerCase() : undefined;
  if (type === undefined) return bad("a device step has no readable `type`");
  const entity = step.entity_id;
  if (typeof entity !== "string" || pyStrip(entity) === "") {
    return bad(`a device step of \`${domain}\` names no entity, so what it acts on cannot be determined`);
  }
  if (isTemplate(entity)) return bad("a device step's entity is a template");

  let service: string;
  if (domain === DEVICE_BUTTON_DOMAIN) service = "press";
  else if (DEVICE_TOGGLE_DOMAINS.has(domain)) {
    if (type === "turn_on" || type === "turn_off" || type === "toggle") service = type;
    else if (domain === "light") service = "turn_on";
    else return bad(`a \`${domain}\` device step of type \`${type}\` cannot be determined`);
  } else service = type;
  r.devices.push({ domain, service, entity: pyStrip(entity).toLowerCase(), where });
}

function walkStep(step: unknown, path: string, depth: number, r: WalkResult, budget: Budget): void {
  if (budget.exceeded) return;
  if (depth > MAX_NESTING) {
    budget.exceeded = true;
    r.problems.push({ rule: "bound", what: `the config nests action lists deeper than ${MAX_NESTING} levels, which is too large to check.` });
    return;
  }
  budget.steps += 1;
  if (budget.steps > MAX_STEPS) {
    budget.exceeded = true;
    r.problems.push({ rule: "bound", what: `the request holds more than ${MAX_STEPS} steps, which is too large to check.` });
    return;
  }
  if (!isRecord(step)) {
    r.problems.push({ rule: "undecidable", what: `the step at ${path} is not a mapping, so it cannot be read.` });
    return;
  }
  if (!ACTIONS_ORDER.some((key) => key in step)) {
    r.problems.push({ rule: "undecidable", what: `the step at ${path} has no key that names an action type, so it cannot be read.` });
  }

  // Every call-carrying and list-carrying key is read, whatever type wins in Home Assistant.
  for (const key of ["action", "service", "service_template"] as const) {
    if (!(key in step)) continue;
    const name = readName(step[key], `${path}.${key}`, r.problems);
    if (name === undefined) continue;
    r.calls.push(
      analyzeCall(
        name[0],
        name[1],
        { data: step.data, dataTemplate: step.data_template, target: step.target, entityId: step.entity_id },
        "walked",
        path,
        r.problems,
      ),
    );
  }

  if ("device_id" in step) deviceFinding(step, path, r);

  if ("event" in step) {
    const type = step.event;
    if (typeof type !== "string") r.problems.push({ rule: "event", what: `the event type at ${path} is not text.` });
    else if (isTemplate(type)) {
      r.problems.push({ rule: "event", what: `the event type at ${path} is a template, so it is decided only when the step runs.` });
    } else if (pyStrip(type).toLowerCase().startsWith(RESERVED_EVENT_PREFIX)) {
      r.problems.push({
        rule: "event",
        what: `the step at ${path} fires ${JSON.stringify(pyStrip(type))}, an event type reserved for Home Assistant itself.`,
      });
    }
  }

  if ("scene" in step) {
    const scene = step.scene;
    if (typeof scene !== "string" || isTemplate(scene)) {
      r.problems.push({ rule: "undecidable", what: `the scene at ${path} is not a plain entity id.` });
    } else {
      r.scenes.push({ entity: pyStrip(scene).toLowerCase(), where: path });
    }
  }

  if ("wait_for_trigger" in step) r.waits.push(step.wait_for_trigger);

  // Nested lists.
  if ("sequence" in step) walkList(step.sequence, `${path}.sequence`, depth + 1, r, budget);
  if ("choose" in step) {
    const options = Array.isArray(step.choose) ? step.choose : [step.choose];
    options.forEach((option, i) => {
      if (!isRecord(option)) {
        r.problems.push({ rule: "undecidable", what: `a \`choose\` option at ${path} is not a mapping.` });
        return;
      }
      walkList(option.sequence, `${path}.choose[${i}].sequence`, depth + 1, r, budget);
    });
  }
  if ("default" in step) walkList(step.default, `${path}.default`, depth + 1, r, budget);
  if ("then" in step) walkList(step.then, `${path}.then`, depth + 1, r, budget);
  if ("else" in step) walkList(step.else, `${path}.else`, depth + 1, r, budget);
  if ("repeat" in step) {
    if (!isRecord(step.repeat)) r.problems.push({ rule: "undecidable", what: `\`repeat\` at ${path} is not a mapping.` });
    else walkList(step.repeat.sequence, `${path}.repeat.sequence`, depth + 1, r, budget);
  }
  if ("parallel" in step) {
    const entries = Array.isArray(step.parallel) ? step.parallel : [step.parallel];
    entries.forEach((entry, i) => walkList(entry, `${path}.parallel[${i}]`, depth + 1, r, budget));
  }
}

/** Walks a list of steps (single items accepted). */
export function walkSteps(steps: unknown, budget: Budget, path = "actions"): WalkResult {
  const r = emptyResult();
  walkList(steps, path, 0, r, budget);
  return r;
}

function stillBlueprint(config: Record<string, unknown>, r: WalkResult): boolean {
  if ("use_blueprint" in config) {
    r.problems.push({
      rule: "undecidable",
      what: "the config still holds `use_blueprint`, so its blueprint did not load and what it runs is unknown.",
    });
    return true;
  }
  return false;
}

/** Walks an automation config: `actions` and `action` are both read, and so are `triggers` and `trigger`. */
export function walkAutomation(config: unknown, budget: Budget): WalkResult {
  const r = emptyResult();
  if (!isRecord(config)) {
    r.problems.push({ rule: "undecidable", what: "the automation config is not a mapping." });
    return r;
  }
  if (stillBlueprint(config, r)) return r;
  for (const key of ["actions", "action"] as const) walkList(config[key], key, 0, r, budget);
  for (const key of ["triggers", "trigger"] as const) {
    if (config[key] !== undefined && config[key] !== null) r.triggers.push(config[key]);
  }
  return r;
}

/** Walks a script config: its `sequence`. */
export function walkScript(config: unknown, budget: Budget): WalkResult {
  const r = emptyResult();
  if (!isRecord(config)) {
    r.problems.push({ rule: "undecidable", what: "the script config is not a mapping." });
    return r;
  }
  if (stillBlueprint(config, r)) return r;
  walkList(config.sequence, "sequence", 0, r, budget);
  return r;
}

