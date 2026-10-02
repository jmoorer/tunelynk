import type { RunTrack } from "@tunelynk/shared";
import type { PreviewPlayer } from "../hooks/usePreviewPlayer";
import { TrackTile } from "./TrackTile";

const SKELETON_KEYS = Array.from({ length: 20 }, (_, i) => `skeleton-${i}`);

export function TrackGrid({
  tracks,
  player,
}: {
  tracks: RunTrack[] | null;
  player: PreviewPlayer;
}) {
  return (
    <div
      aria-busy={tracks === null}
      className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5"
    >
      {tracks === null
        ? SKELETON_KEYS.map((key, i) => (
            <div key={key} data-testid="skeleton-tile">
              <div
                className="aspect-square animate-pulse rounded-xl bg-white/10"
                style={{ animationDelay: `${i * 60}ms` }}
              />
              <div className="mt-3 h-3 w-3/4 rounded bg-white/10" />
              <div className="mt-2 h-3 w-1/2 rounded bg-white/5" />
            </div>
          ))
        : tracks.map((track, i) => {
            const playing = player.current?.appleSongId === track.appleSongId;
            return (
              <TrackTile
                key={track.appleSongId}
                track={track}
                index={i}
                playing={playing}
                progress={playing ? player.progress : 0}
                onToggle={player.toggle}
              />
            );
          })}
    </div>
  );
}
