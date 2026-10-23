import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// The test harness adds its own bindings with this prefix; they are not ours.
const HARNESS_PREFIX = "__VITEST_POOL_WORKERS_";

describe("test environment", () => {
  it("holds exactly the expected bindings with the fake values", () => {
    const bindings = Object.fromEntries(
      Object.entries(env as unknown as Record<string, unknown>).filter(
        ([key]) => !key.startsWith(HARNESS_PREFIX),
      ),
    );
    expect(bindings).toEqual({
      HA_URL: "https://ha.test",
      HA_TOKEN: "test-ha-token",
      MCP_BEARER_TOKEN: "test-bearer-token",
    });
  });
});
