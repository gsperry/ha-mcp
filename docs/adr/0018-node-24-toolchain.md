# 0018. Node 24 toolchain and no package install scripts

Date: 2026-10-23
Status: Accepted

## Context

The build and test tools (Wrangler, vitest, TypeScript and the smoke script) ran on Node 22 (`.nvmrc` `22`, `engines.node` `>=22.12`, `@types/node` 22.20.5; records 0001, 0013 and 0014). Node 22 is in maintenance; Node 24 is the current long-term-support line, with 24.22.1 its latest release. These tools run on the owner's machine, where they hold the Cloudflare login and handle the Worker's secrets, so they should run on a supported, actively patched release.

The deployed Worker does not run on Node. It runs on Cloudflare's workerd runtime, selected by `compatibility_date` and `compatibility_flags` in `wrangler.toml`, and Cloudflare patches that runtime itself. This record changes nothing that runs on the internet.

npm 11, which ships with Node 24, does not run a package's install scripts until they are approved. Three packages in the dependency tree have one: `esbuild` and `workerd` (each checks that its platform binary arrived, which npm already installs as an optional dependency) and `fsevents` (macOS file watching, used only by watch modes).

## Options considered

1. Stay on Node 22 until its end of life in April 2027. Rejected: the owner asked for the current supported line, and nothing in the project needs Node 22.
2. Node 26, the current release line. Rejected: it is not a long-term-support release yet.
3. Approve the three install scripts. Rejected: a clean `npm ci`, the full `npm run check` (typecheck, 841 tests in the workerd test runtime, and the esbuild bundle) and the smoke script all pass with none of them run, so approving them would only widen what an install may execute.

## Decision

- `.nvmrc` is `24`, `engines.node` is `>=24`, and `@types/node` is pinned to 24.19.2, the latest 24.x types.
- `package.json` records `allowScripts` with `esbuild`, `workerd` and `fsevents` set to `false`, so npm runs none of them and stops warning about them. A future dependency that needs an install script shows up as unreviewed and needs a decision.
- No runtime dependency, Worker setting or behaviour changes. The lockfile changes only for `@types/node` and its `undici-types` dependency, both from the public registry.

## Consequences

- Contributors need Node 24 (`nvm use` reads `.nvmrc`). npm on Node 22 still installs the project, but warns that the engine does not match.
- The smoke script runs under Node 24's built-in TypeScript support with no flags, as it did on Node 22.21.
- If a later version of esbuild, workerd or the test plugin ever needs its install script to work, the symptom is a missing-binary error at bundle or test time; the remedy is to approve that one package.
- Records 0001, 0013 and 0014 describe the Node 22 toolchain as it was; each carries a dated amendment that points here.
