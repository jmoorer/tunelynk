import type { RunResponse, RunTrack } from "@tunelynk/shared";

export const IDS = {
  run: "6f1c2a8e-3b7d-4c55-9a10-2f4e8d6b1c33",
  playlist: "0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d",
  otherRun: "11111111-2222-4333-8444-555555555555",
  otherPlaylist: "66666666-7777-4888-9999-000000000000",
};

export function makeTrack(
  n: number,
  overrides: Partial<RunTrack> = {},
): RunTrack {
  return {
    position: n,
    appleSongId: `song-${n}`,
    title: `Song ${n}`,
    artistName: `Artist ${n}`,
    album: `Album ${n}`,
    artworkUrl: `https://img.example/${n}/300x300bb.jpg`,
    previewUrl: `https://audio.example/${n}.m4a`,
    durationMs: 200_000,
    explicit: false,
    source: "llm",
    ...overrides,
  };
}

export function makeRun(overrides: Partial<RunResponse> = {}): RunResponse {
  return {
    id: IDS.run,
    status: "draft",
    stage: null,
    error: null,
    playlist: {
      id: IDS.playlist,
      name: "Sunday Drive",
      prompt: "sunday drive",
    },
    tracks: [makeTrack(1), makeTrack(2)],
    unmatched: [],
    ...overrides,
  };
}
