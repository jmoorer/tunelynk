import type { CatalogSource, CatalogTrack } from "@tunelynk/connectors";
import { describe, expect, it } from "vitest";
import { EngineError, NotEnoughTracksError, RefusalError } from "./errors";
import { generate, interleave } from "./generate";
import type {
  CandidateRequest,
  LlmOutput,
  LlmProvider,
  TrackKey,
} from "./llm/types";
import type { Stage } from "./types";

const track = (
  id: string,
  title: string,
  artistName: string,
  extra: Partial<CatalogTrack> = {},
): CatalogTrack => ({
  appleSongId: id,
  isrc: `ISRC${id}`,
  title,
  artistName,
  artistIds: [],
  album: "Album",
  durationMs: 200_000,
  explicit: false,
  ...extra,
});

function fakeCatalog({
  search = {},
  ids = {},
  top = {},
  lookupFails = false,
}: {
  search?: Record<string, CatalogTrack[] | Error>;
  ids?: Record<string, CatalogTrack>;
  top?: Record<string, CatalogTrack[]>;
  lookupFails?: boolean;
}) {
  const calls = {
    search: [] as string[],
    lookupByIds: [] as string[][],
    artistTopSongs: [] as string[],
  };
  const catalog: CatalogSource = {
    async search(query) {
      calls.search.push(query);
      const result = search[query];
      if (result instanceof Error) throw result;
      return result ?? [];
    },
    async lookupByIsrc() {
      return [];
    },
    async lookupByIds(list) {
      calls.lookupByIds.push(list);
      if (lookupFails) throw new Error("lookup down");
      return list.flatMap((id) => {
        const hit = ids[id];
        return hit ? [hit] : [];
      });
    },
    async artistTopSongs(id) {
      calls.artistTopSongs.push(id);
      return top[id] ?? [];
    },
  };
  return { catalog, calls };
}

function fakeLlm(output: Partial<LlmOutput> & { candidates: TrackKey[] }) {
  const requests: CandidateRequest[] = [];
  const usage = {
    model: "claude-haiku-4-5",
    inputTokens: 100,
    outputTokens: 200,
  };
  const llm: LlmProvider = {
    model: "claude-haiku-4-5",
    async generateCandidates(request) {
      requests.push(request);
      return {
        output: {
          refusal: null,
          name: "Mix",
          plan: { artists: [], vibe: "" },
          ...output,
        },
        usage,
      };
    },
  };
  return { llm, requests, usage };
}

const ids = (tracks: { appleSongId: string }[]) =>
  tracks.map((t) => t.appleSongId);

