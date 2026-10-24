# Architecture decision records

Each record states the context, the options considered, the decision and its consequences, for a reader who was not there. Every record has status Accepted, except where the Status column says otherwise; the Date column gives the date of each. A record is not rewritten when the code moves on: a factual correction or a dated amendment is added to it instead, and a decision that is replaced gets a new record that says so.

[`plan.md`](../../plan.md) is the original design note, kept for history. Where it and a record disagree, the record and the code are right.

| No. | Title | Date | Status | Summary |
| --- | --- | --- | --- | --- |
| [0001](0001-test-isolation.md) | Isolate the test runtime from real credentials and the network | 2026-10-22 | Accepted | Tests use their own Wrangler config so a real `.dev.vars` is never read, a canary file proves it, and an unmocked `fetch` fails the test. |
| [0002](0002-home-assistant-rest-client.md) | Home Assistant REST client: timeout, error shape and path confinement | 2026-10-22 | Accepted | One helper for every REST call: 10 s timeout, no retry, no redirects, errors that carry Home Assistant's text, paths confined to `/api/`. A 403 has its own message about the address ban, and `HaError.sent` separates "never sent" from "no answer" (dated amendment). |
| [0003](0003-websocket-command-sequence.md) | Run Home Assistant WebSocket commands as one sequential sequence | 2026-10-22 | Accepted | One connection and one login per tool call, commands sent one at a time, with allowed error codes and a check before the next command. |
| [0004](0004-json-response-and-per-request-server.md) | Plain JSON responses and a new server and transport per request | 2026-10-22 | Accepted | Stateless, JSON-mode responses, and a fresh server and transport for every request. |
| [0005](0005-http-edge-status-contract.md) | Status codes and check order at the HTTP edge | 2026-10-22 | Accepted | Path, then method (405), then Origin (403), then a constant-time bearer check (401); empty bodies. Notes the statuses the transport adds, and (dated amendment) that the edge reads the body once and refuses JSON-RPC batches. |
| [0006](0006-origin-allowlist.md) | Origin allowlist | 2026-10-22 | Accepted | A request without an `Origin` header is allowed; otherwise only `claude.ai`, `anthropic.com` and their subdomains over HTTPS. |
| [0007](0007-read-and-service-tool-design.md) | Entity, service and history tools: paging, output shape, history cap | 2026-10-22 | Accepted | Offset paging for entities, compact row shapes, `call_service` marked destructive, history capped at the newest 500 states. |
| [0008](0008-registry-search-tool.md) | Registry search tool: joins, filters, cap and output shape | 2026-10-22 | Accepted | Entity, device and area registries joined in the Worker over one connection; filters; 200-row cap with a total. |
| [0009](0009-automation-read-trigger-and-check-tools.md) | Automation read, trigger and config-check tools | 2026-10-22 | Accepted | `skip_condition` inverted to default false, state checked before a trigger, a WebSocket fallback for reading package automations. |
| [0010](0010-dashboard-save-safety.md) | Dashboard tools: how a dashboard save is made safe | 2026-10-22 | Accepted | Target resolved from the dashboard list, YAML and partial configs refused, previous config read first and returned, every failure reports how far it got. |
| [0011](#number-0011-is-unused) | Not used | | | See the note below. |
| [0012](0012-automation-write-safety.md) | Automation write tools: how an automation save or delete is made safe | 2026-10-22 | Accepted | Loose schemas, body `id` dropped, collision guard against the registry and states, previous config returned, confirmation polling, staged failure reports, 20 s write timeout and a 55 s budget. |
| [0013](0013-smoke-script.md) | Smoke script for a running Worker | 2026-10-22 | Accepted | A read-only Node script that checks a running Worker, with separate typechecking so Node types stay out of the Worker. |
| [0014](0014-project-skeleton-and-toolchain.md) | Project skeleton, toolchain pins and test harness | 2026-10-22 | Accepted | A hand-pinned skeleton instead of the scaffolder, exact pins, the vitest plugin as the test harness. |
| [0015](0015-tool-registration-annotations-and-results.md) | Tool registration, annotations and result format | 2026-10-22 | Accepted | `registerTool` with annotations on every tool, text-only compact JSON results, errors carry the recovery text. |
| [0016](0016-safety-policy.md) | Safety policy: blocking system actions on every route the server can cause | 2026-10-22 | Accepted | One policy module with a blocked-service list, a platform denylist (template, command_line, universal, wake_on_lan, panasonic_viera, hassio, portainer, proxmoxve), a dispatch list and a legacy-notify allowlist, and a walker that follows scripts, scenes, automations, blueprints, groups and area targets on one WebSocket connection plus up to 10 REST reads before any acting call; fails closed when the WebSocket is down. |
| [0017](0017-delete-confirmation.md) | Delete confirmation: a one-time code on the owner's phone | 2026-10-23 | Accepted | Deleting an automation takes two calls: the first sends an eight-digit code through a notify service named in a new setting and returns a keyed challenge; the second needs the challenge and the code. No stored state; the key is derived from the Home Assistant token; the challenge is bound to the automation's id and current config; leak routes and residuals declared. The HTTP edge parses each body once and refuses JSON-RPC batches (dated amendment to 0005), and the capture rule gains the companion app notification prefix and the server's own notify call is checked against the allowlist (dated amendment to 0016). |
| [0018](0018-node-24-toolchain.md) | Node 24 toolchain and no package install scripts | 2026-10-23 | Accepted | Build and test tools move to Node 24 LTS (`.nvmrc`, `engines`, `@types/node` 24.19.2); npm's install scripts for esbuild, workerd and fsevents stay denied, since everything passes without them. The deployed Worker runs on Cloudflare's workerd, not Node, so nothing on the internet changes. |
| [0019](0019-oauth-sign-in.md) | OAuth sign-in for the claude.ai connector, with the owner's password as the only way in | 2026-10-24 | Proposed | OAuth on the Worker with `@cloudflare/workers-oauth-provider` 1.2.4 and a KV namespace: CIMD-only client registration, an owner-password page throttled by the Rate Limiting binding, one-hour access and 30-day refresh tokens that a password change revokes, and the static bearer kept for Claude Code. |

## Number 0011 is unused

Number 0011 was set aside for a possible second dashboard record. The dashboard design fitted in 0010, so 0011 was never written. Numbers are not reused or renumbered, so the gap stays.

## Format

```
# NNNN. Title
Date: YYYY-MM-DD
Status: Accepted
## Context
## Options considered
## Decision
## Consequences
```

Longer records add sections such as a scenario walk-through, residual risks and a verification plan. Citations of the form `ha:path:line` name files in Home Assistant Core 2026.10.2, `fw:path:line` name files in the MCP TypeScript SDK 1.32.1, and `wop:path:line` name files in the npm package `@cloudflare/workers-oauth-provider` 1.2.4 (the published tarball).
