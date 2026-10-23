import type { Env } from "../index";
import { HaError, haFetch, pathSegment } from "../ha/rest";
import { haWsCommands, type HaWsCommand, type HaWsResult } from "../ha/ws";
import { captureProblem } from "./capture";
import {
  BLOCKED_DOMAINS,
  BLOCKED_SERVICES,
  DENIED_PLATFORMS,
  DISPATCH_SERVICES,
  MAX_LEVEL,
  MAX_NODES,
  MAX_REST_READS,
  MAX_WS_COMMANDS,
  NON_FORWARDING_GROUP_DOMAINS,
  NOTIFY_ENTITY_SERVICE,
  WALK_TIMEOUT_MS,
} from "./lists";
import { isEntityId } from "./python";
import { PolicyRefusal, checkFailed, refusal } from "./refusal";
import {
  newBudget,
  walkAutomation,
  walkScript,
  type Budget,
  type CallFinding,
  type DeviceFinding,
  type Problem,
  type SceneFinding,
  type WalkResult,
} from "./walker";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const domainOf = (entityId: string): string => entityId.slice(0, entityId.indexOf("."));

// ---------------------------------------------------------------------------------------------
// Local checks: decided from the request alone, before anything is sent to Home Assistant.
// ---------------------------------------------------------------------------------------------

export interface LocalOptions {
  /** The system-action block is on (it is off when the owner set ALLOW_SYSTEM_ACTIONS to true). */
  block: boolean;
  /** The legacy notify services that may be called, written as bare service names. */
  notify: ReadonlySet<string>;
  /** Also apply the capture rule to the config's own triggers (a config being written, not one read back). */
  checkTriggers: boolean;
}

/** The refusal for one call by name, or undefined. The notify rule holds with the block on or off. */
function nameRefusal(call: CallFinding, options: LocalOptions): PolicyRefusal | undefined {
  const name = `${call.domain}.${call.service}`;
  if (options.block) {
    if (BLOCKED_DOMAINS.has(call.domain)) {
      return refusal("blocked service", `${name} belongs to the ${call.domain} domain, which is blocked as a system action (${call.where}).`);
    }
    if (BLOCKED_SERVICES.has(name)) {
      return refusal("blocked service", `${name} is blocked as a system action (${call.where}).`);
    }
    if (DISPATCH_SERVICES.has(name)) {
      return refusal(
        "dispatch service",
        `${name} hands free text to an assistant that can act on entities this server never checked (${call.where}).`,
      );
    }
  }
  if (call.domain === "notify" && call.service !== NOTIFY_ENTITY_SERVICE && !options.notify.has(call.service)) {
    return refusal(
      "legacy notify",
      `${name} is a legacy notify service that is not on the allowlist, and such a service can run a shell command (${call.where}). ` +
        "The owner lists the services the model may call in the ALLOWED_NOTIFY_SERVICES setting.",
    );
  }
  return undefined;
}

function problemRefusal(problem: Problem): PolicyRefusal {
  return refusal(problem.rule, `${problem.what} Anything whose effect cannot be determined in advance is refused.`);
}

/**
 * Applies every check that needs no Home Assistant request to one walk result and throws the first refusal. With the
 * block off only the legacy-notify rule and the capture rule remain.
 */
export function localCheck(walk: WalkResult, options: LocalOptions): void {
  for (const call of walk.calls) {
    const refused = nameRefusal(call, options);
    if (refused) throw refused;
  }
  const waits = walk.waits.map((w) => captureProblem(w)).find((p) => p !== null);
  if (waits) throw captureRefusal(waits);
  if (options.checkTriggers) {
    for (const triggers of walk.triggers) {
      const problem = captureProblem(triggers);
      if (problem !== null) throw captureRefusal(problem);
    }
  }
  if (!options.block) return;
  for (const call of walk.calls) {
    if (call.domain === "homeassistant" && call.entityPieces.includes("all")) {
      throw refusal(
        "undecidable",
        `${call.domain}.${call.service} with \`entity_id: all\` (${call.where}); Home Assistant refuses it too, because it cannot tell which domains it forwards to.`,
      );
    }
  }
  const first = walk.problems[0];
  if (first) throw problemRefusal(first);
}

