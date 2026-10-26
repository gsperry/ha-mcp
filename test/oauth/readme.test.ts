import { describe, expect, it } from "vitest";
import readme from "../../README.md?raw";

const rows = readme.split("\n").filter((line) => line.startsWith("|"));
const row = (start: string): string | undefined => rows.find((line) => line.startsWith(start));

describe("the README's OAuth text", () => {
  it("the troubleshooting tables have the sign-in page statuses and the invalid_token 401", () => {
    for (const start of ["| 400 (page)", "| 401 (page)", "| 403 (empty)", "| 429 (page)", "| 502 (page)", "| 503 (page)", '| 401 with `error="invalid_token"`', "| 503 with `Retry-After`"]) {
      expect(row(start), start).toBeDefined();
    }
    expect(row("| 401 (page)")).toContain("That password was not accepted.");
    expect(row("| 429 (page)")).toMatch(/wait a minute/i);
  });

  it("names the OAuth secret and says the four requirements and the rollback", () => {
    expect(row("| `OWNER_PASSWORD`")).toBeDefined();
    expect(readme).toContain("## Signing in with OAuth");
    expect(readme).toMatch(/all four of these are present/);
    expect(readme).toContain("global_fetch_strictly_public");
    expect(readme).toMatch(/the rate-limit binding/);
  });

  it("presents rotating the bearer token as optional, and the password as the way to end every OAuth session", () => {
    const rotation = readme.slice(readme.indexOf("## Token rotation"), readme.indexOf("## Tools"));
    expect(rotation).toMatch(/`MCP_BEARER_TOKEN`: .*Rotating it is optional/);
    expect(rotation).toMatch(/`OWNER_PASSWORD`: .*Every OAuth session ends/);
    expect(rotation).not.toMatch(/must rotate|you must/i);
  });
});
