import { describe, expect, it } from "vitest";
import { stubFetch } from "../test/fetch";
import { IDS, makeRun } from "../test/fixtures";
import { createRun, fetchRun, RunNotFoundError } from "./api";

describe("createRun", () => {
  it("POSTs the prompt and returns the ids on 202", async () => {
    const fetch = stubFetch(() =>
      Response.json(
        { runId: IDS.run, playlistId: IDS.playlist },
        { status: 202 },
      ),
    );
    expect(await createRun("road trip")).toEqual({
      ok: true,
      runId: IDS.run,
      playlistId: IDS.playlist,
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("/api/runs");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init?.body))).toEqual({ prompt: "road trip" });
  });

  it.each([
    [400, { error: "invalid_prompt" }],
    [503, { error: "budget_exceeded" }],
    [
      409,
      { error: "run_in_progress", runId: IDS.run, playlistId: IDS.playlist },
    ],
  ])("returns the API error for %i", async (status, body) => {
    stubFetch(() => Response.json(body, { status }));
    expect(await createRun("p")).toEqual({ ok: false, ...body });
  });

  it("reports network failures and unexpected bodies as network errors", async () => {
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await createRun("p")).toEqual({ ok: false, error: "network" });
    stubFetch(() => new Response("<html>Bad Gateway</html>", { status: 502 }));
    expect(await createRun("p")).toEqual({ ok: false, error: "network" });
  });
});

describe("fetchRun", () => {
  it("GETs and validates the run", async () => {
    const fetch = stubFetch(() => Response.json(makeRun()));
    expect(await fetchRun(IDS.run)).toEqual(makeRun());
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`/api/runs/${IDS.run}`);
  });

  it("throws RunNotFoundError on 404", async () => {
    stubFetch(() => Response.json({ error: "not_found" }, { status: 404 }));
    await expect(fetchRun(IDS.run)).rejects.toBeInstanceOf(RunNotFoundError);
  });

  it("throws on other failures and on malformed bodies", async () => {
    stubFetch(() => new Response("oops", { status: 500 }));
    await expect(fetchRun(IDS.run)).rejects.toThrow("500");
    stubFetch(() => Response.json({ id: "nope" }));
    await expect(fetchRun(IDS.run)).rejects.toThrow();
  });
});
