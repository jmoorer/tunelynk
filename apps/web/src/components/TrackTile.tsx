import type { RunTrack } from "@tunelynk/shared";
import { artwork } from "../lib/format";

export function TrackTile({
  track,
  index,
  playing,
  progress,
  onToggle,
}: {
  track: RunTrack;
  index: number;
  playing: boolean;
  progress: number;
  onToggle: (track: RunTrack) => void;
}) {
  const art = artwork(track.artworkUrl, 600);
  return (
    <button
      type="button"
      onClick={() => onToggle(track)}
      disabled={!track.previewUrl}
      aria-pressed={playing}
      aria-label={`${playing ? "Pause" : "Play"} ${track.title} by ${track.artistName}`}
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
        {track.previewUrl && (
          <div
            className={`absolute inset-0 flex items-center justify-center bg-black/40 transition ${playing ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          >
            <span className="flex size-14 items-center justify-center rounded-full bg-white text-xl text-zinc-950 shadow-xl">
              {playing ? "❚❚" : "▶"}
            </span>
          </div>
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