function captureRefusal(problem: string): PolicyRefusal {
  return refusal(
    "capture rule",
    `${problem}. The event carries the data of every service call, including the codes this server sends to the owner, ` +
      "so an automation written through this server must not listen for it.",
  );
}

/** Whether judging a call needs anything from Home Assistant. */
export function callNeedsHomeAssistant(call: CallFinding): boolean {
  if (call.entityPieces.some((p) => p !== "none")) return true;
  if (call.scanned.length > 0) return true;
  if (call.members.some((p) => p !== "none")) return true;
  const o = call.others;
  if (o.device_id.length + o.area_id.length + o.floor_id.length + o.label_id.length > 0) return true;
  return isScriptKeyRoute(call);
}

const SCRIPT_ENTITY_SERVICES = new Set(["turn_on", "turn_off", "toggle", "reload"]);

function isScriptKeyRoute(call: CallFinding): boolean {
  return call.domain === "script" && !SCRIPT_ENTITY_SERVICES.has(call.service);
}

export function walkNeedsHomeAssistant(walk: WalkResult): boolean {
  return walk.devices.length > 0 || walk.scenes.length > 0 || walk.calls.some(callNeedsHomeAssistant);
}

// ---------------------------------------------------------------------------------------------
// The walk on one WebSocket connection
// ---------------------------------------------------------------------------------------------

export interface WsRequest {
  message: { type: string; [key: string]: unknown };
  allowErrorCodes?: string[];
}

export type Gen<T> = AsyncGenerator<WsRequest, T, HaWsResult>;

/** Resolves entities, reads scripts, automations, scenes and groups, and classifies what a request would run. */
export class Session {
  private readonly startedAt = Date.now();
  private readonly budget: Budget = newBudget();
  private commands = 0;
  private restReads = 0;
  private readonly nodes = new Set<string>();
  private readonly buttons = new Set<string>();
  private platforms: Map<string, string> | undefined;
  private registry: Map<string, string> | undefined;

  constructor(
    private readonly env: Env,
    private readonly options: LocalOptions,
  ) {}

  // -- Plumbing --------------------------------------------------------------------------------

  private async *ws(message: WsRequest["message"], allowErrorCodes?: string[]): Gen<HaWsResult> {
    this.commands += 1;
    if (this.commands > MAX_WS_COMMANDS) {
      throw refusal("bound", `the request needs more than ${MAX_WS_COMMANDS} Home Assistant commands to check, which is too large to check.`);
    }
    const request: WsRequest = allowErrorCodes === undefined ? { message } : { message, allowErrorCodes };
    return yield request;
  }

  private async rest(path: string): Promise<unknown> {
    this.restReads += 1;
    if (this.restReads > MAX_REST_READS) {
      throw refusal("bound", `the request needs more than ${MAX_REST_READS} Home Assistant reads of scenes, scripts or groups to check, which is too large to check.`);
    }
    const left = Math.max(1, WALK_TIMEOUT_MS - (Date.now() - this.startedAt));
    return haFetch(this.env, path, { timeoutMs: left });
  }

  private refuseUnreadable(what: string): never {
    throw refusal("undecidable", `${what} could not be read, so what it would run is unknown.`);
  }

  // -- Maps ------------------------------------------------------------------------------------

  /** The platform of every entity, from `entity/source`. Read once. */
  async *loadPlatforms(): Gen<Map<string, string>> {
    if (this.platforms) return this.platforms;
    const result = yield* this.ws({ type: "entity/source" });
    if (!result.success || !isRecord(result.result)) {
      return this.refuseUnreadable("The list of entity platforms (entity/source)");
    }
    const map = new Map<string, string>();
    for (const [id, source] of Object.entries(result.result)) {
      if (isRecord(source) && typeof source.domain === "string") map.set(id, source.domain.toLowerCase());
    }
    this.platforms = map;
    return map;
  }

