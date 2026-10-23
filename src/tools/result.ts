import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Wraps a JSON-serialisable value as a tool result. Only text content is
 * returned: every result here is already an object, and sending it a second
 * time as structured content would double the tokens the model reads.
 */
export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** True for a plain JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
