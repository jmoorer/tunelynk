// PROTOTYPE — Variant B: visual grid. Prompt in a top bar, skeleton tiles that
// fill in, album-art grid with hover-to-play and a sticky now-playing bar.
import { PROMPT_MAX_LENGTH } from "@tunelynk/shared";
import { useState } from "react";
import {
  art,
  EXAMPLES,
  type PreviewPlayer,
  type SimulatedRun,
  stageLabel,
  totalDuration,
} from "./sim";

export const name = "Visual grid";

export function VariantB({
  sim,
  player,
}: {
  sim: SimulatedRun;
  player: PreviewPlayer;
}) {
  const [text, setText] = useState("");
  const submit = (value = text) => {
    if (!value.trim()) return;
    setText(value);
    player.stop();
    sim.start(value);
  };
  const tracks = sim.run?.tracks ?? [];
  const nowIndex = tracks.findIndex(
    (t) => t.appleSongId === player.current?.appleSongId,
  );

  return (
    <main className="min-h-screen bg-zinc-950 pb-40 text-white">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-zinc-950/80 backdrop-blur">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-3"
        >
          <span className="bg-gradient-to-r from-fuchsia-400 to-amber-300 bg-clip-text font-black text-transparent">
            tunelynk
          </span>
          <input
            value={text}
            maxLength={PROMPT_MAX_LENGTH}
            onChange={(e) => setText(e.target.value)}
            placeholder="What's the vibe?"
            className="flex-1 rounded-full bg-white/10 px-5 py-2.5 outline-none placeholder:text-white/40 focus:bg-white/15"
          />
          <button
            type="submit"
            disabled={!text.trim() || sim.running}
            className="rounded-full bg-white px-5 py-2.5 font-semibold text-zinc-950 disabled:opacity-40"
          >
            {sim.running ? `${sim.elapsed}s` : "Generate"}
          </button>
        </form>
      </header>

      <section className="mx-auto max-w-6xl px-6 pt-10">
        {sim.phase === "idle" && (
          <div className="py-24 text-center">
            <h1 className="text-5xl font-black tracking-tight sm:text-7xl">
              Type a vibe.
              <br />
              <span className="bg-gradient-to-r from-fuchsia-400 via-rose-400 to-amber-300 bg-clip-text text-transparent">
                Get a playlist.
              </span>
            </h1>
            <div className="mt-10 flex flex-wrap justify-center gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => submit(ex)}
                  className="rounded-full bg-white/10 px-4 py-2 text-sm hover:bg-white/20"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {sim.error && (
          <div className="py-24 text-center">
            <p className="text-2xl font-bold">{sim.error}</p>
            <p className="mt-2 text-white/50">
              Try describing a mood, a decade, an activity…
            </p>
          </div>
        )}

        {(sim.running || sim.run) && (
          <>
            <div className="mb-8 flex items-end justify-between gap-6">
              <div>
                <p className="text-sm text-white/50">“{sim.prompt}”</p>
                <h1 className="mt-1 text-4xl font-black">
                  {sim.run ? (
                    sim.run.playlist.name
                  ) : (
                    <span className="animate-pulse text-white/40">
                      {stageLabel[sim.phase]}
                    </span>
                  )}
                </h1>
                {sim.run && (
                  <p className="mt-1 text-sm text-white/50">
                    {tracks.length} tracks · {totalDuration(tracks)}
                  </p>
                )}
              </div>
              {sim.run && (
                <button
                  type="button"
                  disabled
                  className="shrink-0 rounded-full border border-white/30 px-5 py-2.5 text-sm opacity-50"
                >
                  Sign in to keep
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5">
              {(sim.run ? tracks : Array.from({ length: 20 }, () => null)).map(
                (t, i) => {
                  if (!t) {
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: prototype skeleton tiles are static
                      <div key={`skeleton-${i}`}>
                        <div
                          className="aspect-square animate-pulse rounded-xl bg-white/10"
                          style={{ animationDelay: `${i * 60}ms` }}
                        />
                        <div className="mt-3 h-3 w-3/4 rounded bg-white/10" />
                        <div className="mt-2 h-3 w-1/2 rounded bg-white/5" />
                      </div>
                    );
                  }
                  const playing = player.current?.appleSongId === t.appleSongId;
                  return (
                    <button
                      key={t.appleSongId}
                      type="button"
                      onClick={() => player.toggle(t)}
                      className="group animate-[fadein_0.4s_ease-out_both] text-left"
                      style={{ animationDelay: `${i * 40}ms` }}
                    >
                      <div
                        className={`relative aspect-square overflow-hidden rounded-xl ${playing ? "ring-4 ring-fuchsia-500" : ""}`}
                      >
                        <img
                          src={art(t.artworkUrl, 600) ?? ""}
                          alt=""
                          className="size-full object-cover transition group-hover:scale-105"
                        />
                        <div
                          className={`absolute inset-0 flex items-center justify-center bg-black/40 transition ${playing ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                        >
                          <span className="flex size-14 items-center justify-center rounded-full bg-white text-xl text-zinc-950 shadow-xl">
                            {playing ? "❚❚" : "▶"}
                          </span>
                        </div>
                        {playing && (
                          <span
                            className="absolute bottom-0 left-0 h-1 bg-fuchsia-500"
                            style={{ width: `${player.progress * 100}%` }}
                          />
                        )}
                      </div>
                      <p className="mt-3 truncate font-semibold">{t.title}</p>
                      <p className="truncate text-sm text-white/50">
                        {t.artistName}
                      </p>
                    </button>
                  );
                },
              )}
            </div>

            {sim.run && sim.run.unmatched.length > 0 && (
              <p className="mt-10 text-sm text-white/40">
                Couldn't find on Apple Music:{" "}
                {sim.run.unmatched
                  .map((u) => `${u.title} (${u.artist})`)
                  .join(", ")}
              </p>
            )}
          </>
        )}
      </section>

      {player.current && (
        <div className="fixed inset-x-0 bottom-16 z-30 mx-auto flex max-w-3xl items-center gap-4 rounded-2xl border border-white/10 bg-zinc-900/95 p-3 shadow-2xl backdrop-blur">
          <img
            src={player.current.artworkUrl ?? ""}
            alt=""
            className="size-12 rounded-lg"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{player.current.title}</p>
            <p className="truncate text-sm text-white/50">
              {player.current.artistName} · 30s preview
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
            onClick={() => player.stop()}
            className="flex size-10 items-center justify-center rounded-full bg-white text-zinc-950"
          >
            ❚❚
          </button>
          <button
            type="button"
            onClick={() => {
              const next = tracks[(nowIndex + 1) % tracks.length];
              if (next) player.toggle(next);
            }}
            className="px-2 text-white/70 hover:text-white"
          >
            ⏭
          </button>
        </div>
      )}
      <style>
        {
          "@keyframes fadein { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }"
        }
      </style>
    </main>
  );
}
