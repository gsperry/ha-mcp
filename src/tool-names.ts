/**
 * Names of every tool the server registers. Later additions append here so that
 * scripts and tests can compare against what `tools/list` returns. This module
 * has no imports so that Node can load it directly, without a bundler.
 */
export const TOOL_NAMES = [
  "list_entities",
  "get_entity",
  "list_services",
  "call_service",
  "get_history",
  "search_registry",
  "list_automations",
  "get_automation",
  "trigger_automation",
  "check_config",
  "upsert_automation",
  "delete_automation",
  "list_dashboards",
  "get_dashboard",
  "save_dashboard",
] as const;
