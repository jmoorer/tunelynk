import { describe, expect, it } from "vitest";
import { makeTrack } from "../test/fixtures";
import { artwork, formatTotalDuration, runPath, stageLabel } from "./format";

describe("format helpers", () => {
  it("resizes Apple artwork URLs", () => {
    expect(artwork("https://img/a/300x300bb.jpg", 600)).toBe(
      "https://img/a/600x600bb.jpg",
    );
    expect(artwork(null, 600)).toBe(null);
  });

  it("formats total duration", () => {
    const tracks = (minutes: number) => [
      makeTrack(1, { durationMs: minutes * 60_000 }),
    ];
    expect(formatTotalDuration(tracks(42))).toBe("42 min");
    expect(formatTotalDuration(tracks(72))).toBe("1 hr 12 min");
    expect(formatTotalDuration([])).toBe("0 min");
  });

  it("labels stages", () => {
    expect(stageLabel("llm")).toBe("Asking the AI…");
    expect(stageLabel("matching")).toBe("Finding tracks on Apple Music…");
    expect(stageLabel(null)).toBe("Starting…");
    expect(stageLabel("taste")).toBe("Starting…");
  });

  it("builds run paths", () => {
    expect(runPath("p", "r")).toBe("/playlists/p/runs/r");
  });
});
