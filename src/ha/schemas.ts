import { z } from "zod";

/**
 * The automation config as the tools accept it. Every object here is loose:
 * the MCP SDK hands a tool handler the parsed output of its schema, a plain
 * object schema drops every key it does not declare, and Home Assistant
 * replaces the whole stored automation on a save, so a dropped key is lost for
 * good. Nothing here has a default, so a key the caller did not send is never
 * added. The shape follows what Home Assistant accepts, and no more: it
 * validates the rest when the config is saved and its message is better than a
 * copy of its rules.
 */

/** One trigger, condition or action: any object, every key kept. */
const looseRecord = z.looseObject({});

/** `cv.string` in Home Assistant turns numbers and booleans into strings, so any scalar is allowed (null is not). */
const scalar = z.union([z.string(), z.number(), z.boolean()]);

/** Triggers and actions: a single object or a list of them. Null is allowed because a stored config can carry it. */
const recordOrList = z.union([z.null(), looseRecord, z.array(looseRecord)]);

/** Conditions also accept a template string, alone or inside the list. */
const conditions = z.union([z.null(), z.string(), looseRecord, z.array(z.union([z.string(), looseRecord]))]);

export const AutomationConfig = z
  .looseObject({
    alias: scalar.optional().describe("The automation's name."),
    description: scalar.optional(),
    mode: z.enum(["single", "restart", "queued", "parallel"]).optional(),
    triggers: recordOrList.optional().describe("One trigger object or a list of them."),
    trigger: recordOrList.optional().describe("The older spelling of `triggers`."),
    conditions: conditions.optional().describe("A condition object, a template string, or a list of either."),
    condition: conditions.optional().describe("The older spelling of `conditions`."),
    actions: recordOrList.optional().describe("One action object or a list of them."),
    action: recordOrList.optional().describe("The older spelling of `actions`."),
    use_blueprint: z.looseObject({}).optional().describe("A blueprint automation: {path, input}. It has no triggers or actions of its own."),
  })
  .describe(
    "The complete automation config as get_automation returned it (variables, max, trace, trigger_variables and any other key " +
      "included). Unknown keys at every level are sent to Home Assistant unchanged.",
  );

export type AutomationConfigInput = z.infer<typeof AutomationConfig>;
