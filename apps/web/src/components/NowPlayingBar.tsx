import type { RunTrack } from "@tunelynk/shared";
import type { PreviewPlayer } from "../hooks/usePreviewPlayer";

export function NowPlayingBar({
  player,
  tracks,
}: {
  player: PreviewPlayer;
  tracks: RunTrack[];
}) {
  const track = player.current;
  if (!track) return null;
  const playable = tracks.filter(
    (t) => t.previewUrl && !player.failed.has(t.appleSongId),
  );
  const index = playable.findIndex((t) => t.appleSongId === track.appleSongId);
  const next = playable[(index + 1) % playable.length];

  return (
    <section
      aria-label="Now playing"
      className="fixed inset-x-4 bottom-4 z-30 mx-auto flex max-w-3xl items-center gap-4 rounded-2xl border border-white/10 bg-zinc-900/95 p-3 text-white shadow-2xl backdrop-blur"
    >
      {track.artworkUrl && (
        <img src={track.artworkUrl} alt="" className="size-12 rounded-lg" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{track.title}</p>
        <p className="truncate text-sm text-white/50">
          {track.artistName} ·{" "}
          {player.status === "loading" ? "Loading…" : "30s preview"}
        </p>
        <div className="mt-1.5 h-1 rounded bg-white/10">
          <div
            className="h-1 rounded bg-fuchsia-500"
            style={{ width: `${player.progress * 100}%` }}
          />
        </div>
      </div>
      <button
        type="button"
        aria-label="Pause"
        onClick={player.stop}
        className="flex size-10 items-center justify-center rounded-full bg-white text-zinc-950"
      >
        ❚❚
      </button>
      {next && next.appleSongId !== track.appleSongId && (
        <button
          type="button"
          aria-label="Next track"
          onClick={() => player.toggle(next)}
          className="px-2 text-white/70 hover:text-white"
        >
          ⏭
        </button>
      )}
    </section>
  );
}
