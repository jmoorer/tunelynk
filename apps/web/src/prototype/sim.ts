// PROTOTYPE (issue #10 slice D UI spike) — throwaway. Simulates the run
// lifecycle with a real captured run so variants can be judged without the API.
import type { RunResponse, RunTrack } from "@tunelynk/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import fixture from "./fixture.json";

export type Phase = "idle" | "queued" | "llm" | "matching" | "draft" | "failed";

export const EXAMPLES = [
  "upbeat 90s road trip",
  "rainy sunday morning jazz",
  "2000s pop punk anthems",
  "deep focus electronic",
];

const REFUSAL = "That doesn't look like a playlist request.";
const fast = new URLSearchParams(window.location.search).has("fast");
const scale = fast ? 0.25 : 1;

// Timings from the real end-to-end run: LLM ~8 s, matching ~3 s.
const TIMELINE: [Phase, number][] = [
  ["queued", 0],
  ["llm", 400],
  ["matching", 8000],
  ["draft", 11000],
];

export function useSimulatedRun() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [prompt, setPrompt] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const startedAt = useRef(0);

  const clear = () => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: prototype; clear only touches a ref
  const start = useCallback((text: string) => {
    clear();
    setPrompt(text.trim());
    setElapsed(0);
    startedAt.current = Date.now();
    // Typing "python" or "code" demos the refusal path.
    if (/python|code|script/i.test(text)) {
      setPhase("llm");
      timers.current.push(setTimeout(() => setPhase("failed"), 2000 * scale));
      return;
    }
    for (const [next, at] of TIMELINE) {
      timers.current.push(setTimeout(() => setPhase(next), at * scale));
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: prototype; clear only touches a ref
  const reset = useCallback(() => {
    clear();
    setPhase("idle");
    setPrompt("");
  }, []);

  const running = phase === "queued" || phase === "llm" || phase === "matching";
  useEffect(() => {
    if (!running) return;
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)),
      250,
    );
    return () => clearInterval(id);
  }, [running]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: prototype; clear only touches a ref
  useEffect(() => clear, []);

  const run: RunResponse | null =
    phase === "draft"
      ? {
          ...(fixture as RunResponse),
          playlist: { ...(fixture as RunResponse).playlist, prompt },
        }
      : null;

  return {
    phase,
    prompt,
    elapsed,
    running,
    run,
    error: phase === "failed" ? REFUSAL : null,
    start,
    reset,
  };
}

export type SimulatedRun = ReturnType<typeof useSimulatedRun>;

export const stageLabel: Record<Phase, string> = {
  idle: "",
  queued: "Starting…",
  llm: "Asking the AI…",
  matching: "Finding tracks on Apple Music…",
  draft: "Done",
  failed: "Failed",
};

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function totalDuration(tracks: RunTrack[]): string {
  const minutes = Math.round(
    tracks.reduce((sum, t) => sum + t.durationMs, 0) / 60000,
  );
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min`
    : `${minutes} min`;
}

export const art = (url: string | null, size: number) =>
  url?.replace("300x300", `${size}x${size}`) ?? null;

// One shared <audio>: one clip at a time, stops at the end of the clip.
export function usePreviewPlayer() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState<RunTrack | null>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const el = new Audio();
    audio.current = el;
    const onTime = () =>
      setProgress(el.duration ? el.currentTime / el.duration : 0);
    const onEnd = () => {
      setCurrent(null);
      setProgress(0);
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("ended", onEnd);
    return () => {
      el.pause();
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("ended", onEnd);
    };
  }, []);

  const toggle = useCallback(
    (track: RunTrack) => {
      const el = audio.current;
      if (!el || !track.previewUrl) return;
      if (current?.appleSongId === track.appleSongId) {
        el.pause();
        setCurrent(null);
        setProgress(0);
        return;
      }
      el.src = track.previewUrl;
      void el.play();
      setCurrent(track);
      setProgress(0);
    },
    [current],
  );

  const stop = useCallback(() => {
    audio.current?.pause();
    setCurrent(null);
    setProgress(0);
  }, []);

  return { current, progress, toggle, stop };
}

export type PreviewPlayer = ReturnType<typeof usePreviewPlayer>;