  private async *loadRegistry(): Gen<Map<string, string>> {
    if (this.registry) return this.registry;
    const result = yield* this.ws({ type: "config/entity_registry/list" });
    if (!result.success || !Array.isArray(result.result)) {
      return this.refuseUnreadable("The entity registry");
    }
    const map = new Map<string, string>();
    for (const entry of result.result) {
      if (isRecord(entry) && typeof entry.id === "string" && typeof entry.entity_id === "string") {
        map.set(entry.id.toLowerCase(), entry.entity_id.toLowerCase());
      }
    }
    this.registry = map;
    return map;
  }

  // -- Nodes -----------------------------------------------------------------------------------

  /** Registers a node. False when it was visited already. Refuses past the depth and count bounds. */
  private enterNode(key: string, level: number, label: string): boolean {
    if (this.nodes.has(key)) return false;
    if (level >= MAX_LEVEL) {
      throw refusal("bound", `${label} sits ${level} levels below the request, deeper than the limit of ${MAX_LEVEL - 1}, which is too deep to check.`);
    }
    if (this.nodes.size >= MAX_NODES) {
      throw refusal("bound", `the request reaches more than ${MAX_NODES} scripts, automations, scenes or groups (at ${label}), which is too large to check.`);
    }
    this.nodes.add(key);
    return true;
  }

  /** Walks the config of a script or automation that was read, then processes what it holds. */
  private async *walkNode(config: unknown, kind: "script" | "automation", level: number): Gen<void> {
    const walk = kind === "script" ? walkScript(config, this.budget) : walkAutomation(config, this.budget);
    localCheck(walk, { ...this.options, checkTriggers: false });
    yield* this.processWalk(walk, level);
  }

  async *processWalk(walk: WalkResult, level: number): Gen<void> {
    for (const scene of walk.scenes) yield* this.processScene(scene, level);
    for (const device of walk.devices) yield* this.processDevice(device, level);
    for (const call of walk.calls) yield* this.processCall(call, level);
  }

  private async *runScript(entityId: string, level: number): Gen<void> {
    if (!this.enterNode(entityId, level, `script ${entityId}`)) return;
    const result = yield* this.ws({ type: "script/config", entity_id: entityId }, ["not_found"]);
    const config = result.success && isRecord(result.result) ? result.result.config : undefined;
    if (!isRecord(config)) return this.refuseUnreadable(`The script ${entityId}`);
    yield* this.walkNode(config, "script", level);
  }

  /** `script.<key>`: the key is not the entity id, so the scripts file is read by key. */
  private async *runScriptKey(key: string, level: number): Gen<void> {
    if (!this.enterNode(`key:${key}`, level, `script ${key}`)) return;
    let body: unknown;
    try {
      body = await this.rest(`/api/config/script/config/${pathSegment(key)}`);
    } catch (error) {
      if (error instanceof HaError && error.status === 404) {
        throw refusal(
          "undecidable",
          `the script ${key} is not in the scripts file (a script from a YAML package, or no such script), so what it runs cannot be read by key. ` +
            "Run it with script.turn_on and its entity id instead.",
        );
      }
      throw error;
    }
    if (!isRecord(body)) return this.refuseUnreadable(`The script ${key}`);
    const config = isRecord(body.use_blueprint) ? yield* this.expandBlueprint("script", body) : body;
    yield* this.walkNode(config, "script", level);
  }

  private async *runAutomation(entityId: string, level: number): Gen<void> {
    if (!this.enterNode(entityId, level, `automation ${entityId}`)) return;
    const result = yield* this.ws({ type: "automation/config", entity_id: entityId }, ["not_found"]);
    const config = result.success && isRecord(result.result) ? result.result.config : undefined;
    if (!isRecord(config)) return this.refuseUnreadable(`The automation ${entityId}`);
    yield* this.walkNode(config, "automation", level);
  }

