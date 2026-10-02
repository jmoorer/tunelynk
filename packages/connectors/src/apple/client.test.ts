import { describe, expect, it, vi } from "vitest";
import { AppleApiError, backoffDelay, createAppleClient } from "./client";
import type { DeveloperToken } from "./devToken";
import type { Limiter } from "./limiter";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const empty = (status: number) => new Response(null, { status });

function setup(responses: Array<Response | Error>) {
  let signed = 0;
  const token: DeveloperToken = {
    get: () => `tok${signed}`,
    invalidate: vi.fn(() => {
      signed++;
    }),
  };
  const limiter: Limiter = {
    schedule: (task) => task(),
    drain: vi.fn(),
  };
  const fetch = vi.fn(async (_url: URL, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra fetch");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleeps: number[] = [];
  const client = createAppleClient({
    token,
    limiter,
    storefront: "us",
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  });
  return { client, fetch, token, limiter, sleeps };
}

describe("createAppleClient", () => {
  it("builds the catalog URL, encodes params, and sends the token", async () => {
    const { client, fetch } = setup([json({ ok: 1 })]);
    const body = await client.get("/search", {
      types: "songs",
      term: "Frank Ocean Pink + White & Khruangbin Maria También",
    });
    expect(body).toEqual({ ok: 1 });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url?.origin + (url?.pathname ?? "")).toBe(
      "https://api.music.apple.com/v1/catalog/us/search",
    );
    expect(url?.search).toBe(
      "?types=songs&term=Frank+Ocean+Pink+%2B+White+%26+Khruangbin+Maria+Tambi%C3%A9n",
    );
    expect(url?.searchParams.get("term")).toBe(
      "Frank Ocean Pink + White & Khruangbin Maria También",
    );
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer tok0");
  });

  it("retries 429 with backoff and drains the shared limiter", async () => {
    const { client, limiter, sleeps } = setup([
      empty(429),
      empty(429),
      json({ ok: 1 }),
    ]);
    await expect(client.get("/search")).resolves.toEqual({ ok: 1 });
    expect(limiter.drain).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([125, 250]); // 0.5 × 250, 0.5 × 500
  });

  it("gives up after 4 retries on 5xx", async () => {
    const { client, fetch, sleeps } = setup(
      Array.from({ length: 5 }, () => empty(503)),
    );
    const err = await client.get("/search").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppleApiError);
    expect(err).toMatchObject({ status: 503, path: "/search" });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(sleeps).toHaveLength(4);
  });

  it("retries network errors and surfaces the last one", async () => {
    const { client } = setup([new TypeError("fetch failed"), json({ ok: 1 })]);
    await expect(client.get("/search")).resolves.toEqual({ ok: 1 });

    const failing = setup(
      Array.from({ length: 5 }, () => new TypeError("fetch failed")),
    );
    await expect(failing.client.get("/search")).rejects.toThrow("fetch failed");
  });

  it("re-signs the token once on 401", async () => {
    const { client, fetch, token, sleeps } = setup([
      empty(401),
      json({ ok: 1 }),
    ]);
    await expect(client.get("/search")).resolves.toEqual({ ok: 1 });
    expect(token.invalidate).toHaveBeenCalledTimes(1);
    const auth = fetch.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get("Authorization"),
    );
    expect(auth).toEqual(["Bearer tok0", "Bearer tok1"]);
    expect(sleeps).toEqual([]);
  });

  it("throws on a second 401", async () => {
    const { client, fetch } = setup([empty(401), empty(401)]);
    await expect(client.get("/search")).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws other 4xx immediately", async () => {
    const { client, fetch } = setup([empty(404)]);
    await expect(client.get("/songs/x")).rejects.toMatchObject({
      status: 404,
      path: "/songs/x",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("backoffDelay", () => {
  it("doubles from 250 ms and caps at 4 s", () => {
    const max = () => 0.999999;
    expect(backoffDelay(0, max)).toBe(249);
    expect(backoffDelay(1, max)).toBe(499);
    expect(backoffDelay(4, max)).toBe(3999);
    expect(backoffDelay(10, max)).toBe(3999);
    expect(backoffDelay(3, () => 0)).toBe(0);
  });
});
