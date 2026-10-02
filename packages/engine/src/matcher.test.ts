import type { CatalogTrack } from "@tunelynk/connectors";
import { describe, expect, it } from "vitest";
import {
  artistScore,
  dice,
  normalize,
  pickBest,
  scoreMatch,
  titleScore,
} from "./matcher";

const track = (
  title: string,
  artistName: string,
  album = "Album",
  appleSongId = title,
): CatalogTrack => ({
  appleSongId,
  title,
  artistName,
  artistIds: [],
  album,
  durationMs: 200_000,
  explicit: false,
});

describe("normalize", () => {
  it.each([
    ["Dreams (2004 Remaster)", "dreams"],
    ["Go Your Own Way - 2004 Remaster", "go your own way"],
    ["Stay (feat. Mikky Ekko)", "stay"],
    ["Rihanna feat. Mikky Ekko", "rihanna"],
    ["María También", "maria tambien"],
    ["Mumford & Sons", "mumford and sons"],
    ["Pink + White", "pink white"],
    ["  Don't   Stop  ", "don t stop"],
    ["Dreams [Bonus Track]", "dreams"],
    ["Dreams - Live", "dreams"],
    ["Плачу на техно", "плачу на техно"],
    ["MØ", "mø"],
  ])("%s → %s", (input, expected) => {
    expect(normalize(input)).toBe(expected);
  });
});

describe("dice", () => {
  it("is 1 for equal strings and 0 for disjoint ones", () => {
    expect(dice("dreams", "dreams")).toBe(1);
    expect(dice("ab", "cd")).toBe(0);
  });

  it("ignores spaces", () => {
    expect(dice("lo fi", "lofi")).toBe(1);
  });

  it("is 0 when either side has no bigrams", () => {
    expect(dice("a", "b")).toBe(0);
    expect(dice("", "dreams")).toBe(0);
  });
});

describe("titleScore / artistScore", () => {
  it("matches one side of a slash title", () => {
    expect(titleScore("Weird Fishes", "Weird Fishes / Arpeggi")).toBe(1);
  });

  it("matches a featured or collaborating artist", () => {
    expect(artistScore("Kendrick Lamar", "Kendrick Lamar & SZA")).toBe(1);
    expect(artistScore("Rihanna feat. Mikky Ekko", "Rihanna")).toBe(1);
  });

  it("matches band names spelled with and or &", () => {
    expect(artistScore("Mumford and Sons", "Mumford & Sons")).toBe(1);
  });
});