  private async *runScene(entityId: string, level: number): Gen<void> {
    if (!this.enterNode(entityId, level, `scene ${entityId}`)) return;
    // Only a scene of the homeassistant platform has members; any other is classified like any entity.
    if (this.platforms?.get(entityId) !== "homeassistant") return;
    const members = await this.readMembers(entityId, "scene");
    yield* this.actOn(members, "turn_on", level);
  }

  /** The `entity_id` attribute of a scene or a group, read from its state. */
  private async readMembers(entityId: string, what: string): Promise<string[]> {
    let body: unknown;
    try {
      body = await this.rest(`/api/states/${pathSegment(entityId)}`);
    } catch (error) {
      if (error instanceof HaError) {
        throw refusal(
          "undecidable",
          `the ${what} ${entityId} could not be read (${error.message}), so its members are unknown.`,
        );
      }
      throw error;
    }
    const attribute = isRecord(body) && isRecord(body.attributes) ? body.attributes.entity_id : undefined;
    if (!Array.isArray(attribute) || !attribute.every((m) => typeof m === "string" && isEntityId(m.toLowerCase()))) {
      return this.refuseUnreadable(`The members of the ${what} ${entityId}`);
    }
    return attribute.map((m) => (m as string).toLowerCase());
  }

  private async *runGroup(entityId: string, es: string, level: number): Gen<void> {
    if (!this.enterNode(`group:${entityId}:${es}`, level + 1, `group ${entityId}`)) return;
    const members = await this.readMembers(entityId, "group");
    yield* this.actOn(members, es, level + 1);
  }

  /** `blueprint/substitute` plus the instance's own keys laid over it, as Home Assistant merges them. */
  async *expandBlueprint(domain: "automation" | "script", instance: Record<string, unknown>): Gen<Record<string, unknown>> {
    const use = instance.use_blueprint;
    const path = isRecord(use) ? use.path : undefined;
    const input = isRecord(use) && use.input !== undefined && use.input !== null ? use.input : {};
    if (typeof path !== "string" || !isRecord(input)) {
      throw refusal("undecidable", "the config's `use_blueprint` has no readable `path` and `input`, so its blueprint cannot be expanded.");
    }
    const result = yield* this.ws({ type: "blueprint/substitute", domain, path, input }, ["unknown_error", "not_found", "invalid_format"]);
    const substituted = result.success && isRecord(result.result) ? result.result.substituted_config : undefined;
    if (!isRecord(substituted)) {
      const reason = result.success ? "" : ` (${result.error.message})`;
      throw refusal("undecidable", `the blueprint ${path} could not be expanded${reason}, so what the config would run is unknown.`);
    }
    const { use_blueprint: _use, blueprint: _bp, ...own } = instance;
    return { ...substituted, ...own };
  }

  // -- Entities --------------------------------------------------------------------------------

  private classify(entityId: string): void {
    const platform = this.platforms?.get(entityId);
    if (platform === undefined) {
      throw refusal(
        "unknown entity",
        `${entityId} is not an entity that Home Assistant lists with a platform (a misspelt id, a disabled entity, a state with no entity behind it, ` +
          "or a registry id, which must be replaced by the entity id), so what it would run cannot be classified.",
      );
    }
    if (DENIED_PLATFORMS.has(platform)) {
      throw refusal(
        "platform denylist",
        `${entityId} belongs to the ${platform} platform, which runs configured actions or commands (or stops the host that runs Home Assistant).`,
      );
    }
  }

  private isOldGroup(entityId: string): boolean {
    return domainOf(entityId) === "group";
  }

  private isForwardingGroup(entityId: string): boolean {
    return (
      this.platforms?.get(entityId) === "group" &&
      !this.isOldGroup(entityId) &&
      !NON_FORWARDING_GROUP_DOMAINS.has(domainOf(entityId))
    );
  }

