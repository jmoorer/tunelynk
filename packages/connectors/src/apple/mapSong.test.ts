import { describe, expect, it } from "vitest";
import search from "./__fixtures__/search.json";
import songs from "./__fixtures__/songs.json";
import topSongs from "./__fixtures__/top-songs.json";
import { type AppleSong, mapSong, mapSongs } from "./mapSong";

describe("mapSong", () => {
  it("maps a search result", () => {
    const [first] = mapSongs(search.results.songs.data);
    expect(first).toEqual({
      appleSongId: "1109715168",
      isrc: "GBSTK0700004",
      title: "Weird Fishes / Arpeggi",
      artistName: "Radiohead",
      artistIds: [],
      album: "In Rainbows",
      durationMs: 318187,
      explicit: false,
      artworkUrl:
        "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/dd/50/c7/dd50c790-99ac-d3d0-5ab8-e3891fb8fd52/634904032463.png/300x300bb.jpg",
      previewUrl:
        "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/3a/12/eb/3a12ebaf-89c1-1ac9-6821-3a1de510ef51/mzaf_14543910941982290973.plus.aac.p.m4a",
    });
  });

  it("reads artist ids from relationships", () => {
    expect(mapSongs(songs.data)[0]?.artistIds).toEqual(["657515"]);
  });

  it("sets explicit only for contentRating 'explicit'", () => {
    expect(mapSongs(topSongs.data).map((t) => t.explicit)).toEqual([
      true,
      false,
    ]);
  });

  it("keeps a song with missing optional attributes", () => {
    const bare: AppleSong = {
      id: "1",
      attributes: { name: "Song", artistName: "Mumford & Sons" },
    };
    expect(mapSong(bare)).toEqual({
      appleSongId: "1",
      isrc: undefined,
      title: "Song",
      artistName: "Mumford & Sons",
      artistIds: [],
      album: "",
      durationMs: 0,
      explicit: false,
      artworkUrl: undefined,
      previewUrl: undefined,
    });
  });

  it("skips songs without a name or artist", () => {
    expect(mapSong({ id: "1", attributes: { artistName: "A" } })).toBe(
      undefined,
    );
    expect(mapSong({ id: "2" })).toBe(undefined);
    expect(mapSongs([{ id: "2" }])).toEqual([]);
  });

  it("treats undefined input as no songs", () => {
    expect(mapSongs(undefined)).toEqual([]);
  });
});
