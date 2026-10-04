import type { Db } from "@tunelynk/db";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import type { EmailDeps } from "./auth/email";
import type { AuthDeps } from "./auth/middleware";
import type { RunsDeps } from "./runs/routes";

const runs = {} as RunsDeps; // health/static tests never hit /api/runs
// No cookies are sent in these tests, so the middleware never touches the repo.
const auth = {} as AuthDeps;
const email = {} as EmailDeps; // never hit here

// ping(db) calls db.execute; a fake with only execute is enough.
function fakeDb(execute: () => Promise<unknown>): Db {
  return { execute } as unknown as Db;
}

describe("GET /api/health", () => {
  it("reports db up when ping succeeds", async () => {
    const app = createApp({ runs, auth, email, db: fakeDb(async () => []) });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "up" });
  });

  it("reports db down, still 200, when ping fails", async () => {
    const app = createApp({
      runs,
      auth,
      email,
      db: fakeDb(async () => Promise.reject(new Error("ECONNREFUSED"))),
    });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "down" });
  });
});

describe("onError", () => {
  it("returns 500 JSON for unhandled route errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp({ runs, auth, email, db: fakeDb(async () => []) });
    app.get("/api/boom", () => {
      throw new Error("boom");
    });
    const res = await app.request("/api/boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal Server Error" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
