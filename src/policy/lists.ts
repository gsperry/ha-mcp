/**
 * The data of the safety policy. Every entry is lower case; requests are trimmed and lower-cased before they are
 * compared. See docs/adr/0016-safety-policy.md for why each entry is here.
 */

/** Domains whose every service is refused, because they register one service per configured entry or are system-wide. */
export const BLOCKED_DOMAINS: ReadonlySet<string> = new Set([
  "hassio",
  "backup",
  "shell_command",
  "python_script",
  "profiler",
  "debugpy",
]);

/** Single services that are refused, written `domain.service`. */
export const BLOCKED_SERVICES: ReadonlySet<string> = new Set([
  "homeassistant.restart",
  "homeassistant.stop",
  "homeassistant.set_location",
  "recorder.purge",
  "recorder.purge_entities",
  "recorder.disable",
  "update.install",
  "cloud.remote_disconnect",
  "synology_dsm.reboot",
  "synology_dsm.shutdown",
  "portainer.recreate_container",
  "system_bridge.power_command",
  "group.set",
  "scene.create",
  "sql.query",
  "media_extractor.play_media",
]);

/** Services that hand free text to Assist or to an outside assistant. Refused by name. */
export const DISPATCH_SERVICES: ReadonlySet<string> = new Set([
  "conversation.process",
  "google_assistant_sdk.send_text_command",
  "alexa_devices.send_text_command",
]);

/** Entity platforms that run configured actions or commands, or stop the host. A call acting on one is refused. */
export const DENIED_PLATFORMS: ReadonlySet<string> = new Set([
  "template",
  "command_line",
  "universal",
  "wake_on_lan",
  "panasonic_viera",
  "hassio",
  "portainer",
  "proxmoxve",
]);

/**
 * Services whose media-player field is read strictly: the field's value is passed on as the `entity_id` of
 * `media_player.play_media`, so it is classified as a member field and `all` means every media player.
 * Keyed by `domain.service`; a legacy `tts` say service is matched by `mediaPlayerField`.
 */
const MEDIA_PLAYER_FIELDS: Readonly<Record<string, string>> = {
  "tts.speak": "media_player_entity_id",
  "camera.play_stream": "media_player",
  "google_assistant_sdk.send_text_command": "media_player",
};

/** Name of the media-player field of a service, or undefined when it has none. */
export function mediaPlayerField(domain: string, service: string): string | undefined {
  const named = MEDIA_PLAYER_FIELDS[`${domain}.${service}`];
  if (named !== undefined) return named;
  // Every other service of the tts domain is a legacy say service (its name is configurable).
  if (domain === "tts" && service !== "speak" && service !== "clear_cache") return "entity_id";
  return undefined;
}

/** Services that carry entities throughout their data. */
export const INLINE_ENTITY_SERVICES: ReadonlySet<string> = new Set(["scene.apply", "media_player.join"]);

/** The services of the legacy `notify` domain that are not legacy: an entity service, classified like any other. */
export const NOTIFY_ENTITY_SERVICE = "send_message";

/** Event types that start with this prefix are reserved for Home Assistant itself. */
export const RESERVED_EVENT_PREFIX = "homeassistant_";

/** Event types an automation written through the server must not wait for: they carry every service call's data. */
export const CAPTURE_EVENT_TYPES: ReadonlySet<string> = new Set(["call_service", "*"]);

/** Event types that start with this prefix are the companion app's notification events, which can carry notification text. */
export const CAPTURE_EVENT_PREFIX = "mobile_app_notification";

/**
 * Device-action domains with a known service. `toggle` domains call `<domain>.<type>` for turn_on, turn_off and
 * toggle; `own` domains call a service of their own domain.
 */
export const DEVICE_TOGGLE_DOMAINS: ReadonlySet<string> = new Set(["light", "switch", "fan", "humidifier", "remote"]);
export const DEVICE_OWN_DOMAINS: ReadonlySet<string> = new Set([
  "alarm_control_panel",
  "climate",
  "cover",
  "lock",
  "number",
  "select",
  "text",
  "vacuum",
  "water_heater",
]);
export const DEVICE_BUTTON_DOMAIN = "button";

/** Group entities of these domains forward no service and are never read. */
export const NON_FORWARDING_GROUP_DOMAINS: ReadonlySet<string> = new Set(["sensor", "binary_sensor", "event"]);

/** Bounds of one check (the request is level 0; a node at this level or deeper is refused). */
export const MAX_LEVEL = 6;
export const MAX_NODES = 20;
export const MAX_WS_COMMANDS = 40;
export const MAX_REST_READS = 10;
export const MAX_STEPS = 1000;
/** Nesting of action lists inside one config. */
export const MAX_NESTING = 20;
/** Time allowed for the whole check, REST reads included (the WebSocket helper's limit). */
export const WALK_TIMEOUT_MS = 10_000;