  /** Replaces old-style groups by their members, with Home Assistant's own expansion. */
  private async *expandOldGroups(ids: Iterable<string>): Gen<Set<string>> {
    const pool = new Set<string>();
    const groups: string[] = [];
    for (const id of ids) {
      if (this.isOldGroup(id)) groups.push(id);
      else pool.add(id);
    }
    if (groups.length === 0) return pool;
    const result = yield* this.ws({ type: "extract_from_target", target: { entity_id: groups }, expand_group: true });
    for (const member of this.referenced(result)) pool.add(member);
    return pool;
  }

  private referenced(result: HaWsResult): string[] {
    const list = result.success && isRecord(result.result) ? result.result.referenced_entities : undefined;
    if (!Array.isArray(list) || !list.every((e) => typeof e === "string")) {
      return this.refuseUnreadable("The entities of a target (extract_from_target)");
    }
    return (list as string[]).map((e) => e.toLowerCase());
  }

  /**
   * Classifies every entity a service would act on, runs the scripts, automations and scenes among them (by the
   * effective service), and reads the members of forwarding groups.
   */
  private async *actOn(ids: Iterable<string>, es: string, level: number): Gen<void> {
    const pool = yield* this.expandOldGroups(ids);
    for (const id of pool) {
      this.classify(id);
      const domain = domainOf(id);
      // A forwarding group has no action of its own: its members are judged instead.
      if (domain === "button" && !this.isForwardingGroup(id)) this.buttons.add(id);
      if (domain === "script" && (es === "turn_on" || es === "toggle")) yield* this.runScript(id, level + 1);
      else if (domain === "automation" && es === "trigger") yield* this.runAutomation(id, level + 1);
      else if (domain === "scene" && es === "turn_on") yield* this.runScene(id, level + 1);
      if (this.isForwardingGroup(id)) yield* this.runGroup(id, es, level);
    }
  }

  /** One registry read for the buttons acted on, judged by the button rule. */
  private async *flushButtons(): Gen<void> {
    if (this.buttons.size === 0) return;
    const ids = [...this.buttons];
    this.buttons.clear();
    const result = yield* this.ws({ type: "config/entity_registry/get_entries", entity_ids: ids });
    if (!result.success || !isRecord(result.result)) return this.refuseUnreadable("The registry entries of the buttons");
    for (const id of ids) {
      const entry = result.result[id];
      if (!isRecord(entry)) {
        throw refusal("button rule", `the button ${id} has no entity registry entry, so it cannot be told from a button that reboots or shuts down a host.`);
      }
      if (entry.entity_category === "config") {
        throw refusal("button rule", `the button ${id} is in the config category, where reboot and shutdown buttons of hosts and NAS devices sit.`);
      }
      if (entry.device_class === "restart" || entry.original_device_class === "restart") {
        throw refusal("button rule", `the button ${id} has the device class restart.`);
      }
    }
  }

  // -- Findings --------------------------------------------------------------------------------

  async *processCall(call: CallFinding, level: number): Gen<void> {
    const platforms = yield* this.loadPlatforms();
    const domain = call.domain;
    const es = domain === "scene" && call.service === "apply" ? "turn_on" : call.service;

    if (isScriptKeyRoute(call)) yield* this.runScriptKey(call.service, level + 1);

    const strict: string[] = [];
    const named = call.entityPieces.filter((p) => p !== "all" && p !== "none");
    strict.push(...named);
    const mediaAll = call.membersAreMedia && call.members.includes("all");
    strict.push(...call.members.filter((p) => !(call.membersAreMedia && (p === "all" || p === "none"))));
    for (const piece of strict) {
      if (!platforms.has(piece)) this.classify(piece); // throws: unknown
    }

    // A group named in the target's entity_id is expanded by Home Assistant like any other target, and what it
    // yields is filtered to the service's own domain. Groups found anywhere else (the scan, a member field, a
    // scene) are replaced by their members whatever the domain (see actOn).
    const namedGroups = named.filter((p) => this.isOldGroup(p));
    const pool = new Set<string>([
      ...strict.filter((p) => !namedGroups.includes(p)),
      ...call.scanned.filter((s) => platforms.has(s)),
    ]);
    if (mediaAll) for (const id of platforms.keys()) if (domainOf(id) === "media_player") pool.add(id);

    // Targets Home Assistant expands, filtered to the service's own domain as Home Assistant does.
    const target: Record<string, string[]> = {};
    if (namedGroups.length > 0) target.entity_id = namedGroups;
    for (const key of ["device_id", "area_id", "floor_id", "label_id"] as const) {
      if (call.others[key].length > 0) target[key] = call.others[key];
    }
    if (Object.keys(target).length > 0) {
      const result = yield* this.ws({ type: "extract_from_target", target, expand_group: true });
      for (const id of this.referenced(result)) {
        if (domain === "homeassistant" || domainOf(id) === domain || named.includes(id)) pool.add(id);
      }
    }
    if (call.entityPieces.includes("all") && domain !== "homeassistant") {
      for (const id of platforms.keys()) if (domainOf(id) === domain) pool.add(id);
    }

    yield* this.actOn(pool, es, level);
    yield* this.flushButtons();
  }

