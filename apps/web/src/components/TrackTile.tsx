import type { RunTrack } from "@tunelynk/shared";
import { artwork } from "../lib/format";

export function TrackTile({
  track,
  index,
  playing,
  loading = false,
  unavailable = false,
  progress,
  onToggle,
}: {
  track: RunTrack;
  index: number;
  playing: boolean;
  loading?: boolean;
  unavailable?: boolean;
  progress: number;
  onToggle: (track: RunTrack) => void;
}) {
  const art = artwork(track.artworkUrl, 600);
  const playable = Boolean(track.previewUrl) && !unavailable;
  const label = unavailable
    ? `${track.title} by ${track.artistName}, preview unavailable`
    : `${playing ? "Pause" : "Play"} ${track.title} by ${track.artistName}`;
  return (
    <button
      type="button"
      onClick={() => onToggle(track)}
      disabled={!playable}
      aria-pressed={playing}
      aria-busy={loading}
      aria-label={label}
      className="group animate-[tile-in_0.4s_ease-out_both] text-left disabled:cursor-default"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <div
        className={`relative aspect-square overflow-hidden rounded-xl bg-white/5 ${playing ? "ring-4 ring-fuchsia-500" : ""}`}
      >
        {art && (
          <img
            src={art}
            alt=""
            loading="lazy"
            className="size-full object-cover transition group-hover:scale-105"
          />
        )}
        {playable && (
          <div
            className={`absolute inset-0 flex items-center justify-center bg-black/40 transition ${playing ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          >
            <span className="flex size-14 items-center justify-center rounded-full bg-white text-xl text-zinc-950 shadow-xl">
              {loading ? (
                <span
                  data-testid="tile-spinner"
                  className="size-6 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-950"
                />
              ) : playing ? (
                "❚❚"
              ) : (
                "▶"
              )}
            </span>
          </div>
        )}
        {unavailable && (
          <span className="absolute inset-x-2 bottom-2 rounded-md bg-black/70 px-2 py-1 text-center text-xs text-white/80">
            Preview unavailable
          </span>
        )}
        {playing && (
          <span
            className="absolute bottom-0 left-0 h-1 bg-fuchsia-500"
            style={{ width: `${progress * 100}%` }}
          />
        )}
      </div>
      <p className="mt-3 truncate font-semibold">{track.title}</p>
      <p className="truncate text-sm text-white/50">
        {track.explicit && (
          <span className="mr-1 rounded bg-white/20 px-1 text-[10px] text-white">
            E
          </span>
        )}
        {track.artistName}
      </p>
    </button>
  );
}
