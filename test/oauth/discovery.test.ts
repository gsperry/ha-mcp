import { beforeEach, describe, expect, it, vi } from "vitest";
import { unreachableResourceHandler } from "../../src/oauth.js";
import { installFetchSpy } from "../helpers/fetch.js";
import { BEARER, MCP_URL, ORIGIN, call, clearKv, clientDocument, mcpList, obtainTokens } from "../helpers/oauth.js";

const spy = installFetchSpy();
beforeEach(async () => {
  await clearKv();
  spy.respondAlways(clientDocument());
});

const RESOURCE_DOC = "/.well-known/oauth-protected-resource/mcp";
const AS_DOC = "/.well-known/oauth-authorization-server";

describe("the protected-resource document", () => {
  it("names the MCP URL, this origin as the authorization server, and the one scope", async () => {
    const res = await call(new Request(`${ORIGIN}${RESOURCE_DOC}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.json()).toEqual({
      resource: MCP_URL,
      authorization_servers: [ORIGIN],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
      resource_name: "ha-mcp",
    });
  });

  it("carries another origin when the request arrives under another host", async () => {
    const res = await call(new Request(`https://other.test${RESOURCE_DOC}`));
    const doc = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(doc.resource).toBe("https://other.test/mcp");
    expect(doc.authorization_servers).toEqual(["https://other.test"]);
  });

  it("answers HEAD with headers and no body, OPTIONS with 204, and other methods with 405", async () => {
    const head = await call(new Request(`${ORIGIN}${RESOURCE_DOC}`, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toContain("application/json");
    expect(await head.text()).toBe("");

    const options = await call(new Request(`${ORIGIN}${RESOURCE_DOC}`, { method: "OPTIONS" }));
    expect(options.status).toBe(204);

    const post = await call(new Request(`${ORIGIN}${RESOURCE_DOC}`, { method: "POST" }));
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("does not exist at the root URL or under the openid-configuration name", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/openid-configuration"]) {
      const res = await call(new Request(`${ORIGIN}${path}`));
      expect(res.status, path).toBe(404);
      expect(await res.text()).toBe("");
    }
  });
});

describe("the authorization server document", () => {
  it("advertises client metadata documents, S256 only, and no registration endpoint", async () => {
    const res = await call(new Request(`${ORIGIN}${AS_DOC}`));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, any>;
    // If the harness leaves the compatibility flag unset, this is the line that fails.
    expect(doc.client_id_metadata_document_supported).toBe(true);
    expect(doc.token_endpoint_auth_methods_supported).toContain("none");
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc).not.toHaveProperty("registration_endpoint");
    expect(doc.issuer).toBe(ORIGIN);
    expect(doc.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
    expect(doc.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
  });

  it("carries the request's origin when it arrives under another host", async () => {
    const doc = (await (await call(new Request(`https://other.test${AS_DOC}`))).json()) as Record<string, any>;
    expect(doc.issuer).toBe("https://other.test");
    expect(doc.authorization_endpoint).toBe("https://other.test/authorize");
    expect(doc.token_endpoint).toBe("https://other.test/oauth/token");
  });

  it("answers HEAD, OPTIONS and other methods as the library does", async () => {
    expect((await call(new Request(`${ORIGIN}${AS_DOC}`, { method: "HEAD" }))).status).toBe(200);
    expect((await call(new Request(`${ORIGIN}${AS_DOC}`, { method: "OPTIONS" }))).status).toBe(204);
    const post = await call(new Request(`${ORIGIN}${AS_DOC}`, { method: "POST" }));
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
  });
});

describe("paths that do not exist", () => {
  it("/register, /mcp/ and / are 404 with an empty body, for GET and POST", async () => {
    for (const path of ["/register", "/mcp/", "/", "/authorize/", "/oauth/token/"]) {
      for (const method of ["GET", "POST"]) {
        const res = await call(new Request(`${ORIGIN}${path}`, { method }));
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(await res.text()).toBe("");
      }
    }
  });
});

describe("the resource server is never reached from /mcp", () => {
  it("its handler stays uncalled across static, OAuth, refused and malformed requests", async () => {
    const handler = vi.spyOn(unreachableResourceHandler, "fetch");
    try {
      const tokens = await obtainTokens();
      for (const authorization of [`Bearer ${BEARER}`, `Bearer ${tokens.access_token}`, "Bearer owner:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "Bearer nonsense", null]) {
        await mcpList(authorization);
      }
      for (const method of ["GET", "OPTIONS", "DELETE"]) {
        await call(new Request(MCP_URL, { method }));
      }
      expect(handler).not.toHaveBeenCalled();
    } finally {
      handler.mockRestore();
    }
  });
});