  async *processScene(scene: SceneFinding, level: number): Gen<void> {
    yield* this.loadPlatforms();
    yield* this.actOn([scene.entity], "turn_on", level);
    yield* this.flushButtons();
  }

  async *processDevice(device: DeviceFinding, level: number): Gen<void> {
    yield* this.loadPlatforms();
    let entity = device.entity;
    if (!isEntityId(entity)) {
      const registry = yield* this.loadRegistry();
      const resolved = registry.get(entity);
      if (resolved === undefined) {
        throw refusal("unknown entity", `the device step's entity ${entity} is not in the entity registry (${device.where}), so what it acts on cannot be classified.`);
      }
      entity = resolved;
    }
    if (domainOf(entity) !== device.domain) {
      throw refusal(
        "device action",
        `the device step at ${device.where} has domain ${device.domain} but its entity ${entity} is of domain ${domainOf(entity)}, so what it does cannot be determined.`,
      );
    }
    yield* this.actOn([entity], device.service, level);
    yield* this.flushButtons();
  }

  /** The entry point for a `trigger_automation`: the automation's own actions are what runs. */
  async *triggerAutomation(entityId: string): Gen<void> {
    yield* this.loadPlatforms();
    yield* this.actOn([entityId], "trigger", 0);
    yield* this.flushButtons();
  }
}

// ---------------------------------------------------------------------------------------------
// Driving a walk over the WebSocket helper
// ---------------------------------------------------------------------------------------------

/**
 * Runs a walk on one connection. The walk is a generator that yields each command it needs and receives the
 * result; every result's `check` resumes it and appends the next command to the list the helper is reading. A
 * walk that yields nothing never opens the connection. A refusal thrown inside the walk stops the exchange and
 * reaches the caller unchanged; any other failure becomes a refusal that says the check could not run.
 */
export async function drive(env: Env, walk: Gen<void>): Promise<void> {
  try {
    const first = await walk.next();
    if (first.done) return;
    const commands: HaWsCommand[] = [];
    let finished = false;
    const add = (request: WsRequest): void => {
      const command: HaWsCommand = {
        message: request.message,
        check: async (result) => {
          const next = await walk.next(result);
          if (next.done) finished = true;
          else add(next.value);
        },
      };
      if (request.allowErrorCodes) command.allowErrorCodes = request.allowErrorCodes;
      commands.push(command);
    };
    add(first.value);
    await haWsCommands(env, commands);
    if (!finished) throw new Error("the check ended before it was complete");
  } catch (error) {
    if (error instanceof PolicyRefusal) throw error;
    const cause = error instanceof Error ? error.message : String(error);
    if (/timed out|did not answer within/.test(cause)) {
      throw new PolicyRefusal(
        "Refused by this server's safety policy: the check of what this request would run ran out of time " +
          `(${cause}) so it was not sent. Nothing was sent to change anything and nothing was retried. ` +
          "The policy is described in the README, under Safety policy.",
      );
    }
    throw checkFailed(cause.endsWith(".") ? cause : `${cause}.`);
  }
}
