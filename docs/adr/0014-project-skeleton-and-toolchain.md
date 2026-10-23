# 0014. Project skeleton, toolchain pins and test harness

Date: 2026-10-22
Status: Accepted

## Context

The original design note (`plan.md` as first written, before its dated correction note) told the implementer to start with `npm create cloudflare@latest ha-mcp` and its Hello World template, then add the MCP SDK, `zod` and optionally the `agents` package. It named `@cloudflare/vitest-pool-workers` for tests, and a `test/ws.test.ts` run with "miniflare".

The repository did not start that way. Its first commit already held a hand-written skeleton: `package.json` with every dependency pinned to an exact version, a `package-lock.json` whose `resolved` entries all point at the public npm registry, an `.npmrc` that names that registry, an `.nvmrc`, a `wrangler.toml`, a `vitest.config.ts` using `@cloudflare/vitest-plugin`, and a one-file test. The facts that bear on keeping it:

- The scaffolder installs unpinned `@latest` packages. Running it would create a second, parallel project that the pins and the lockfile do not describe.
- `@cloudflare/vitest-plugin` 1.4.6 is what the skeleton uses. It declares itself a prerelease, depends on a beta Miniflare, and its `cloudflare:test` module exports no fetch mock and no switch that turns the network off. The harness runs on a workerd build older than the `compatibility_date` in `wrangler.toml`. It is a convenient local runtime, not Cloudflare's production runtime.
- TypeScript 7.0.2 typechecks the tests only with `skipLibCheck: true`. Without it the test typecheck reports declaration-file errors that are not ours: Node's type definitions and the Workers type definitions declare the same globals, and miniflare's declaration files import modules that are not installed. None of the errors are in this project's files or in `@cloudflare/vitest-plugin`'s own declarations. The Worker-only typecheck (`tsconfig.json`) passes without the flag.
- vitest 5 and vite 8 need Node 22.12 or later.
- The machine-wide npm configuration of a contributor may point at a registry that does not serve public packages, so the registry has to be pinned inside the repository.

## Options considered

1. Follow the note and run `npm create cloudflare@latest`. Rejected: it replaces pinned versions with floating ones and duplicates a project that already exists.
2. Switch to `@cloudflare/vitest-pool-workers`, the package the note names. Rejected: the installed plugin already provides the Workers test runtime, the note's package is not what the lockfile resolves, and changing the harness would change nothing the tests can prove. The harness choice has one cost, recorded in 0001: no built-in fetch mock, so tests use `vi.spyOn(globalThis, "fetch")` through a small helper.
3. Add the `agents` package for stateful sessions. Rejected, see 0004: the tools are plain request and response calls, and a stateless Worker needs no Durable Object.
4. Use ranges for dependencies so that updates arrive on their own. Rejected: this server holds credentials for a house, and an unreviewed update to the SDK, the schema library or the WebSocket-facing tooling is a risk with no owner.
5. Set `skipLibCheck: false` and wait for the plugin's types to catch up. Rejected: typecheck would fail on files this repository does not own.

## Decision

- The hand-pinned skeleton stays. Every dependency, runtime and development, is pinned to an exact version, including `@types/node` (see 0013). Installs use `npm ci` from the repository's `.npmrc`, which names the public registry. A change of registry, or a new dependency without an exact pin, is not acceptable.
- Tests run through `@cloudflare/vitest-plugin`; the isolation rules for it are in 0001. Test files live under `test/`, not in a single `test/ws.test.ts`: tool tests in `test/tools`, client tests in `test/ha`, shared helpers in `test/helpers`, the test-only Wrangler config in `test/config`, the global setup in `test/setup`, and a few top-level tests (`env`, `fetch-helper`, `index`, `mcp`) directly in `test/`.
- The tsconfig files keep `skipLibCheck: true`. It can be removed from the test typecheck only when the Node and Workers global declarations no longer collide and miniflare's declarations resolve all their imports; check with `tsc -p tsconfig.test.json --skipLibCheck false`.
- `package.json` declares `engines.node` as `>=22.12` and `.nvmrc` as `22`. Scripts are `dev`, `typecheck`, `typecheck:scripts`, `test`, `bundle` (a dry run that writes nothing to Cloudflare), `smoke`, `fast` (typecheck plus tests) and `check` (everything, including the dry-run bundle).
- `wrangler.toml` carries the compatibility date and the `nodejs_compat` flag and no `vars`. `HA_URL`, `HA_TOKEN` and `MCP_BEARER_TOKEN` are Worker secrets, as the note said. Their real values never appear in the repository; tests use fake values from `vitest.config.ts`.

## Consequences

- A fresh clone reproduces the same dependency tree on every machine, and the lockfile holds no private registry host.
- Updating a dependency is a deliberate change that has to pass `npm run check`.
- The test harness is a prerelease on an older workerd. A behaviour that depends on the production runtime (WebSocket proxying, CPU limits, a compatibility date newer than the local build) cannot be shown by the tests and needs a run against a deployed Worker.
- The settings that matter to tests exist in two Wrangler files (see 0001); a change to the compatibility date must be made in both.
- `skipLibCheck` hides type errors inside dependencies' own declaration files. Errors in this repository's code are still reported.

## Correction, 2026-10-23

references to the original design note no longer cite a commit.

## Amendment, 2026-10-23: Node 24

The toolchain moved to Node 24: `.nvmrc` is `24`, `engines.node` is `>=24`, and `@types/node` is 24.19.2. See [0018](0018-node-24-toolchain.md). The Node 22 statements above describe the toolchain as it was.