describe("generate", () => {
  it("matches candidates in LLM order, cuts to length, reports stages", async () => {
    const { catalog, calls } = fakeCatalog({
      search: {
        "Fleetwood Mac Dreams": [track("1", "Dreams", "Fleetwood Mac")],
        "Fleetwood Mac Landslide": [track("2", "Landslide", "Fleetwood Mac")],
        "Childish Gambino Redbone": [track("3", "Redbone", "Childish Gambino")],
        "Kendrick Lamar Alright": [track("4", "Alright", "Kendrick Lamar")],
      },
    });
    const { llm, requests, usage } = fakeLlm({
      name: "Sunday Drive",
      candidates: [
        { title: "Dreams", artist: "Fleetwood Mac" },
        { title: "Landslide", artist: "Fleetwood Mac" },
        { title: "Redbone", artist: "Childish Gambino" },
        { title: "Alright", artist: "Kendrick Lamar" },
      ],
    });
    const stages: Stage[] = [];

    const result = await generate(
      { prompt: "sunday drive", length: 3 },
      { catalog, llm },
      (stage) => stages.push(stage),
    );

    expect(stages).toEqual(["llm", "matching"]);
    expect(requests[0]).toEqual({
      prompt: "sunday drive",
      count: 5,
      exclude: [],
    });
    expect(calls.search).toHaveLength(4);
    expect(result.name).toBe("Sunday Drive");
    expect(ids(result.tracks)).toEqual(["1", "2", "3"]);
    expect(result.tracks.every((t) => t.source === "llm")).toBe(true);
    expect(result.candidates.map((c) => c.status)).toEqual([
      "matched",
      "matched",
      "matched",
      "matched",
    ]);
    expect(result.candidates[0]).toEqual({
      title: "Dreams",
      artist: "Fleetwood Mac",
      status: "matched",
      appleSongId: "1",
    });
    expect(result.usage).toBe(usage);
  });

  it("drops repeats that share an ISRC", async () => {
    const { catalog } = fakeCatalog({
      search: {
        "Fleetwood Mac Dreams": [
          track("1", "Dreams", "Fleetwood Mac", { isrc: "X" }),
        ],
        "Fleetwood Mac Dreams (2004 Remaster)": [
          track("9", "Dreams (2004 Remaster)", "Fleetwood Mac", { isrc: "X" }),
        ],
      },
    });
    const { llm } = fakeLlm({
      candidates: [
        { title: "Dreams", artist: "Fleetwood Mac" },
        { title: "Dreams (2004 Remaster)", artist: "Fleetwood Mac" },
      ],
    });
    const result = await generate({ prompt: "p", length: 2 }, { catalog, llm });
    expect(ids(result.tracks)).toEqual(["1"]);
    expect(result.candidates[1]).toMatchObject({
      status: "duplicate",
      appleSongId: "9",
    });
  });

  it("drops re-releases with the same title and primary artist", async () => {
    const { catalog } = fakeCatalog({
      search: {
        "Fleetwood Mac Dreams": [track("1", "Dreams", "Fleetwood Mac")],
        "Fleetwood Mac & Friends Dreams": [
          track("2", "Dreams", "Fleetwood Mac & Friends"),
        ],
      },
    });
    const { llm } = fakeLlm({
      candidates: [
        { title: "Dreams", artist: "Fleetwood Mac" },
        { title: "Dreams", artist: "Fleetwood Mac & Friends" },
      ],
    });
    const result = await generate({ prompt: "p", length: 2 }, { catalog, llm });
    expect(result.candidates.map((c) => c.status)).toEqual([
      "matched",
      "duplicate",
    ]);
  });

  it("keeps distinct non-Latin songs by the same artist", async () => {
    const { catalog } = fakeCatalog({
      search: {
        "Кино Группа крови": [track("1", "Группа крови", "Кино")],
        "Кино Кукушка": [track("2", "Кукушка", "Кино")],
      },
    });
    const { llm } = fakeLlm({
      candidates: [
        { title: "Группа крови", artist: "Кино" },
        { title: "Кукушка", artist: "Кино" },
      ],
    });
    const result = await generate({ prompt: "p", length: 2 }, { catalog, llm });
    expect(ids(result.tracks)).toEqual(["1", "2"]);
  });

  it("passes the exclude list to the LLM and drops excluded tracks", async () => {
    const { catalog } = fakeCatalog({
      search: {
        "Fleetwood Mac Dreams": [track("1", "Dreams", "Fleetwood Mac")],
        "Fleetwood Mac Landslide": [track("2", "Landslide", "Fleetwood Mac")],
      },
    });
    const { llm, requests } = fakeLlm({
      candidates: [
        { title: "Dreams", artist: "Fleetwood Mac" },
        { title: "Landslide", artist: "Fleetwood Mac" },
      ],
    });
    const result = await generate(
      {
        prompt: "p",
        length: 2,
        exclude: [
          { appleSongId: "1", title: "Dreams", artistName: "Fleetwood Mac" },
        ],
      },
      { catalog, llm },
    );
    expect(requests[0]?.exclude).toEqual([
      { title: "Dreams", artist: "Fleetwood Mac" },
    ]);
    expect(ids(result.tracks)).toEqual(["2"]);
    expect(result.candidates[0]?.status).toBe("duplicate");
  });

  it("marks failed searches as error and misses as unmatched, and keeps going", async () => {
    const { catalog } = fakeCatalog({
      search: {
        "A Broken": new Error("Apple 503"),
        "Fleetwood Mac Dreams": [track("1", "Dreams", "Fleetwood Mac")],
      },
    });
    const { llm } = fakeLlm({
      candidates: [
        { title: "Broken", artist: "A" },
        { title: "Nothing", artist: "B" },
        { title: "Dreams", artist: "Fleetwood Mac" },
      ],
    });
    const result = await generate({ prompt: "p", length: 2 }, { catalog, llm });
    expect(result.candidates.map((c) => c.status)).toEqual([
      "error",
      "unmatched",
      "matched",
    ]);
    expect(ids(result.tracks)).toEqual(["1"]);
  });

  it("backfills from plan artists' top songs, at most 2 per artist, interleaved", async () => {
    const dreams = track("1", "Dreams", "Fleetwood Mac");
    const alright = track("2", "Alright", "Kendrick Lamar");
    const { catalog, calls } = fakeCatalog({
      search: {
        "Fleetwood Mac Dreams": [dreams],
        "Kendrick Lamar Alright": [alright],
      },
      ids: {
        "1": { ...dreams, artistIds: ["fm"] },
        "2": { ...alright, artistIds: ["kl"] },
      },
      top: {
        fm: [
          dreams, // already in the playlist: skipped
          track("10", "Landslide", "Fleetwood Mac"),
          track("11", "Go Your Own Way", "Fleetwood Mac"),
          track("12", "Rhiannon", "Fleetwood Mac"),
        ],
      },
    });
    const { llm } = fakeLlm({
      plan: { artists: ["Fleetwood Mac"], vibe: "" },
      candidates: [
        { title: "Dreams", artist: "Fleetwood Mac" },
        { title: "Alright", artist: "Kendrick Lamar" },
        { title: "Nope", artist: "Nobody" },
      ],
    });

    const result = await generate({ prompt: "p", length: 4 }, { catalog, llm });

    expect(calls.lookupByIds).toEqual([["1", "2"]]);
    expect(calls.artistTopSongs).toEqual(["fm"]); // Kendrick is not a plan artist
    expect(ids(result.tracks)).toEqual(["1", "10", "2", "11"]);
    expect(result.tracks.map((t) => t.source)).toEqual([
      "llm",
      "backfill",
      "llm",
      "backfill",
    ]);
  });

  it("round-robins backfill across artists by how many tracks matched", async () => {
    const a1 = track("1", "Dreams", "Fleetwood Mac");
    const a2 = track("3", "Landslide", "Fleetwood Mac");
    const b1 = track("2", "Alright", "Kendrick Lamar");
    const { catalog, calls } = fakeCatalog({
      search: {
        "Fleetwood Mac Dreams": [a1],
        "Kendrick Lamar Alright": [b1],
        "Fleetwood Mac Landslide": [a2],
      },
      ids: {
        "1": { ...a1, artistIds: ["fm"] },
        "2": { ...b1, artistIds: ["kl"] },
        "3": { ...a2, artistIds: ["fm"] },
      },
      top: {
        fm: [
          track("20", "Rhiannon", "Fleetwood Mac"),
          track("21", "Gypsy", "Fleetwood Mac"),
          track("22", "Sara", "Fleetwood Mac"),
        ],
        kl: [
          track("30", "HUMBLE.", "Kendrick Lamar"),
          track("31", "DNA.", "Kendrick Lamar"),
        ],
      },
    });
    const { llm } = fakeLlm({
      plan: { artists: ["Kendrick Lamar", "Fleetwood Mac"], vibe: "" },
      candidates: [
        { title: "Dreams", artist: "Fleetwood Mac" },
        { title: "Alright", artist: "Kendrick Lamar" },
        { title: "Landslide", artist: "Fleetwood Mac" },
      ],
    });

    const result = await generate({ prompt: "p", length: 6 }, { catalog, llm });

    expect(calls.artistTopSongs).toEqual(["fm", "kl"]); // fm matched twice
    expect(ids(result.tracks.filter((t) => t.source === "backfill"))).toEqual([
      "20",
      "30",
      "21",
    ]);
  });

  it("skips backfill when lookupByIds fails, then applies the 50% rule", async () => {
    const { catalog } = fakeCatalog({
      search: {
        "Fleetwood Mac Dreams": [track("1", "Dreams", "Fleetwood Mac")],
      },
      lookupFails: true,
    });
    const { llm } = fakeLlm({
      plan: { artists: ["Fleetwood Mac"], vibe: "" },
      candidates: [{ title: "Dreams", artist: "Fleetwood Mac" }],
    });
    const result = await generate({ prompt: "p", length: 2 }, { catalog, llm });
    expect(ids(result.tracks)).toEqual(["1"]); // 1 ≥ ceil(2 / 2)
  });

  it("throws NotEnoughTracksError below half the target, with usage and candidates", async () => {
    const { catalog } = fakeCatalog({
      search: {
        "Fleetwood Mac Dreams": [track("1", "Dreams", "Fleetwood Mac")],
      },
    });
    const { llm, usage } = fakeLlm({
      candidates: [
        { title: "Dreams", artist: "Fleetwood Mac" },
        { title: "Nope", artist: "Nobody" },
      ],
    });
    const err = await generate(
      { prompt: "p", length: 4 },
      { catalog, llm },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotEnoughTracksError);
    expect(err).toMatchObject({ found: 1, needed: 2, usage });
    expect((err as NotEnoughTracksError).candidates).toHaveLength(2);
  });

  it("throws NotEnoughTracksError when the LLM returns no candidates", async () => {
    const { catalog, calls } = fakeCatalog({});
    const { llm } = fakeLlm({ candidates: [] });
    await expect(
      generate({ prompt: "p", length: 20 }, { catalog, llm }),
    ).rejects.toMatchObject({
      name: "NotEnoughTracksError",
      found: 0,
      needed: 10,
    });
    expect(calls.search).toEqual([]);
  });

  it("wraps unexpected failures after the LLM call in EngineError with usage", async () => {
    const { catalog } = fakeCatalog({});
    const { llm, usage } = fakeLlm({
      candidates: [{ title: "Dreams", artist: "Fleetwood Mac" }],
    });
    const cause = new Error("db down");
    const err = await generate(
      { prompt: "p", length: 1 },
      { catalog, llm },
      (stage) => {
        if (stage === "matching") throw cause;
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err).toMatchObject({ usage, cause });
  });

  it("throws RefusalError with usage and never searches", async () => {
    const { catalog, calls } = fakeCatalog({});
    const { llm, usage } = fakeLlm({
      refusal: "That is a coding question, not a playlist.",
      candidates: [],
    });
    const err = await generate(
      { prompt: "write python", length: 20 },
      { catalog, llm },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefusalError);
    expect(err).toMatchObject({
      reason: "That is a coding question, not a playlist.",
      usage,
    });
    expect(calls.search).toEqual([]);
  });

  it("falls back to the prompt when the LLM gives no name", async () => {
    const { catalog } = fakeCatalog({
      search: {
        "Fleetwood Mac Dreams": [track("1", "Dreams", "Fleetwood Mac")],
      },
    });
    const { llm } = fakeLlm({
      name: "",
      candidates: [{ title: "Dreams", artist: "Fleetwood Mac" }],
    });
    const result = await generate(
      { prompt: "  rainy day classics  ", length: 1 },
      { catalog, llm },
    );
    expect(result.name).toBe("rainy day classics");
  });
});

describe("interleave", () => {
  it("spreads extra items evenly through primary", () => {
    expect(interleave(["a", "b", "c", "d"], ["X", "Y"])).toEqual([
      "a",
      "b",
      "X",
      "c",
      "Y",
      "d",
    ]);
  });

  it("handles empty sides", () => {
    expect(interleave([], ["X"])).toEqual(["X"]);
    expect(interleave(["a"], [])).toEqual(["a"]);
  });
});
