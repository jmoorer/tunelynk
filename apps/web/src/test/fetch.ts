import { vi } from "vitest";

type Handler = (
  url: string,
  init: RequestInit | undefined,
) => Response | Promise<Response>;

// Routes fetch calls to a handler; returns the mock for call assertions.
export function stubFetch(handler: Handler) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}
