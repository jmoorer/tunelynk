import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubFetch } from "../test/fetch";
import { IDS, makeRun } from "../test/fixtures";
import { isRunning, POLL_MS, useRun } from "./useRun";

const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const tick = () => act(() => vi.advanceTimersByTimeAsync(POLL_MS));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useRun", () => {
  it("polls until the run reaches a terminal status", async () => {
    const statuses = [
      makeRun({ status: "running", stage: "llm", tracks: [] }),
      makeRun({ status: "running", stage: "matching", tracks: [] }),
      makeRun(),
    ];
    const fetch = stubFetch(() => Response.json(statuses.shift() ?? makeRun()));
    const { result } = renderHook(() => useRun(IDS.run));
    expect(isRunning(result.current)).toBe(true);

    await flush();
    expect(result.current.run?.stage).toBe("llm");
    await tick();
    expect(result.current.run?.stage).toBe("matching");
    await tick();
    expect(result.current.run?.status).toBe("draft");
    expect(isRunning(result.current)).toBe(false);

    await tick();
    await tick();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("stops on 404", async () => {
    const fetch = stubFetch(() =>
      Response.json({ error: "not_found" }, { status: 404 }),
    );
    const { result } = renderHook(() => useRun(IDS.run));
    await flush();
    expect(result.current.notFound).toBe(true);
    expect(isRunning(result.current)).toBe(false);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps polling through network errors and recovers", async () => {
    let calls = 0;
    stubFetch(() => {
      calls++;
      if (calls === 2) throw new TypeError("Failed to fetch");
      return Response.json(
        calls < 3
          ? makeRun({ status: "running", stage: "llm", tracks: [] })
          : makeRun(),
      );
    });
    const { result } = renderHook(() => useRun(IDS.run));
    await flush();
    await tick();
    expect(result.current.reconnecting).toBe(true);
    expect(result.current.run?.stage).toBe("llm");
    await tick();
    expect(result.current.reconnecting).toBe(false);
    expect(result.current.run?.status).toBe("draft");
  });

  it("restarts when the run id changes", async () => {
    const fetch = stubFetch((url) =>
      Response.json(
        url.endsWith(IDS.otherRun) ? makeRun({ id: IDS.otherRun }) : makeRun(),
      ),
    );
    const { result, rerender } = renderHook(({ id }) => useRun(id), {
      initialProps: { id: IDS.run },
    });
    await flush();
    rerender({ id: IDS.otherRun });
    expect(result.current.run).toBe(null);
    await flush();
    expect(result.current.run?.id).toBe(IDS.otherRun);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
