# 0006. Origin allowlist

Date: 2026-10-22
Status: Accepted

## Context

Browsers attach an `Origin` header to cross-origin requests, and a malicious web page could try to drive a locally or publicly reachable MCP endpoint from a visitor's browser. The SDK transport can validate `Origin`, but only through options it marks deprecated and that are off by default. Server-to-server clients, including the connector service this Worker is built for and command-line clients, normally send no `Origin` at all.

## Options considered

1. No Origin check, relying on the bearer token alone. Rejected: a cheap extra layer against browser-driven misuse.
2. Require an `Origin`. Rejected: non-browser clients send none and would be locked out.
3. The transport's built-in `allowedOrigins`. Rejected: exact strings only (no wildcard subdomains), and deprecated.
4. Allow any `localhost` origin for development tools. Rejected: it widens the surface for the sake of a browser inspector the server does not target; local testing uses clients that send no Origin.

## Decision

A request without an `Origin` header is allowed. A request with one is allowed only if it matches `https://claude.ai`, `https://anthropic.com` or any subdomain of either (`https://*.claude.ai`, `https://*.anthropic.com`). The match is a full-string pattern: the scheme must be `https`, there is no port or path, and look-alikes such as `https://claude.ai.evil.example` or `https://notclaude.ai` fail. The literal `Origin: null` fails. Any other value gets a 403 before the bearer is examined.

## Consequences

- A new first-party hostname outside these domains needs a code change.
- The Origin check is not authentication: a non-browser client can send any header. The bearer token is the authentication.
- Because the check precedes the bearer check, a disallowed Origin learns nothing about whether its token was right.
