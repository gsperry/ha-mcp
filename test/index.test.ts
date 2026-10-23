import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker", () => {
  it("returns 404 for unknown paths", async () => {
    const res = await SELF.fetch("https://example.com/");
    expect(res.status).toBe(404);
  });
});
