import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HealthStatus } from "./HealthStatus";

function stubFetch(result: Response | Error) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("HealthStatus", () => {
  it("shows loading first", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    render(<HealthStatus />);
    expect(screen.getByText("Checking API…")).toBeInTheDocument();
  });

  it("shows API and DB up", async () => {
    stubFetch(Response.json({ ok: true, db: "up" }));
    render(<HealthStatus />);
    expect(await screen.findByText("API: up / DB: up")).toBeInTheDocument();
  });

  it("shows DB down", async () => {
    stubFetch(Response.json({ ok: true, db: "down" }));
    render(<HealthStatus />);
    expect(await screen.findByText("API: up / DB: down")).toBeInTheDocument();
  });

  it("shows unreachable when fetch rejects", async () => {
    stubFetch(new TypeError("Failed to fetch"));
    render(<HealthStatus />);
    expect(await screen.findByText("API unreachable")).toBeInTheDocument();
  });

  it("shows unreachable on a non-OK non-JSON response (proxy error)", async () => {
    stubFetch(new Response("<html>Bad Gateway</html>", { status: 500 }));
    render(<HealthStatus />);
    expect(await screen.findByText("API unreachable")).toBeInTheDocument();
  });

  it("shows unreachable when the payload has the wrong shape", async () => {
    stubFetch(Response.json({ status: "fine" }));
    render(<HealthStatus />);
    expect(await screen.findByText("API unreachable")).toBeInTheDocument();
  });
});
