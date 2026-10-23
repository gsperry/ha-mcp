import { afterEach, beforeEach, vi, type MockInstance } from "vitest";

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface FetchSpy {
  /** Every outbound request seen so far, in order. */
  readonly requests: Request[];
  /** Queue a handler for the next outbound request. */
  respondOnce(handler: FetchHandler | Response): void;
  /** Handle every outbound request that has no queued handler. */
  respondAlways(handler: FetchHandler | Response): void;
  /** Requests that reached the spy with no handler, even if the caller swallowed the error. */
  readonly unmocked: Request[];
  /** Throws if any unmocked request was seen. Also runs after every test. */
  assertNoUnmocked(): void;
  /** Forget recorded unmocked requests, for a test that proves they are reported. */
  clearUnmocked(): void;
}

/**
 * Replaces `globalThis.fetch` for the current test file. A request with no
 * handler throws, so a test can never reach a real network or a real Home
 * Assistant by accident. Code under test may catch that error (the MCP SDK turns
 * a thrown tool error into an error result), so every unmocked request is also
 * recorded and the test fails in `afterEach` if there was one. The spy is
 * restored after each test.
 *
 * Call once at the top level of a test file, then use the returned object in
 * tests.
 */
export function installFetchSpy(): FetchSpy {
  const requests: Request[] = [];
  const unmocked: Request[] = [];
  const queue: FetchHandler[] = [];
  let fallback: FetchHandler | undefined;
  let spy: MockInstance<typeof fetch> | undefined;

  const toHandler = (h: FetchHandler | Response): FetchHandler =>
    typeof h === "function" ? h : () => h.clone();

  beforeEach(() => {
    requests.length = 0;
    unmocked.length = 0;
    queue.length = 0;
    fallback = undefined;
    spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      const handler = queue.shift() ?? fallback;
      if (!handler) {
        unmocked.push(request.clone());
        throw new Error(
          `Unmocked outbound fetch: ${request.method} ${request.url}. Tests must not use the network.`,
        );
      }
      return handler(request);
    });
  });

  const assertNoUnmocked = (): void => {
    if (unmocked.length > 0) {
      const list = unmocked.map((r) => `${r.method} ${r.url}`).join(", ");
      throw new Error(`Unmocked outbound fetch was attempted: ${list}`);
    }
  };

  afterEach(() => {
    spy?.mockRestore();
    assertNoUnmocked();
  });

  return {
    requests,
    unmocked,
    assertNoUnmocked,
    clearUnmocked: () => void (unmocked.length = 0),
    respondOnce: (h) => void queue.push(toHandler(h)),
    respondAlways: (h) => void (fallback = toHandler(h)),
  };
}
