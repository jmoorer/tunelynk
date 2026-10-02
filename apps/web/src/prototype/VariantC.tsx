// PROTOTYPE — Variant C: conversational. The prompt is a chat message; the
// assistant narrates progress, and the playlist arrives as a message card.
import { PROMPT_MAX_LENGTH } from "@tunelynk/shared";
import { useEffect, useRef, useState } from "react";
import {
  art,
  EXAMPLES,
  formatDuration,
  type Phase,
  type PreviewPlayer,
  type SimulatedRun,
  totalDuration,
} from "./sim";

export const name = "Conversational";

const NARRATION: Partial<Record<Phase, string>> = {
  llm: "Got it. Asking the AI for about 30 songs that fit…",
  matching:
    "Checking each one against Apple Music so every track is real and playable…",
};
const ORDER: Phase[] = ["llm", "matching"];

export function VariantC({
  sim,
  player,
}: {
  sim: SimulatedRun;
  player: PreviewPlayer;
}) {
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const submit = (value = text) => {
    if (!value.trim()) return;
    player.stop();
    setExpanded(false);
    setText("");
    sim.start(value);
  };

  const reached = ORDER.filter((p) => {
    const at = ORDER.indexOf(p);
    const now =
      sim.phase === "draft" || sim.phase === "failed"
        ? ORDER.length
        : ORDER.indexOf(sim.phase);
    return at <= now && (sim.phase !== "failed" || p === "llm");
  });

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  });

  const tracks = sim.run?.tracks ?? [];
  const shown = expanded ? tracks : tracks.slice(0, 6);

  return (
    <main className="flex min-h-screen flex-col bg-stone-100 text-stone-900">
      <header className="border-b border-stone-200 bg-stone-100/90 px-6 py-3 text-center text-sm font-semibold backdrop-blur">
        🎧 Tunelynk
      </header>

      <div className="mx-auto w-full max-w-2xl flex-1 space-y-4 px-4 py-6 pb-56">
        <Bubble from="bot">
          Hi! Tell me what you want to listen to: a mood, a decade, an activity,
          a few artists. I'll build a playlist of real tracks you can preview
          right here.
          {sim.phase === "idle" && (
            <div className="mt-3 flex flex-wrap gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => submit(ex)}
                  className="rounded-full border border-stone-300 bg-white px-3 py-1 text-sm hover:border-orange-400"
                >
                  {ex}
                </button>
              ))}
            </div>
          )}
        </Bubble>

        {sim.prompt && <Bubble from="user">{sim.prompt}</Bubble>}

        {reached.map((p) => (
          <Bubble key={p} from="bot" muted={sim.phase !== p}>
            {NARRATION[p]}
            {sim.phase === p && (
              <span className="ml-1 inline-block animate-pulse">●●●</span>
            )}
          </Bubble>
        ))}

        {sim.error && (
          <Bubble from="bot">
            Hmm. {sim.error} Try something like “sunny afternoon indie” or
            “songs for a dinner party”.
          </Bubble>
        )}

        {sim.run && (
          <Bubble from="bot" wide>
            <p className="mb-3">
              Here's what I found: {tracks.length} tracks. Tap any song to hear
              a 30-second preview.
            </p>
            <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white">
              <div className="flex items-center gap-4 bg-gradient-to-br from-orange-100 to-rose-100 p-4">
                <div className="grid size-20 shrink-0 grid-cols-2 overflow-hidden rounded-lg">
                  {tracks.slice(0, 4).map((t) => (
                    <img
                      key={t.appleSongId}
                      src={art(t.artworkUrl, 100) ?? ""}
                      alt=""
                      className="size-10 object-cover"
                    />
                  ))}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-lg font-bold">
                    {sim.run.playlist.name}
                  </p>
                  <p className="text-sm text-stone-600">
                    {tracks.length} tracks · {totalDuration(tracks)}
                  </p>
                </div>
              </div>
              <ul>
                {shown.map((t) => {
                  const playing = player.current?.appleSongId === t.appleSongId;
                  return (
                    <li key={t.appleSongId}>
                      <button
                        type="button"
                        onClick={() => player.toggle(t)}
                        className={`relative flex w-full items-center gap-3 px-4 py-2 text-left ${playing ? "bg-orange-50" : "hover:bg-stone-50"}`}
                      >
                        <span
                          className={`flex size-8 shrink-0 items-center justify-center rounded-full text-xs ${playing ? "bg-orange-500 text-white" : "bg-stone-100"}`}
                        >
                          {playing ? "❚❚" : "▶"}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {t.title}
                          </span>
                          <span className="block truncate text-xs text-stone-500">
                            {t.artistName}
                          </span>
                        </span>
                        <span className="text-xs text-stone-400 tabular-nums">
                          {formatDuration(t.durationMs)}
                        </span>
                        {playing && (
                          <span
                            className="absolute bottom-0 left-0 h-0.5 bg-orange-500"
                            style={{ width: `${player.progress * 100}%` }}
                          />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {tracks.length > 6 && (
                <button
                  type="button"
                  onClick={() => setExpanded((e) => !e)}
                  className="w-full border-t border-stone-100 py-2 text-sm font-medium text-orange-700 hover:bg-stone-50"
                >
                  {expanded ? "Show less" : `Show all ${tracks.length}`}
                </button>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {["Sign in to keep it", "Make it longer", "More deep cuts"].map(
                (label) => (
                  <button
                    key={label}
                    type="button"
                    disabled
                    className="rounded-full border border-stone-300 bg-white px-3 py-1 text-sm opacity-50"
                  >
                    {label}
                  </button>
                ),
              )}
            </div>
          </Bubble>
        )}
        <div ref={bottom} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="fixed inset-x-0 bottom-16 mx-auto flex w-full max-w-2xl items-end gap-2 px-4"
      >
        <div className="flex flex-1 items-center rounded-3xl border border-stone-300 bg-white px-4 py-2 shadow-lg focus-within:border-orange-400">
          <input
            value={text}
            maxLength={PROMPT_MAX_LENGTH}
            onChange={(e) => setText(e.target.value)}
            disabled={sim.running}
            placeholder={
              sim.running
                ? "Working on it…"
                : sim.run
                  ? "Describe another playlist…"
                  : "Describe a playlist…"
            }
            className="flex-1 bg-transparent py-1.5 outline-none"
          />
          <span className="ml-2 text-xs text-stone-400">
            {PROMPT_MAX_LENGTH - text.length}
          </span>
        </div>
        <button
          type="submit"
          disabled={!text.trim() || sim.running}
          className="flex size-12 items-center justify-center rounded-full bg-orange-500 text-xl text-white shadow-lg disabled:opacity-40"
        >
          ↑
        </button>
      </form>
    </main>
  );
}

function Bubble({
  from,
  children,
  muted = false,
  wide = false,
}: {
  from: "bot" | "user";
  children: React.ReactNode;
  muted?: boolean;
  wide?: boolean;
}) {
  if (from === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-3xl rounded-br-md bg-orange-500 px-4 py-2.5 text-white">
          {children}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-stone-900 text-sm text-white">
        ♪
      </span>
      <div
        className={`${wide ? "w-full" : "max-w-[80%]"} rounded-3xl rounded-tl-md bg-white px-4 py-2.5 shadow-sm ${muted ? "text-stone-500" : ""}`}
      >
        {children}
      </div>
    </div>
  );
}
