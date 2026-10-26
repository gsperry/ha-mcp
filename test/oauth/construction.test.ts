import { describe, expect, it, vi } from "vitest";
import { BEARER, ORIGIN, call, mcpList, spyConsole } from "../helpers/oauth.js";

// The library refuses to be built; the Worker must then act as if OAuth were off, without throwing.
vi.mock("@cloudflare/workers-oauth-provider", async (importOriginal) => {
  const original = await importOriginal<typeof import("@cloudflare/workers-oauth-provider")>();
  class Refusing {
    constructor() {
      throw new TypeError("refused for this test");
    }
  }
  return { ...original, OAuthAuthorizationServer: Refusing };
});

describe("a construction the library refuses", () => {
  it("is treated as OAuth off for the request, and logged as a configuration problem", async () => {
    const log = spyConsole();
    try {
      const none = await mcpList(null);
      expect(none.status).toBe(401);
      expect(none.headers.get("WWW-Authenticate")).toBe("Bearer");
      expect((await mcpList(`Bearer ${BEARER}`)).status).toBe(200);
      for (const path of ["/authorize", "/oauth/token", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
        expect((await call(new Request(`${ORIGIN}${path}`))).status, path).toBe(404);
      }
      const lines = log.text().split("\n").filter((l) => l.includes('"event":"oauth_error"')).map((l) => JSON.parse(l));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).toEqual({ event: "oauth_error", category: "configuration" });
    } finally {
      log.restore();
    }
  });
});
