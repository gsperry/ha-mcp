import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the project's own tests; stray test files elsewhere in the checkout
    // must not be collected.
    include: ["test/**/*.test.ts"],
    // Puts a canary .dev.vars in the project root for the run (see the file).
    globalSetup: ["./test/setup/dev-vars-canary.ts"],
  },
  plugins: [
    cloudflareTest({
      // A config in its own directory: Wrangler looks for .dev.vars next to the
      // config file, so a real secrets file in the project root is never loaded.
      wrangler: { configPath: "./test/config/wrangler.toml" },
      miniflare: {
        bindings: {
          HA_URL: "https://ha.test",
          HA_TOKEN: "test-ha-token",
          MCP_BEARER_TOKEN: "test-bearer-token",
        },
      },
    }),
  ],
});
