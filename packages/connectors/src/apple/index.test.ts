import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import search from "./__fixtures__/search.json";
import { createAppleCatalog } from "./index";

const privateKey = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

describe("createAppleCatalog", () => {
  it("wires token, limiter, client, and catalog", async () => {
    const fetch = vi.fn(
      async (_url: URL, _init?: RequestInit) =>
        new Response(JSON.stringify(search), { status: 200 }),
    );
    const catalog = createAppleCatalog({
      teamId: "TEAM",
      keyId: "KEY",
      privateKey,
      storefront: "gb",
      rps: 8,
      burst: 10,
      concurrency: 4,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const tracks = await catalog.search("Radiohead Weird Fishes");

    expect(tracks).toHaveLength(2);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url?.pathname).toBe("/v1/catalog/gb/search");
    expect(new Headers(init?.headers).get("Authorization")).toMatch(
      /^Bearer ey[\w-]+\.[\w-]+\.[\w-]+$/,
    );
  });

  it("is exported from the package root", async () => {
    const root = await import("../index");
    expect(root.createAppleCatalog).toBe(createAppleCatalog);
    expect(root.AppleApiError).toBeTypeOf("function");
  });
});
