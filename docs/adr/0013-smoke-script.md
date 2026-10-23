# 0013. Smoke script for a running Worker

Date: 2026-10-22
Status: Accepted

## Context

Unit tests run against a local test harness with mocked Home Assistant calls, so they cannot show that a built and deployed Worker answers real requests. The owner needs a short command that checks a running Worker (local `wrangler dev` or deployed) end to end, and that is safe to run against a real house.

## Options considered

1. A curl one-liner in the README. Rejected: it cannot compare the tool list against the code, and it does not report pass or fail per step.
2. A script run through `tsx` or `ts-node`. Rejected: an extra dependency for something Node 22 does natively.
3. A vitest test that talks to a URL. Rejected: the test suite must never touch the network or real credentials.
4. Import `TOOL_NAMES` from `src/server.ts`. Rejected: that module imports the SDK and every tool module through `.js` specifiers, which Node cannot resolve for `.ts` sources. The list now lives in `src/tool-names.ts`, which has no imports; `src/server.ts` re-exports it, so existing imports keep working.
5. Take the URL and token from a config file or flags. Rejected: files invite committed secrets, and flags leak into shell history and process listings.

## Decision

- `scripts/smoke.ts` runs under Node 22 type stripping (`node scripts/smoke.ts`, no flags on 22.21), so no runner dependency is needed. It uses only `.ts` import specifiers and erasable TypeScript syntax.
- It is typechecked by `tsconfig.scripts.json`, which covers `scripts/` and `src/tool-names.ts` with the Node types from `@types/node`, a dev-only dependency pinned exactly to 22.20.5.
- Node types are kept out of the Worker typecheck. Installing `@types/node` would otherwise leak into it, because the test tooling's type files carry `/// <reference types="node" />`. So `tsconfig.json` covers `src/` only, with `types: ["@cloudflare/workers-types"]`, and `tsconfig.test.json` covers `src/`, `test/` and `vitest.config.ts` with the test-plugin types (which do pull in Node types). `npm run typecheck` runs both, and `npm run check` runs that plus `typecheck:scripts`. Code in `src/` that uses names such as `__dirname` or `NodeJS.ProcessEnv` fails the first typecheck. This does not cover every global: the Workers types themselves declare some Node-style names (for example `process` and `Buffer` as untyped values), so those still typecheck in `src/`.
- Inputs come from the environment only: `SMOKE_URL` and `MCP_BEARER_TOKEN` are required; `SMOKE_AUTOMATION_ID` is optional. Output redacts the token if an error message happens to contain it.
- Steps, all read-only: `initialize`; `tools/list`, asserting the names equal `TOOL_NAMES`; `list_entities` with `domain: "automation"` and `limit: 5`; `get_automation` when `SMOKE_AUTOMATION_ID` is set. Each step prints one `PASS` or `FAIL` line. A step failure does not stop later steps, so one run shows everything that is wrong, with one exception: a 401 on any step (in practice the first, `initialize`) stops the run and reports the remaining steps as `SKIP`, because every further request would repeat a token the Worker has already rejected. (That 401 always comes from the Worker's own bearer check; a Home Assistant rejection arrives as a tool error inside a 200 and shows as a `FAIL`.)
- Exit codes: 0 when every step passes, 1 when any step fails, 2 when a required variable is missing.
- Requests send `Content-Type: application/json` and `Accept: application/json, text/event-stream`, because the transport answers 415 and 406 without them (see the amendment to 0005); the server answers in JSON mode, and the script also accepts a single event-stream data frame.

## Consequences

- A run against a Worker with unreachable Home Assistant passes the first two steps and fails the Home Assistant steps with the tool's error text, which is the intended way to tell a Worker problem from a Home Assistant problem.
- The tool list lives in one place; adding a tool means appending to `src/tool-names.ts`, or the smoke script and tests fail.
- The script never writes to Home Assistant, but it does read real data when pointed at a real Worker, and each Home Assistant call counts against Home Assistant's login attempt rules if the token is wrong. Run it once, not in a loop.
- Passing against a deployed Worker is real-environment evidence that this repository cannot produce on its own.

## Amendment, 2026-10-23: Node 24

The toolchain moved to Node 24: `.nvmrc` is `24`, `engines.node` is `>=24`, and `@types/node` is 24.19.2. See [0018](0018-node-24-toolchain.md). The Node 22 statements above describe the toolchain as it was.