describe("scoreMatch", () => {
  const accepted = (title: string, artist: string, t: CatalogTrack) =>
    scoreMatch({ title, artist }, t).accepted;

  it.each([
    ["exact", "Dreams", "Fleetwood Mac", track("Dreams", "Fleetwood Mac")],
    [
      "remaster suffix",
      "Dreams",
      "Fleetwood Mac",
      track("Dreams (2004 Remaster)", "Fleetwood Mac"),
    ],
    [
      "dash remaster",
      "Go Your Own Way",
      "Fleetwood Mac",
      track("Go Your Own Way - 2004 Remaster", "Fleetwood Mac"),
    ],
    [
      "feat in title",
      "Stay",
      "Rihanna feat. Mikky Ekko",
      track("Stay (feat. Mikky Ekko)", "Rihanna"),
    ],
    [
      "multi-artist",
      "All the Stars",
      "Kendrick Lamar",
      track("All the Stars", "Kendrick Lamar & SZA"),
    ],
    [
      "band with &",
      "The Cave",
      "Mumford and Sons",
      track("The Cave", "Mumford & Sons"),
    ],
    [
      "diacritics",
      "Maria Tambien",
      "Khruangbin",
      track("María También", "Khruangbin"),
    ],
    [
      "slash title",
      "Weird Fishes",
      "Radiohead",
      track("Weird Fishes / Arpeggi", "Radiohead"),
    ],
    [
      "requested live",
      "Dreams (Live)",
      "Fleetwood Mac",
      track("Dreams (Live)", "Fleetwood Mac"),
    ],
  ])("accepts: %s", (_label, title, artist, t) => {
    expect(accepted(title, artist, t)).toBe(true);
  });

  it.each([
    [
      "live version",
      "Dreams",
      "Fleetwood Mac",
      track("Dreams (Live)", "Fleetwood Mac"),
    ],
    [
      "live album",
      "Dreams",
      "Fleetwood Mac",
      track("Dreams", "Fleetwood Mac", "Live at the BBC"),
    ],
    [
      "karaoke",
      "Dreams",
      "Fleetwood Mac",
      track("Dreams (Karaoke Version)", "Fleetwood Mac"),
    ],
    [
      "cover by another artist",
      "Hallelujah",
      "Jeff Buckley",
      track("Hallelujah", "Pentatonix"),
    ],
    [
      "tribute act",
      "Dreams",
      "Fleetwood Mac",
      track(
        "Dreams",
        "The Fleetwood Mac Tribute Band",
        "Tribute to Fleetwood Mac",
      ),
    ],
    [
      "different song",
      "Dreams",
      "Fleetwood Mac",
      track("Landslide", "Fleetwood Mac"),
    ],
  ])("rejects: %s", (_label, title, artist, t) => {
    expect(accepted(title, artist, t)).toBe(false);
  });

  it("accepts non-Latin titles and artists", () => {
    expect(
      accepted(
        "真夜中のドア〜stay with me",
        "松原みき",
        track("真夜中のドア〜stay with me", "松原みき"),
      ),
    ).toBe(true);
    expect(
      accepted(
        "Плачу на техно",
        "Cream Soda",
        track("Плачу на техно", "Cream Soda"),
      ),
    ).toBe(true);
    expect(artistScore("MØ", "MØ")).toBe(1);
  });

  it("does not treat albums that merely contain 'live' as live recordings", () => {
    expect(
      accepted(
        "Doll Parts",
        "Hole",
        track("Doll Parts", "Hole", "Live Through This"),
      ),
    ).toBe(true);
    expect(
      accepted(
        "Goldie",
        "A$AP Rocky",
        track("Goldie", "A$AP Rocky", "LONG.LIVE.A$AP (Deluxe Version)"),
      ),
    ).toBe(true);
    expect(
      accepted(
        "Dreams",
        "Fleetwood Mac",
        track("Dreams", "Fleetwood Mac", "MTV Unplugged"),
      ),
    ).toBe(false);
  });

  it("matches variant words as whole words in the candidate title", () => {
    expect(
      accepted("Alive", "Pearl Jam", track("Alive (Live)", "Pearl Jam")),
    ).toBe(false);
  });

  it("applies the 0.3 penalty to the title score only", () => {
    const score = scoreMatch(
      { title: "Dreams", artist: "Fleetwood Mac" },
      track("Dreams (Live)", "Fleetwood Mac"),
    );
    expect(score.title).toBeCloseTo(0.7);
    expect(score.artist).toBe(1);
  });
});

describe("pickBest", () => {
  const candidate = { title: "Dreams", artist: "Fleetwood Mac" };

  it("prefers the studio recording over a live one", () => {
    const live = track("Dreams (Live)", "Fleetwood Mac", "Album", "live");
    const studio = track("Dreams", "Fleetwood Mac", "Rumours", "studio");
    expect(pickBest(candidate, [live, studio])?.appleSongId).toBe("studio");
  });

  it("prefers the studio take when the candidate title only contains 'live' inside a word", () => {
    const live = track("Alive (Live)", "Pearl Jam", "Album", "live");
    const studio = track("Alive", "Pearl Jam", "Ten", "studio");
    expect(
      pickBest({ title: "Alive", artist: "Pearl Jam" }, [live, studio])
        ?.appleSongId,
    ).toBe("studio");
  });

  it("keeps search order on ties", () => {
    const a = track("Dreams", "Fleetwood Mac", "Rumours", "a");
    const b = track("Dreams", "Fleetwood Mac", "Greatest Hits", "b");
    expect(pickBest(candidate, [a, b])?.appleSongId).toBe("a");
  });

  it("returns undefined when nothing is accepted", () => {
    expect(pickBest(candidate, [track("Landslide", "Fleetwood Mac")])).toBe(
      undefined,
    );
    expect(pickBest(candidate, [])).toBe(undefined);
  });
});
