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

  it("resets when playback is rejected", async () => {
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockRejectedValue(
      new Error("NotAllowedError"),
    );
    const { result } = renderHook(() => usePreviewPlayer());
    await act(async () => result.current.toggle(makeTrack(1)));
    expect(result.current.current).toBe(null);
  });

  it("stops playback on unmount", () => {
    const audio = capturePlayer();
    const { result, unmount } = renderHook(() => usePreviewPlayer());
    act(() => result.current.toggle(makeTrack(1)));
    unmount();
    expect(audio.pause).toHaveBeenCalled();
  });
});
