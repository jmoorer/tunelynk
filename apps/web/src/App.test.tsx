import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { stubFetch } from "./test/fetch";
import { IDS, makeRun } from "./test/fixtures";

// Renders the real router, so a page that is never mounted can't hide behind
// page tests that bring their own MemoryRouter.
describe("App", () => {
  it("serves the landing page at /", () => {
    window.history.pushState({}, "", "/");
    render(<App />);
    expect(screen.getByText("Get a playlist.")).toBeInTheDocument();
  });

  it("serves the run view at a run URL", async () => {
    stubFetch(() => Response.json(makeRun()));
    window.history.pushState(
      {},
      "",
      `/playlists/${IDS.playlist}/runs/${IDS.run}`,
    );
    render(<App />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Sunday Drive" }),
    ).toBeInTheDocument();
  });

  it("shows not found for unknown paths", async () => {
    window.history.pushState({}, "", "/nope");
    await act(async () => {
      render(<App />);
    });
    expect(screen.getByText("Page not found.")).toBeInTheDocument();
  });
});
