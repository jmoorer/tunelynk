import type { RunTrack } from "@tunelynk/shared";
import { useCallback, useEffect, useRef, useState } from "react";

export type PlaybackStatus = "idle" | "loading" | "playing";
// "unavailable": the clip couldn't load (blocked request, bad source).
// "autoplay-blocked": the browser refused to start audio; a retry can work.
export type PlaybackIssue = "unavailable" | "autoplay-blocked";

export type PreviewPlayer = {
  current: RunTrack | null;
  status: PlaybackStatus;
  progress: number;
  failed: ReadonlySet<string>;
  issue: PlaybackIssue | null;
  toggle(track: RunTrack): void;
  stop(): void;
  dismissIssue(): void;
};

const isAutoplayBlock = (err: unknown) =>
  err instanceof DOMException && err.name === "NotAllowedError";

// One shared <audio>: one 30 s clip at a time.
export function usePreviewPlayer(): PreviewPlayer {
  const audio = useRef<HTMLAudioElement | null>(null);
  const currentRef = useRef<RunTrack | null>(null);
  const [current, setCurrentState] = useState<RunTrack | null>(null);
  const [status, setStatus] = useState<PlaybackStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [issue, setIssue] = useState<PlaybackIssue | null>(null);

  const setCurrent = useCallback((track: RunTrack | null) => {
    currentRef.current = track;
    setCurrentState(track);
  }, []);

  const reset = useCallback(() => {
    setCurrent(null);
    setStatus("idle");
    setProgress(0);
  }, [setCurrent]);

  const stop = useCallback(() => {
    audio.current?.pause();
    reset();
  }, [reset]);

  // Only the track that is still current may report a failure; a late
  // rejection from a track the user already switched away from is ignored.
  const fail = useCallback(
    (track: RunTrack, err: unknown, mediaError: MediaError | null) => {
      if (currentRef.current?.appleSongId !== track.appleSongId) return;
      console.warn("Preview playback failed", {
        track: track.appleSongId,
        error: err instanceof Error ? err.name : String(err),
        mediaError: mediaError?.code ?? null,
      });
      if (isAutoplayBlock(err)) {
        setIssue("autoplay-blocked");
      } else {
        setFailed((prev) => new Set(prev).add(track.appleSongId));
        setIssue("unavailable");
      }
      reset();
    },
    [reset],
  );

  useEffect(() => {
    const el = new Audio();
    audio.current = el;
    const onTime = () =>
      setProgress(el.duration ? el.currentTime / el.duration : 0);
    const onEnd = () => reset();
    const onError = () => {
      const track = currentRef.current;
      if (track) fail(track, new Error("MediaError"), el.error);
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("ended", onEnd);
    el.addEventListener("error", onError);
    return () => {
      el.pause();
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("ended", onEnd);
      el.removeEventListener("error", onError);
      audio.current = null;
    };
  }, [reset, fail]);

  const toggle = useCallback(
    (track: RunTrack) => {
      const el = audio.current;
      if (!el || !track.previewUrl || failed.has(track.appleSongId)) return;
      if (currentRef.current?.appleSongId === track.appleSongId) {
        stop();
        return;
      }
      el.src = track.previewUrl;
      setCurrent(track);
      setStatus("loading");
      setProgress(0);
      el.play().then(
        () => {
          if (currentRef.current?.appleSongId !== track.appleSongId) return;
          setStatus("playing");
          setIssue(null);
        },
        (err: unknown) => fail(track, err, el.error),
      );
    },
    [failed, stop, setCurrent, fail],
  );

  const dismissIssue = useCallback(() => setIssue(null), []);

  return {
    current,
    status,
    progress,
    failed,
    issue,
    toggle,
    stop,
    dismissIssue,
  };
}
