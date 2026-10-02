import type { RunTrack } from "@tunelynk/shared";
import { useCallback, useEffect, useRef, useState } from "react";

export type PreviewPlayer = {
  current: RunTrack | null;
  progress: number;
  toggle(track: RunTrack): void;
  stop(): void;
};

// One shared <audio>: one 30 s clip at a time.
export function usePreviewPlayer(): PreviewPlayer {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState<RunTrack | null>(null);
  const [progress, setProgress] = useState(0);

  const stop = useCallback(() => {
    audio.current?.pause();
    setCurrent(null);
    setProgress(0);
  }, []);

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
      audio.current = null;
    };
  }, []);

  const toggle = useCallback(
    (track: RunTrack) => {
      const el = audio.current;
      if (!el || !track.previewUrl) return;
      if (current?.appleSongId === track.appleSongId) {
        stop();
        return;
      }
      el.src = track.previewUrl;
      setCurrent(track);
      setProgress(0);
      el.play().catch(() => {
        setCurrent((c) => (c?.appleSongId === track.appleSongId ? null : c));
      });
    },
    [current, stop],
  );

  return { current, progress, toggle, stop };
}
