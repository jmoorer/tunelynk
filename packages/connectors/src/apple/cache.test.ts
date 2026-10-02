import { describe, expect, it } from "vitest";
import { createTtlCache } from "./cache";

describe("createTtlCache", () => {
  it("returns what was set", () => {
    const cache = createTtlCache<number>({ max: 2, ttlMs: 1000 });
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(undefined);
  });

  it("expires entries after ttlMs", () => {
    let nowMs = 0;
    const cache = createTtlCache<number>({
      max: 2,
      ttlMs: 1000,
      now: () => nowMs,
    });
    cache.set("a", 1);
    nowMs = 999;
    expect(cache.get("a")).toBe(1);
    nowMs = 1000;
    expect(cache.get("a")).toBe(undefined);
  });

  it("evicts the least recently used entry", () => {
    const cache = createTtlCache<number>({ max: 2, ttlMs: 1000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // a is now most recent
    cache.set("c", 3);
    expect(cache.get("b")).toBe(undefined);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  it("overwriting a key does not grow the cache", () => {
    const cache = createTtlCache<number>({ max: 2, ttlMs: 1000 });
    cache.set("a", 1);
    cache.set("a", 2);
    cache.set("b", 3);
    expect(cache.get("a")).toBe(2);
    expect(cache.get("b")).toBe(3);
  });
});
