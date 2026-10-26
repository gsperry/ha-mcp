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
    const { OAUTH_KV, SIGN_IN_LIMITER, ...plain } = bindings;
    expect(plain).toEqual({
      HA_URL: "https://ha.test",
      HA_TOKEN: "test-ha-token",
      MCP_BEARER_TOKEN: "test-bearer-token",
      OWNER_PASSWORD: "test-owner-password-0123456789abcdef",
    });
    // The two OAuth bindings are objects, not values; the exact key set is what matters.
    expect(Object.keys(bindings).sort()).toEqual(
      ["HA_TOKEN", "HA_URL", "MCP_BEARER_TOKEN", "OAUTH_KV", "OWNER_PASSWORD", "SIGN_IN_LIMITER"],
    );
    expect(typeof (OAUTH_KV as KVNamespace).get).toBe("function");
    expect(typeof (SIGN_IN_LIMITER as RateLimit).limit).toBe("function");
  });
});
