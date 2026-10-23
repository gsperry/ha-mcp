import { describe, expect, it } from "vitest";
import { captureProblem } from "../../src/policy/capture";

const event = (event_type: unknown, extra: Record<string, unknown> = {}) => ({ trigger: "event", event_type, ...extra });

describe("captureProblem", () => {
  it("refuses call_service and the wildcard, in any case and with padding, alone or in a list", () => {
    for (const type of ["call_service", " Call_Service ", "*", ["my_event", "call_service"], ["*"], "\x1ccall_service"]) {
      expect(captureProblem(event(type)), JSON.stringify(type)).not.toBeNull();
    }
  });

  it("refuses event types that start with mobile_app_notification, in any case, padded, in a list or under options", () => {
    for (const type of [
      "mobile_app_notification_received",
      "mobile_app_notification_cleared",
      "mobile_app_notification_action",
      "Mobile_App_Notification_Foo",
      "  mobile_app_notification_x\t",
      ["my_event", "mobile_app_notification_received"],
      "mobile_app_notification",
    ]) {
      expect(captureProblem(event(type)), JSON.stringify(type)).toContain("notification");
    }
    expect(captureProblem({ trigger: "event", options: { event_type: "mobile_app_notification_action" } })).not.toBeNull();
    expect(captureProblem([{ triggers: [event("mobile_app_notification_cleared")] }])).not.toBeNull();
  });

  it("allows other mobile_app event types", () => {
    for (const type of ["mobile_app_other", "mobile_app", "mobile_app_notificatio", "x_mobile_app_notification"]) {
      expect(captureProblem(event(type)), type).toBeNull();
    }
  });

  it("refuses a templated or non-text event type and one that is missing", () => {
    expect(captureProblem(event("{{ 'call' ~ '_service' }}"))).toContain("templated");
    expect(captureProblem(event(["a", "{{ x }}"]))).toContain("templated");
    expect(captureProblem(event(5))).toContain("not text");
    expect(captureProblem({ trigger: "event" })).not.toBeNull();
  });

  it("allows ordinary events and other trigger kinds", () => {
    expect(captureProblem(event("my_event"))).toBeNull();
    expect(captureProblem([event("a"), { trigger: "state", entity_id: "light.a" }, { platform: "mqtt", topic: "x" }])).toBeNull();
    expect(captureProblem(undefined)).toBeNull();
  });

  it("reads the older platform key and a single trigger instead of a list", () => {
    expect(captureProblem({ platform: "event", event_type: "call_service" })).not.toBeNull();
    expect(captureProblem({ platform: "event", event_type: "x" })).toBeNull();
  });

  it("flattens nested triggers lists", () => {
    expect(captureProblem([{ triggers: [event("*")] }])).not.toBeNull();
    expect(captureProblem([{ triggers: [{ triggers: [event("call_service")] }] }])).not.toBeNull();
    expect(captureProblem([{ triggers: [event("fine")] }])).toBeNull();
  });

  it("lays options over the trigger, so the type under options is read", () => {
    expect(captureProblem({ trigger: "event", options: { event_type: "call_service" } })).not.toBeNull();
    expect(captureProblem({ trigger: "event", options: { event_type: "fine" } })).toBeNull();
  });

  it("refuses options that is not a mapping, holds platform or trigger, or repeats a top-level key", () => {
    expect(captureProblem({ trigger: "event", event_type: "x", options: "oops" })).toContain("not a mapping");
    expect(captureProblem({ trigger: "event", event_type: "x", options: [] })).toContain("not a mapping");
    expect(captureProblem({ trigger: "state", options: { platform: "event", event_type: "call_service" } })).toContain("kind");
    expect(captureProblem({ trigger: "state", options: { trigger: "event" } })).toContain("kind");
    expect(captureProblem({ trigger: "event", event_type: "a", options: { event_type: "call_service" } })).toContain("both");
  });

  it("refuses a trigger with both trigger and platform, and one that is not a mapping or has no kind", () => {
    expect(captureProblem({ trigger: "state", platform: "event", event_type: "x" })).toContain("both");
    expect(captureProblem(["text"])).toContain("not a mapping");
    expect(captureProblem({ event_type: "x" })).toContain("no readable kind");
  });
});
