import { describe, expect, it, vi } from "vitest";
import search from "./__fixtures__/search.json";
import songs from "./__fixtures__/songs.json";
import topSongs from "./__fixtures__/top-songs.json";
import { appleCatalog } from "./catalog";
import type { AppleClient } from "./client";

function fakeClient(
  respond: (path: string, params: Record<string, string>) => unknown,
) {
  const get = vi.fn(async (path: string, params: Record<string, string> = {}) =>
    respond(path, params),
  );
  return { client: { get } as unknown as AppleClient, get };
}

describe("appleCatalog.search", () => {
  it("searches songs and maps results", async () => {
    const { client, get } = fakeClient(() => search);
    const tracks = await appleCatalog(client).search(
      "  Radiohead   Weird Fishes ",
    );
    expect(get).toHaveBeenCalledWith("/search", {
      types: "songs",
      limit: "5",
      term: "Radiohead Weird Fishes",
    });
    expect(tracks.map((t) => t.appleSongId)).toEqual([
      "1109715168",
      "813858377",
    ]);
    expect(tracks[0]?.artistIds).toEqual([]);
  });

  it("passes a custom limit", async () => {
    const { client, get } = fakeClient(() => search);
    await appleCatalog(client).search("x", { limit: 10 });
    expect(get.mock.calls[0]?.[1]).toMatchObject({ limit: "10" });
  });

  it("returns [] when Apple finds nothing", async () => {
    const { client } = fakeClient(() => ({ results: {} }));
    await expect(appleCatalog(client).search("zzqxv")).resolves.toEqual([]);
  });

  it("returns [] for a blank query without calling Apple", async () => {
    const { client, get } = fakeClient(() => search);
    await expect(appleCatalog(client).search("   ")).resolves.toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it("hands out copies so callers cannot corrupt the cache", async () => {
    const { client, get } = fakeClient(() => search);
    const catalog = appleCatalog(client);
    const first = await catalog.search("Radiohead Weird Fishes");
    const [track] = first;
    if (!track) throw new Error("expected a track");
    track.title = "mutated";
    track.artistIds.push("x");
    first.length = 0;
    const second = await catalog.search("Radiohead Weird Fishes");
    expect(get).toHaveBeenCalledTimes(1);
    expect(second).toHaveLength(2);
    expect(second[0]?.title).toBe("Weird Fishes / Arpeggi");
    expect(second[0]?.artistIds).toEqual([]);
  });

  it("caches by normalized term and limit", async () => {
    const { client, get } = fakeClient(() => search);
    const catalog = appleCatalog(client);
    await catalog.search("Radiohead Weird Fishes");
    await catalog.search("  radiohead  WEIRD fishes");
    expect(get).toHaveBeenCalledTimes(1);
    await catalog.search("Radiohead Weird Fishes", { limit: 10 });
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("appleCatalog.lookupByIsrc", () => {
  it("dedupes and chunks ISRCs by 25", async () => {
    const { client, get } = fakeClient(() => songs);
    const isrcs = Array.from({ length: 30 }, (_, i) => `ISRC${i}`);
    const tracks = await appleCatalog(client).lookupByIsrc([...isrcs, "ISRC0"]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0]?.[0]).toBe("/songs");
    expect(get.mock.calls[0]?.[1]?.["filter[isrc]"]?.split(",")).toHaveLength(
      25,
    );
    expect(get.mock.calls[1]?.[1]?.["filter[isrc]"]?.split(",")).toHaveLength(
      5,
    );
    expect(tracks).toHaveLength(2); // one song per fake page
  });

  it("returns [] for no ISRCs without calling Apple", async () => {
    const { client, get } = fakeClient(() => songs);
    await expect(appleCatalog(client).lookupByIsrc([])).resolves.toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("appleCatalog.lookupByIds", () => {
  it("fetches songs by id with artist ids hydrated", async () => {
    const { client, get } = fakeClient(() => songs);
    const tracks = await appleCatalog(client).lookupByIds(["1109715168"]);
    expect(get).toHaveBeenCalledWith("/songs", { ids: "1109715168" });
    expect(tracks[0]?.artistIds).toEqual(["657515"]);
  });

  it("chunks ids by 300", async () => {
    const { client, get } = fakeClient(() => ({ data: [] }));
    const ids = Array.from({ length: 301 }, (_, i) => String(i));
    await appleCatalog(client).lookupByIds(ids);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("returns [] for no ids without calling Apple", async () => {
    const { client, get } = fakeClient(() => songs);
    await expect(appleCatalog(client).lookupByIds([])).resolves.toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("appleCatalog.artistTopSongs", () => {
  it("fetches and caches an artist's top songs", async () => {
    const { client, get } = fakeClient(() => topSongs);
    const catalog = appleCatalog(client);
    const tracks = await catalog.artistTopSongs("657515");
    await catalog.artistTopSongs("657515");
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/artists/657515/view/top-songs", {
      limit: "20",
    });
    expect(tracks.map((t) => t.title)).toEqual(["Creep", "Let Down"]);
  });
});
