import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeTrack } from "../test/fixtures";
import { usePreviewPlayer } from "./usePreviewPlayer";

function capturePlayer() {
  let element: HTMLMediaElement | undefined;
  const play = vi
    .spyOn(window.HTMLMediaElement.prototype, "play")
    .mockImplementation(function (this: HTMLMediaElement) {
      element = this;
      return Promise.resolve();
    });
  const pause = vi.spyOn(window.HTMLMediaElement.prototype, "pause");
  return { play, pause, element: () => element };
}

describe("usePreviewPlayer", () => {
  it("plays, pauses on a second toggle, and switches tracks", () => {
    const audio = capturePlayer();
    const { result } = renderHook(() => usePreviewPlayer());
    const [a, b] = [makeTrack(1), makeTrack(2)];

    act(() => result.current.toggle(a));
    expect(result.current.current).toBe(a);
    expect(audio.element()?.src).toBe("https://audio.example/1.m4a");

    act(() => result.current.toggle(b));
    expect(result.current.current).toBe(b);
    expect(audio.element()?.src).toBe("https://audio.example/2.m4a");

    act(() => result.current.toggle(b));
    expect(result.current.current).toBe(null);
    expect(audio.pause).toHaveBeenCalled();
  });

  it("ignores tracks without a preview", () => {
    const audio = capturePlayer();
    const { result } = renderHook(() => usePreviewPlayer());
    act(() => result.current.toggle(makeTrack(1, { previewUrl: null })));
    expect(result.current.current).toBe(null);
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("resets when the clip ends and tracks progress", () => {
    const audio = capturePlayer();
    const { result } = renderHook(() => usePreviewPlayer());
    act(() => result.current.toggle(makeTrack(1)));
    const el = audio.element();
    if (!el) throw new Error("no audio element");
    Object.defineProperty(el, "duration", { value: 30, configurable: true });
    Object.defineProperty(el, "currentTime", { value: 15, configurable: true });
    act(() => el.dispatchEvent(new Event("timeupdate")));
    expect(result.current.progress).toBe(0.5);
    act(() => el.dispatchEvent(new Event("ended")));
    expect(result.current.current).toBe(null);
    expect(result.current.progress).toBe(0);
  });

  it("is loading until play() resolves, then playing", async () => {
    let resolve: () => void = () => {};
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockReturnValue(
      new Promise<void>((r) => (resolve = r)),
    );
    const { result } = renderHook(() => usePreviewPlayer());
    act(() => result.current.toggle(makeTrack(1)));
    expect(result.current.status).toBe("loading");
    await act(async () => resolve());
    expect(result.current.status).toBe("playing");
  });

  it("marks a track unavailable when its preview can't load", async () => {
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockRejectedValue(
      new DOMException(
        "Failed to load because no supported source was found.",
        "NotSupportedError",
      ),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => usePreviewPlayer());
    await act(async () => result.current.toggle(makeTrack(1)));
    expect(result.current.current).toBe(null);
    expect(result.current.status).toBe("idle");
    expect(result.current.failed.has("song-1")).toBe(true);
    expect(result.current.issue).toBe("unavailable");
    expect(console.warn).toHaveBeenCalled();
  });

  it("does not retry a track that already failed", async () => {
    const play = vi
      .spyOn(window.HTMLMediaElement.prototype, "play")
      .mockRejectedValue(new DOMException("x", "NotSupportedError"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => usePreviewPlayer());
    await act(async () => result.current.toggle(makeTrack(1)));
    await act(async () => result.current.toggle(makeTrack(1)));
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("keeps the track playable when the browser blocks autoplay", async () => {
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockRejectedValue(
      new DOMException(
        "play() failed because the user didn't interact",
        "NotAllowedError",
      ),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => usePreviewPlayer());
    await act(async () => result.current.toggle(makeTrack(1)));
    expect(result.current.current).toBe(null);
    expect(result.current.failed.size).toBe(0);
    expect(result.current.issue).toBe("autoplay-blocked");
  });

  it("treats a media error during playback as unavailable", async () => {
    const audio = capturePlayer();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => usePreviewPlayer());
    await act(async () => result.current.toggle(makeTrack(1)));
    act(() => audio.element()?.dispatchEvent(new Event("error")));
    expect(result.current.current).toBe(null);
    expect(result.current.failed.has("song-1")).toBe(true);
    expect(result.current.issue).toBe("unavailable");
  });

  it("clears the issue on dismiss and on the next successful play", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const play = vi
      .spyOn(window.HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(new DOMException("x", "NotSupportedError"));
    const { result } = renderHook(() => usePreviewPlayer());
    await act(async () => result.current.toggle(makeTrack(1)));
    act(() => result.current.dismissIssue());
    expect(result.current.issue).toBe(null);
    play.mockRejectedValueOnce(new DOMException("x", "NotSupportedError"));
    await act(async () => result.current.toggle(makeTrack(2)));
    expect(result.current.issue).toBe("unavailable");
    await act(async () => result.current.toggle(makeTrack(3)));
    expect(result.current.status).toBe("playing");
    expect(result.current.issue).toBe(null);
  });

  it("stops playback on unmount", () => {
    const audio = capturePlayer();
    const { result, unmount } = renderHook(() => usePreviewPlayer());
    act(() => result.current.toggle(makeTrack(1)));
    unmount();
    expect(audio.pause).toHaveBeenCalled();
  });
});
