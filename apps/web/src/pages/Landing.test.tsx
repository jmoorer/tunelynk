import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { stubFetch } from "../test/fetch";
import { IDS } from "../test/fixtures";
import { Landing } from "./Landing";

function Where() {
  return <p>at {useLocation().pathname}</p>;
}

const renderLanding = () =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/playlists/:playlistId/runs/:runId" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

const type = (value: string) =>
  fireEvent.change(screen.getByLabelText("Describe a playlist"), {
    target: { value },
  });

describe("Landing", () => {
  it("shows the hero and example chips", () => {
    stubFetch(() => Response.json({}));
    renderLanding();
    expect(screen.getByText("Get a playlist.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "upbeat 90s road trip" }),
    ).toBeInTheDocument();
  });

  it("creates a run and navigates to it", async () => {
    const fetch = stubFetch(() =>
      Response.json(
        { runId: IDS.run, playlistId: IDS.playlist },
        { status: 202 },
      ),
    );
    renderLanding();
    type("sunday drive");
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(
      await screen.findByText(`at /playlists/${IDS.playlist}/runs/${IDS.run}`),
    ).toBeInTheDocument();
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      prompt: "sunday drive",
    });
  });

  it("submits an example chip", async () => {
    const fetch = stubFetch(() =>
      Response.json(
        { runId: IDS.run, playlistId: IDS.playlist },
        { status: 202 },
      ),
    );
    renderLanding();
    fireEvent.click(
      screen.getByRole("button", { name: "rainy sunday morning jazz" }),
    );
    await screen.findByText(/^at \/playlists/);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      prompt: "rainy sunday morning jazz",
    });
  });

  it("sends one request when submitted twice quickly", async () => {
    let release: (r: Response) => void = () => {};
    const fetch = stubFetch(() => new Promise<Response>((r) => (release = r)));
    renderLanding();
    type("p");
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    fireEvent.click(
      screen.getByRole("button", { name: "upbeat 90s road trip" }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    release(
      Response.json(
        { runId: IDS.run, playlistId: IDS.playlist },
        { status: 202 },
      ),
    );
    await screen.findByText(/^at \/playlists/);
  });

  it.each([
    [
      503,
      { error: "budget_exceeded" },
      "Daily generation limit reached. Try again tomorrow.",
    ],
    [400, { error: "invalid_prompt" }, "Prompts need 1–280 characters."],
  ])("shows the %i message", async (status, body, message) => {
    stubFetch(() => Response.json(body, { status }));
    renderLanding();
    type("p");
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("links to the run already in progress on 409", async () => {
    stubFetch(() =>
      Response.json(
        { error: "run_in_progress", runId: IDS.run, playlistId: IDS.playlist },
        { status: 409 },
      ),
    );
    renderLanding();
    type("p");
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You already have a playlist generating.",
    );
    expect(screen.getByRole("link", { name: "Open it" })).toHaveAttribute(
      "href",
      `/playlists/${IDS.playlist}/runs/${IDS.run}`,
    );
  });

  it("explains network failures", async () => {
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    renderLanding();
    type("p");
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't reach Tunelynk.",
    );
  });
});
