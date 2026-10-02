import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startStaleRunSweeper } from "./sweeper";

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("startStaleRunSweeper", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sweeps at start and then every interval", async () => {
    const failStaleRuns = vi.fn(async () => 0);
    const stop = startStaleRunSweeper({
      repo: { failStaleRuns },
      olderThanMs: 180_000,
      intervalMs: 60_000,
      logger: { log: vi.fn(), error: vi.fn() },
    });
    await flush();
    expect(failStaleRuns).toHaveBeenCalledTimes(1);
    expect(failStaleRuns).toHaveBeenCalledWith(180_000);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(failStaleRuns).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(failStaleRuns).toHaveBeenCalledTimes(2);
  });

  it("logs failed runs and swallows sweep errors", async () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const failStaleRuns = vi
      .fn<(olderThanMs: number) => Promise<number>>()
      .mockResolvedValueOnce(3)
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue(0);
    const stop = startStaleRunSweeper({
      repo: { failStaleRuns },
      olderThanMs: 1,
      intervalMs: 10,
      logger,
    });
    await flush();
    expect(logger.log).toHaveBeenCalledWith("Marked 3 stale run(s) as failed");
    await vi.advanceTimersByTimeAsync(10);
    expect(logger.error).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(failStaleRuns).toHaveBeenCalledTimes(3);
    stop();
  });
});
