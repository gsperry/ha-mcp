import { describe, expect, it } from "vitest";
import { installFetchSpy } from "./helpers/fetch";

describe("fetch spy helper", () => {
  const fetchSpy = installFetchSpy();

  it("fails an unmocked outbound request", async () => {
    await expect(fetch("https://ha.test/api/")).rejects.toThrow(/Unmocked outbound fetch/);
    expect(fetchSpy.requests).toHaveLength(1);
    fetchSpy.clearUnmocked();
  });

  it("still reports an unmocked request when the caller swallows the error", async () => {
    const codeUnderTest = async () => {
      try {
        await fetch("https://ha.test/api/states");
        return "ok";
      } catch {
        return "handled";
      }
    };
    expect(await codeUnderTest()).toBe("handled");
    expect(() => fetchSpy.assertNoUnmocked()).toThrow(/GET https:\/\/ha\.test\/api\/states/);
    fetchSpy.clearUnmocked();
  });

  it("keeps request bodies readable after a handler consumed them", async () => {
    fetchSpy.respondOnce(async (request) => new Response(await request.text()));
    const res = await fetch("https://ha.test/x", { method: "POST", body: "payload" });
    expect(await res.text()).toBe("payload");
    expect(await fetchSpy.requests[0]!.text()).toBe("payload");
  });

  it("serves queued responses in order, then the fallback", async () => {
    fetchSpy.respondOnce(new Response("one"));
    fetchSpy.respondAlways(new Response("rest"));
    expect(await (await fetch("https://ha.test/a")).text()).toBe("one");
    expect(await (await fetch("https://ha.test/b")).text()).toBe("rest");
    expect(await (await fetch("https://ha.test/c")).text()).toBe("rest");
    expect(fetchSpy.requests.map((r) => new URL(r.url).pathname)).toEqual(["/a", "/b", "/c"]);
  });

  it("resets between tests", async () => {
    expect(fetchSpy.requests).toHaveLength(0);
    await expect(fetch("https://ha.test/")).rejects.toThrow(/Unmocked/);
    fetchSpy.clearUnmocked();
  });
});
