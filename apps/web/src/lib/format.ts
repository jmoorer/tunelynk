import type { RunStage, RunTrack } from "@tunelynk/shared";

// Apple artwork URLs embed their size ("…/300x300bb.jpg").
export const artwork = (url: string | null, size: number): string | null =>
  url ? url.replace("300x300", `${size}x${size}`) : null;

export function formatTotalDuration(tracks: RunTrack[]): string {
  const minutes = Math.round(
    tracks.reduce((sum, t) => sum + t.durationMs, 0) / 60_000,
  );
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min`
    : `${minutes} min`;
}

export function stageLabel(stage: RunStage | null): string {
  if (stage === "llm") return "Asking the AI…";
  if (stage === "matching") return "Finding tracks on Apple Music…";
  return "Starting…";
}

export const runPath = (playlistId: string, runId: string) =>
  `/playlists/${playlistId}/runs/${runId}`;
