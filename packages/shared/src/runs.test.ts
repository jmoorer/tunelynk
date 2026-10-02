import { describe, expect, it } from "vitest";
import {
  ApiError,
  CreateRunRequest,
  PROMPT_MAX_LENGTH,
  RunResponse,
} from "./runs";

describe("CreateRunRequest", () => {
  it("trims the prompt", () => {
    expect(CreateRunRequest.parse({ prompt: "  road trip  " })).toEqual({
      prompt: "road trip",
    });
  });

  it("accepts exactly 280 characters", () => {
    const prompt = "x".repeat(PROMPT_MAX_LENGTH);
    expect(CreateRunRequest.parse({ prompt }).prompt).toHaveLength(280);
  });

  it.each([
    ["empty", { prompt: "" }],
    ["whitespace only", { prompt: "   " }],
    ["281 characters", { prompt: "x".repeat(281) }],
    ["missing", {}],
    ["not a string", { prompt: 42 }],
  ])("rejects %s", (_label, body) => {
    expect(CreateRunRequest.safeParse(body).success).toBe(false);
  });
});

describe("RunResponse", () => {
  it("parses a draft run", () => {
    const run = {
      id: "6f1c2a8e-3b7d-4c55-9a10-2f4e8d6b1c33",
      status: "draft",
      stage: null,
      error: null,
      playlist: {
        id: "0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d",
        name: "90s Road Trip",
        prompt: "upbeat 90s road trip",
      },
      tracks: [
        {
          position: 1,
          appleSongId: "1109715168",
          title: "Weird Fishes / Arpeggi",
          artistName: "Radiohead",
          album: "In Rainbows",
          artworkUrl: "https://example.com/300x300bb.jpg",
          previewUrl: null,
          durationMs: 318187,
          explicit: false,
          source: "llm",
        },
      ],
      unmatched: [{ title: "Beautiful", artist: "Suede" }],
    };
    expect(RunResponse.parse(run)).toEqual(run);
  });
});

describe("ApiError", () => {
  it("allows run ids on run_in_progress", () => {
    expect(
      ApiError.parse({
        error: "run_in_progress",
        runId: "6f1c2a8e-3b7d-4c55-9a10-2f4e8d6b1c33",
        playlistId: "0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d",
      }).error,
    ).toBe("run_in_progress");
  });
});
