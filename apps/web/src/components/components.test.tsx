import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { PreviewPlayer } from "../hooks/usePreviewPlayer";
import { makeTrack } from "../test/fixtures";
import { ErrorBanner } from "./ErrorBanner";
import { NowPlayingBar } from "./NowPlayingBar";
import { PlaybackNotice } from "./PlaybackNotice";
import { TopBar } from "./TopBar";
import { TrackGrid } from "./TrackGrid";

const player = (overrides: Partial<PreviewPlayer> = {}): PreviewPlayer => ({
  current: null,
  status: "idle",
  progress: 0,
  failed: new Set(),
  issue: null,
  toggle: vi.fn(),
  stop: vi.fn(),
  dismissIssue: vi.fn(),
  ...overrides,
});

const inRouter = (ui: React.ReactNode) =>
  render(<MemoryRouter>{ui}</MemoryRouter>);

describe("TopBar", () => {
  it("submits the trimmed prompt and disables when blank", () => {
    const onSubmit = vi.fn();
    inRouter(<TopBar onSubmit={onSubmit} />);
    const button = screen.getByRole("button", { name: "Generate" });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Describe a playlist"), {
      target: { value: "  road trip  " },
    });
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledWith("road trip");
  });

  it("shows the busy label and blocks submits while busy", () => {
    const onSubmit = vi.fn();
    inRouter(
      <TopBar initialPrompt="road trip" busyLabel="7s" onSubmit={onSubmit} />,
    );
    const button = screen.getByRole("button", { name: "7s" });
    expect(button).toBeDisabled();
    fireEvent.submit(button.closest("form") as HTMLFormElement);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("caps input at 280 characters", () => {
    inRouter(<TopBar onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("Describe a playlist")).toHaveAttribute(
      "maxLength",
      "280",
    );
  });
});

describe("ErrorBanner", () => {
  it("shows the message and an optional link", () => {
    inRouter(<ErrorBanner message="Busy." href="/playlists/p/runs/r" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Busy.");
    expect(screen.getByRole("link", { name: "Open it" })).toHaveAttribute(
      "href",
      "/playlists/p/runs/r",
    );
  });
});

describe("TrackGrid", () => {
  it("shows 20 skeletons while loading", () => {
    render(<TrackGrid tracks={null} player={player()} />);
    expect(screen.getAllByTestId("skeleton-tile")).toHaveLength(20);
  });

  it("toggles a track on click and marks the playing one", () => {
    const tracks = [makeTrack(1), makeTrack(2)];
    const p = player({ current: tracks[1] ?? null, progress: 0.5 });
    render(<TrackGrid tracks={tracks} player={p} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Play Song 1 by Artist 1" }),
    );
    expect(p.toggle).toHaveBeenCalledWith(tracks[0]);
    expect(
      screen.getByRole("button", { name: "Pause Song 2 by Artist 2" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("disables tracks without a preview", () => {
    render(
      <TrackGrid
        tracks={[makeTrack(1, { previewUrl: null })]}
        player={player()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Play Song 1 by Artist 1" }),
    ).toBeDisabled();
  });
});

describe("TrackGrid playback states", () => {
  it("shows a spinner on the loading tile", () => {
    const tracks = [makeTrack(1)];
    render(
      <TrackGrid
        tracks={tracks}
        player={player({ current: tracks[0] ?? null, status: "loading" })}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Pause Song 1 by Artist 1" }),
    ).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("tile-spinner")).toBeInTheDocument();
  });

  it("marks failed tracks as unavailable and disables them", () => {
    render(
      <TrackGrid
        tracks={[makeTrack(1)]}
        player={player({ failed: new Set(["song-1"]) })}
      />,
    );
    const tile = screen.getByRole("button", {
      name: "Song 1 by Artist 1, preview unavailable",
    });
    expect(tile).toBeDisabled();
    expect(tile).toHaveTextContent("Preview unavailable");
  });
});

describe("PlaybackNotice", () => {
  it.each([
    [
      "unavailable",
      "Couldn't play that preview. A browser extension or privacy setting may be blocking audio from Apple.",
    ],
    [
      "autoplay-blocked",
      "Your browser blocked playback. Tap the track again to play.",
    ],
  ] as const)("explains %s and can be dismissed", (issue, message) => {
    const p = player({ issue });
    render(<PlaybackNotice player={p} />);
    expect(screen.getByRole("status")).toHaveTextContent(message);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(p.dismissIssue).toHaveBeenCalled();
  });

  it("renders nothing without an issue", () => {
    const { container } = render(<PlaybackNotice player={player()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("NowPlayingBar", () => {
  it("renders nothing when idle", () => {
    const { container } = render(
      <NowPlayingBar player={player()} tracks={[makeTrack(1)]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("says Loading until the clip starts", () => {
    const tracks = [makeTrack(1)];
    render(
      <NowPlayingBar
        player={player({ current: tracks[0] ?? null, status: "loading" })}
        tracks={tracks}
      />,
    );
    expect(
      screen.getByRole("region", { name: "Now playing" }),
    ).toHaveTextContent("Loading…");
  });

  it("skips failed tracks", () => {
    const tracks = [makeTrack(1), makeTrack(2), makeTrack(3)];
    const p = player({
      current: tracks[0] ?? null,
      status: "playing",
      failed: new Set(["song-2"]),
    });
    render(<NowPlayingBar player={p} tracks={tracks} />);
    fireEvent.click(screen.getByRole("button", { name: "Next track" }));
    expect(p.toggle).toHaveBeenCalledWith(tracks[2]);
  });

  it("pauses and skips to the next playable track", () => {
    const tracks = [
      makeTrack(1),
      makeTrack(2, { previewUrl: null }),
      makeTrack(3),
    ];
    const p = player({ current: tracks[0] ?? null });
    render(<NowPlayingBar player={p} tracks={tracks} />);
    expect(
      screen.getByRole("region", { name: "Now playing" }),
    ).toHaveTextContent("Song 1");
    fireEvent.click(screen.getByRole("button", { name: "Next track" }));
    expect(p.toggle).toHaveBeenCalledWith(tracks[2]);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(p.stop).toHaveBeenCalled();
  });
});
