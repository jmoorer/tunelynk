import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLimiter } from "./limiter";

// Drains multi-hop promise chains (task → resolve → finally → pump → next task).
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// Advance fake time, then let the tasks that the timer released start.
async function tick(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createLimiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts a burst immediately, then refills at rps", async () => {
    const limiter = createLimiter({ rps: 8, burst: 10, concurrency: 100 });
    let started = 0;
    for (let i = 0; i < 12; i++) {
      limiter.schedule(async () => {
        started++;
      });
    }
    await flush();
    expect(started).toBe(10);

    await tick(124);
    expect(started).toBe(10);
    await tick(1); // 125 ms = 1 token at 8/s
    expect(started).toBe(11);
    await tick(125);
    expect(started).toBe(12);
  });

  it("never runs more than `concurrency` tasks at once", async () => {
    const limiter = createLimiter({ rps: 100, burst: 100, concurrency: 4 });
    const gates = Array.from({ length: 6 }, deferred);
    let running = 0;
    let maxRunning = 0;
    for (const gate of gates) {
      limiter.schedule(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await gate.promise;
        running--;
      });
    }
    await flush();
    expect(running).toBe(4);

    gates[0]?.resolve();
    await flush();
    expect(running).toBe(4); // the 5th started in the freed slot

    for (const gate of gates) gate.resolve();
    await flush();
    expect(maxRunning).toBe(4);
    expect(running).toBe(0);
  });

  it("drain() makes the next task wait for a fresh token", async () => {
    const limiter = createLimiter({ rps: 8, burst: 10, concurrency: 4 });
    limiter.drain();
    let started = false;
    limiter.schedule(async () => {
      started = true;
    });
    await tick(124);
    expect(started).toBe(false);
    await tick(1);
    expect(started).toBe(true);
  });

  it("returns the task's value and propagates its rejection", async () => {
    const limiter = createLimiter({ rps: 8, burst: 10, concurrency: 1 });
    const ok = limiter.schedule(async () => 42);
    const bad = limiter.schedule(async () => {
      throw new Error("boom");
    });
    const after = limiter.schedule(async () => "next");
    await flush();
    await expect(ok).resolves.toBe(42);
    await expect(bad).rejects.toThrow("boom");
    await expect(after).resolves.toBe("next"); // a failure frees its slot
  });

  it("treats a synchronous throw like a rejection", async () => {
    const limiter = createLimiter({ rps: 8, burst: 10, concurrency: 1 });
    const bad = limiter.schedule(() => {
      throw new Error("sync");
    });
    const after = limiter.schedule(async () => "next");
    await flush();
    await expect(bad).rejects.toThrow("sync");
    await expect(after).resolves.toBe("next");
  });
});
