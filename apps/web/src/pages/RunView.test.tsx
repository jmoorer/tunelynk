import { act, fireEvent, render, screen } from "@testing-library/react";
import type { RunResponse } from "@tunelynk/shared";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_MS } from "../hooks/useRun";
import { stubFetch } from "../test/fetch";
import { IDS, makeRun, makeTrack } from "../test/fixtures";
import { Landing } from "./Landing";
import { RunView } from "./RunView";

const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const tick = () => act(() => vi.advanceTimersByTimeAsync(POLL_MS));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route
          path="/playlists/:playlistId/runs/:runId"
          element={<RunView />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

const runUrl = (runId = IDS.run, playlistId = IDS.playlist) =>
  `/playlists/${playlistId}/runs/${runId}`;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("RunView", () => {
  it("shows skeletons and the stage while running, then the grid", async () => {
    const runs: RunResponse[] = [
      makeRun({ status: "running", stage: "llm", tracks: [] }),
      makeRun({ unmatched: [{ title: "Gone", artist: "Nobody" }] }),
    ];
    stubFetch(() => Response.json(runs.shift() ?? makeRun()));
    renderAt(runUrl());
    await flush();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Asking the AI…",
    );
    expect(screen.getAllByTestId("skeleton-tile")).toHaveLength(20);
    expect(screen.getByLabelText("Describe a playlist")).toHaveValue(
      "sunday drive",
    );

    await tick();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Sunday Drive",
    );
    expect(screen.queryAllByTestId("skeleton-tile")).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "Play Song 1 by Artist 1" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Gone \(Nobody\)/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign in to keep" }),
    ).toBeDisabled();
  });

  it("plays a clip and shows the now-playing bar", async () => {
    stubFetch(() => Response.json(makeRun()));
    renderAt(runUrl());
    await flush();
    fireEvent.click(
      screen.getByRole("button", { name: "Play Song 2 by Artist 2" }),
    );
    expect(
      screen.getByRole("region", { name: "Now playing" }),
    ).toHaveTextContent("Song 2");
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.queryByRole("region", { name: "Now playing" })).toBe(null);
  });

  it("explains a preview that can't play and marks its tile", async () => {
    stubFetch(() => Response.json(makeRun()));
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockRejectedValue(
      new DOMException("no supported source", "NotSupportedError"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    renderAt(runUrl());
    await flush();
    fireEvent.click(
      screen.getByRole("button", { name: "Play Song 1 by Artist 1" }),
    );
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Couldn't play that preview.",
    );
    expect(
      screen.getByRole("button", {
        name: "Song 1 by Artist 1, preview unavailable",
      }),
    ).toBeDisabled();
    expect(screen.queryByRole("region", { name: "Now playing" })).toBe(null);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBe(null);
  });

  it("stops the clip when leaving the run page", async () => {
    stubFetch(() => Response.json(makeRun()));
    const pause = vi.spyOn(window.HTMLMediaElement.prototype, "pause");
    renderAt(runUrl());
    await flush();
    fireEvent.click(
      screen.getByRole("button", { name: "Play Song 1 by Artist 1" }),
    );
    pause.mockClear();
    fireEvent.click(screen.getByRole("link", { name: "tunelynk" }));
    await flush();
    expect(screen.getByText("Get a playlist.")).toBeInTheDocument();
    expect(pause).toHaveBeenCalled();
  });

  it("shows the failure and retries the same prompt", async () => {
    const fetch = stubFetch((url, init) => {
      if (init?.method === "POST") {
        return Response.json(
          { runId: IDS.otherRun, playlistId: IDS.otherPlaylist },
          { status: 202 },
        );
      }
      return Response.json(
        url.endsWith(IDS.otherRun)
          ? makeRun({
              id: IDS.otherRun,
              status: "running",
              stage: "llm",
              tracks: [],
            })
          : makeRun({
              status: "failed",
              error: "That doesn't look like a playlist request.",
              tracks: [],
            }),
      );
    });
    renderAt(runUrl());
    await flush();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "That doesn't look like a playlist request.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    await flush();
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      prompt: "sunday drive",
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Asking the AI…",
    );
  });

  it("shows a quiet reconnecting note while the API is unreachable", async () => {
    let calls = 0;
    stubFetch(() => {
      calls++;
      if (calls === 2) throw new TypeError("Failed to fetch");
      return Response.json(
        makeRun({ status: "running", stage: "matching", tracks: [] }),
      );
    });
    renderAt(runUrl());
    await flush();
    await tick();
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
    await tick();
    expect(screen.queryByText("Reconnecting…")).toBe(null);
  });

  it("handles a run that does not exist", async () => {
    stubFetch(() => Response.json({ error: "not_found" }, { status: 404 }));
    renderAt(runUrl());
    await flush();
    expect(
      screen.getByText("This playlist doesn't exist."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Start a new one" }),
    ).toHaveAttribute("href", "/");
  });

  it("disables tiles without a preview", async () => {
    stubFetch(() =>
      Response.json(makeRun({ tracks: [makeTrack(1, { previewUrl: null })] })),
    );
    renderAt(runUrl());
    await flush();
    expect(
      screen.getByRole("button", { name: "Play Song 1 by Artist 1" }),
    ).toBeDisabled();
  });
});
