// PROTOTYPE — Variant A: search-first. Big centered prompt, step indicator
// while waiting, compact numbered tracklist.
import { PROMPT_MAX_LENGTH } from "@tunelynk/shared";
import { useState } from "react";
import {
  EXAMPLES,
  formatDuration,
  type PreviewPlayer,
  type SimulatedRun,
  totalDuration,
} from "./sim";

export const name = "Search-first";

const STEPS = [
  { phase: "queued", label: "Reading your prompt" },
  { phase: "llm", label: "Asking the AI for songs" },
  { phase: "matching", label: "Finding them on Apple Music" },
] as const;

export function VariantA({
  sim,
  player,
}: {
  sim: SimulatedRun;
  player: PreviewPlayer;
}) {
  const [text, setText] = useState("");
  const submit = (value = text) => value.trim() && sim.start(value);

  if (sim.phase === "idle") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-white px-6 pb-32 text-zinc-900">
        <p className="mb-3 text-sm font-semibold tracking-widest text-emerald-600 uppercase">
          Tunelynk
        </p>
        <h1 className="mb-8 text-center text-4xl font-bold tracking-tight sm:text-5xl">
          Describe a playlist.
          <br />
          <span className="text-zinc-400">Hear it in seconds.</span>
        </h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="w-full max-w-2xl"
        >
          <div className="flex items-center gap-2 rounded-2xl border border-zinc-300 p-2 shadow-sm focus-within:border-emerald-500 focus-within:ring-4 focus-within:ring-emerald-100">
            <input
              value={text}
              maxLength={PROMPT_MAX_LENGTH}
              onChange={(e) => setText(e.target.value)}
              placeholder="upbeat 90s road trip…"
              className="flex-1 bg-transparent px-3 py-3 text-lg outline-none"
            />
            <button
              type="submit"
              disabled={!text.trim()}
              className="rounded-xl bg-emerald-600 px-5 py-3 font-semibold text-white disabled:opacity-40"
            >
              Generate
            </button>
          </div>
          <div className="mt-2 flex justify-between px-1 text-xs text-zinc-400">
            <span>Try it free, no account needed</span>
            <span>
              {text.length}/{PROMPT_MAX_LENGTH}
            </span>
          </div>
        </form>
        <div className="mt-8 flex flex-wrap justify-center gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => submit(ex)}
              className="rounded-full border border-zinc-200 px-4 py-1.5 text-sm text-zinc-600 hover:border-emerald-400 hover:text-emerald-700"
            >
              {ex}
            </button>
          ))}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-white pb-32 text-zinc-900">
      <header className="sticky top-0 z-10 border-b border-zinc-100 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-4 px-6 py-3">
          <span className="text-sm font-semibold tracking-widest text-emerald-600 uppercase">
            Tunelynk
          </span>
          <span className="flex-1 truncate rounded-lg bg-zinc-100 px-3 py-1.5 text-sm text-zinc-600">
            {sim.prompt}
          </span>
          <button
            type="button"
            onClick={() => {
              player.stop();
              sim.reset();
            }}
            className="text-sm font-medium text-emerald-700 hover:underline"
          >
            New playlist
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-6 pt-10">
        {sim.running && (
          <ol className="mx-auto max-w-md space-y-4">
            {STEPS.map((step, i) => {
              const activeIndex = STEPS.findIndex((s) => s.phase === sim.phase);
              const done = i < activeIndex;
              const active = i === activeIndex;
              return (
                <li key={step.phase} className="flex items-center gap-3">
                  <span
                    className={`flex size-7 items-center justify-center rounded-full text-sm font-bold ${
                      done
                        ? "bg-emerald-600 text-white"
                        : active
                          ? "border-2 border-emerald-600 text-emerald-700"
                          : "border-2 border-zinc-200 text-zinc-300"
                    }`}
                  >
                    {done ? "✓" : i + 1}
                  </span>
                  <span
                    className={
                      active
                        ? "font-semibold"
                        : done
                          ? "text-zinc-500"
                          : "text-zinc-300"
                    }
                  >
                    {step.label}
                    {active && <span className="ml-2 animate-pulse">…</span>}
                  </span>
                </li>
              );
            })}
            <li className="pt-2 text-center text-sm text-zinc-400">
              {sim.elapsed}s · usually about 15s
            </li>
          </ol>
        )}

        {sim.error && (
          <div className="mx-auto max-w-md rounded-xl border border-red-200 bg-red-50 p-5 text-center">
            <p className="font-semibold text-red-700">{sim.error}</p>
            <button
              type="button"
              onClick={sim.reset}
              className="mt-3 text-sm font-medium text-red-700 underline"
            >
              Try again
            </button>
          </div>
        )}

        {sim.run && (
          <>
            <div className="mb-6">
              <h1 className="text-3xl font-bold">{sim.run.playlist.name}</h1>
              <p className="mt-1 text-sm text-zinc-500">
                {sim.run.tracks.length} tracks · {totalDuration(sim.run.tracks)}{" "}
                · from “{sim.prompt}”
              </p>
            </div>
            <ol className="divide-y divide-zinc-100">
              {sim.run.tracks.map((t) => {
                const playing = player.current?.appleSongId === t.appleSongId;
                return (
                  <li
                    key={t.appleSongId}
                    className={`group relative flex items-center gap-4 rounded-lg px-2 py-2 ${playing ? "bg-emerald-50" : "hover:bg-zinc-50"}`}
                  >
                    <button
                      type="button"
                      disabled={!t.previewUrl}
                      onClick={() => player.toggle(t)}
                      className="w-6 text-right text-sm text-zinc-400 tabular-nums"
                    >
                      <span
                        className={playing ? "hidden" : "group-hover:hidden"}
                      >
                        {t.position}
                      </span>
                      <span
                        className={
                          playing
                            ? "text-emerald-700"
                            : "hidden text-zinc-900 group-hover:inline"
                        }
                      >
                        {playing ? "❚❚" : "▶"}
                      </span>
                    </button>
                    {t.artworkUrl && (
                      <img
                        src={t.artworkUrl}
                        alt=""
                        className="size-10 rounded"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p
                        className={`truncate font-medium ${playing ? "text-emerald-700" : ""}`}
                      >
                        {t.title}
                      </p>
                      <p className="truncate text-sm text-zinc-500">
                        {t.explicit && (
                          <span className="mr-1 rounded bg-zinc-200 px-1 text-[10px]">
                            E
                          </span>
                        )}
                        {t.artistName}
                      </p>
                    </div>
                    <p className="hidden w-56 truncate text-sm text-zinc-400 sm:block">
                      {t.album}
                    </p>
                    <p className="w-12 text-right text-sm text-zinc-400 tabular-nums">
                      {formatDuration(t.durationMs)}
                    </p>
                    {playing && (
                      <span
                        className="absolute bottom-0 left-2 h-0.5 bg-emerald-500"
                        style={{
                          width: `calc(${player.progress * 100}% - 1rem)`,
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ol>
            <details className="mt-6 text-sm text-zinc-500">
              <summary className="cursor-pointer">
                {sim.run.unmatched.length} suggestions weren't found on Apple
                Music
              </summary>
              <ul className="mt-2 list-disc pl-6">
                {sim.run.unmatched.map((u) => (
                  <li key={`${u.title}-${u.artist}`}>
                    {u.title} — {u.artist}
                  </li>
                ))}
              </ul>
            </details>
            <div className="mt-8 flex items-center gap-3 border-t border-zinc-100 pt-6">
              <button
                type="button"
                disabled
                className="rounded-xl bg-zinc-900 px-5 py-3 font-semibold text-white opacity-40"
              >
                Sign in to keep
              </button>
              <span className="text-sm text-zinc-400">
                Coming soon: save and export to Apple Music
              </span>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
