import { describe, expect, it } from "vitest";
import { createAppleCatalog } from "./index";

// Hits the real Apple Music API. Run with: pnpm --filter @tunelynk/connectors test:live
describe.skipIf(process.env.APPLE_LIVE !== "1")("Apple catalog (live)", () => {
  const catalog = createAppleCatalog({
    teamId: process.env.APPLE_TEAM_ID ?? "",
    keyId: process.env.APPLE_KEY_ID ?? "",
    privateKey: process.env.APPLE_PRIVATE_KEY ?? "",
    storefront: process.env.APPLE_STOREFRONT ?? "us",
    rps: 8,
    burst: 10,
    concurrency: 4,
  });

  it("search finds a known song with a preview", async () => {
    const [first] = await catalog.search("Radiohead Weird Fishes");
    expect(first).toMatchObject({
      appleSongId: "1109715168",
      artistName: "Radiohead",
    });
    expect(first?.previewUrl).toMatch(/^https:\/\//);
  });

  it("search handles '+' in the term", async () => {
    const tracks = await catalog.search("Frank Ocean Pink + White");
    expect(tracks[0]?.title).toBe("Pink + White");
  });

  it("lookupByIsrc returns the song", async () => {
    const tracks = await catalog.lookupByIsrc(["GBSTK0700004"]);
    expect(tracks.map((t) => t.appleSongId)).toContain("1109715168");
  });

  it("lookupByIds hydrates artist ids", async () => {
    const [track] = await catalog.lookupByIds(["1109715168"]);
    expect(track?.artistIds).toEqual(["657515"]);
  });

  it("artistTopSongs returns songs", async () => {
    const tracks = await catalog.artistTopSongs("657515");
    expect(tracks.length).toBeGreaterThan(5);
  });
});
