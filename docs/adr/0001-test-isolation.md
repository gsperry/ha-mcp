# 0001. Isolate the test runtime from real credentials and the network

Date: 2026-10-22
Status: Accepted

## Context

Tests run in workerd through `@cloudflare/vitest-plugin` 1.4.6 (wrangler 4.151.3). The plugin is given a Wrangler config path, and Wrangler loads a `.dev.vars` file that sits next to that config. A developer who has a real `.dev.vars` in the project root (the file used for `wrangler dev`, holding a real Home Assistant token) could therefore have it merged into the test `env`, and an unmocked outbound `fetch` could reach the real Home Assistant instance. A bad token sent repeatedly is also a failed login for Home Assistant, which can lead to an IP ban.

We checked whether the leak is real. With a dummy `.dev.vars` in the project root (`HA_TOKEN=<other value>` plus an extra `LEAK_CANARY=1`), created for the experiment and removed afterwards, a test that lists the keys of the test `env` saw `LEAK_CANARY` when the plugin pointed at `./wrangler.toml`. The leak is real with this plugin version. Explicit `miniflare.bindings` already win over a same-named key in the file (the fake `HA_TOKEN` was kept), so only extra keys leaked; but any future binding that the config does not set explicitly would silently take the real value.

`cloudflare:test` in this plugin version exports no fetch mock, so outbound requests must be intercepted with `vi.spyOn(globalThis, "fetch")`.

The test run also collected test files from anywhere in the checkout, because vitest's default include matches every `*.test.ts`.

## Options considered

1. Keep `wrangler.toml` as the plugin's config and rely on explicit bindings. Rejected: the experiment shows extra keys still leak, and unset bindings would fall back to the real file.
2. Set `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false`. Rejected: in wrangler 4.151.3 this variable only controls the `.env` fallback that is used when no `.dev.vars` is found; it does not stop `.dev.vars` from loading, so it would not address the leak.
3. A separate Wrangler config for tests in its own directory, `test/config/wrangler.toml`. Chosen (see below).
4. Have the test setup unconditionally write and delete a dummy `.dev.vars` in the project root. Rejected: it would overwrite or delete a developer's real file. Refined: the setup writes the canary only when no file exists and removes only what it created (see Decision).

## Decision

- `vitest.config.ts` points the plugin at `test/config/wrangler.toml`, a copy of the relevant settings (name, entry point, compatibility date and flags). Wrangler looks for `.dev.vars` next to the config file, so the project-root file is never read. The bindings the tests see are the fake values set in `vitest.config.ts`. Repeating the experiment with this config, the dummy file's extra key no longer appears in the test `env`.
- A vitest `globalSetup` (`test/setup/dev-vars-canary.ts`) writes a canary `.dev.vars` (extra key `LEAK_CANARY` and a different `HA_TOKEN`) into the project root for the run if none exists, and deletes it afterwards, including on interrupt. The file starts with a marker comment, so a canary left behind by a killed run is recognised as the setup's own and replaced and removed, while any other existing file is left alone. An existing file is never modified or removed; a developer's real file then serves as the canary. This keeps the isolation test meaningful on a clean checkout.
- `test/env.test.ts` asserts that the test `env` holds exactly `HA_URL`, `HA_TOKEN` and `MCP_BEARER_TOKEN`, with the fake values (ignoring the harness's own bindings, which share one prefix). It fails if a real file leaks an extra key or overrides a value.
- `test/helpers/fetch.ts` exports `installFetchSpy()`, which replaces `globalThis.fetch` for each test, records requests (as clones, so a handler reading a body does not break later inspection), serves queued or fallback responses and throws on any request with no handler. Because code under test may catch that error (the MCP SDK turns a thrown tool-handler error into an error result), each unmocked request is also recorded and the test fails in `afterEach` if there was one, so a swallowed call is still reported. `test/fetch-helper.test.ts` proves that an unmocked call fails.
- `vitest.config.ts` restricts `include` to `test/**/*.test.ts`, so stray test files elsewhere in the checkout are not collected.
- `package.json`: `engines.node` becomes `>=22.12` (the minimum vitest 5 and vite 8 need), and a `fast` script (`npm run typecheck && npm test`) is added. The existing scripts are unchanged.

## Consequences

- The setup file runs in Node, not in the Worker runtime, and at the time of this decision Node type definitions were not installed (adding them would have put Node globals into the Workers type check), so it carries `@ts-nocheck`.
- Amendment, 2026-10-22: `@types/node` is now a dev dependency, kept out of the Worker typecheck by separate tsconfig files (see 0013). The setup file still carries `@ts-nocheck`; it was not revisited. It can be removed and the file typechecked under `tsconfig.test.json` as a follow-up.
- If `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` were set, wrangler would merge process environment variables into the bindings; the exact-key-set test would detect it.
- The Wrangler settings that matter to tests exist in two files (`wrangler.toml` and `test/config/wrangler.toml`); a change to the compatibility date or flags must be mirrored.
- The isolation test checks the current config only; it cannot show that a future plugin version keeps the same lookup rule, but it will fail if that behaviour changes.
- The local harness is still not evidence of production Workers behaviour.
