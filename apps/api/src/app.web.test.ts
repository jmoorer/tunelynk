import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@tunelynk/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { AuthDeps } from "./auth/middleware";
import type { RunsDeps } from "./runs/routes";

const runs = {} as RunsDeps; // health/static tests never hit /api/runs
// No cookies are sent in these tests, so the middleware never touches the repo.
const auth = {} as AuthDeps;

const fakeDb = { execute: async () => [] } as unknown as Db;
const INDEX = "<!doctype html><title>tunelynk</title>";

let root: string;
let webDir: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tunelynk-web-"));
  webDir = join(root, "dist");
  mkdirSync(join(webDir, "assets"), { recursive: true });
  writeFileSync(join(webDir, "index.html"), INDEX);
  writeFileSync(join(webDir, "assets", "app.js"), "console.log(1)");
  // Outside webDir: must never be reachable.
  writeFileSync(join(root, "secret.txt"), "TOP SECRET");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("createApp with webDir", () => {
  const app = () => createApp({ runs, auth, db: fakeDb, webDir });

  it("serves index.html at /", async () => {
    const res = await app().request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX);
  });

  it("falls back to index.html for client-side routes", async () => {
    const res = await app().request("/playlists/123");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toBe(INDEX);
  });

  it("serves built assets with their content type", async () => {
    const res = await app().request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(await res.text()).toBe("console.log(1)");
  });

  it("tells browsers to revalidate index.html so a redeploy is picked up", async () => {
    for (const path of ["/", "/index.html", "/playlists/123"]) {
      const res = await app().request(path);
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });

  it("lets browsers cache hashed assets forever", async () => {
    const res = await app().request("/assets/app.js");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("still serves the API", async () => {
    const res = await app().request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "up" });
  });

  it("returns JSON 404 for unknown API routes, not the SPA", async () => {
    const res = await app().request("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not Found" });
  });

  it("returns 404 for a missing asset (stale hash after redeploy), not the SPA", async () => {
    const res = await app().request("/assets/index-OLD.js");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not Found" });
  });

  it("does not fall back to the SPA for non-GET requests", async () => {
    const res = await app().request("/playlists", { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not Found" });
  });

  it("never serves files outside webDir", async () => {
    for (const path of [
      "/%2e%2e/secret.txt",
      "/..%2fsecret.txt",
      "/assets/%2e%2e/%2e%2e/secret.txt",
    ]) {
      const res = await app().request(path);
      expect(await res.text()).not.toContain("TOP SECRET");
    }
  });
});

describe("createApp without webDir", () => {
  it("returns JSON 404 for /", async () => {
    const res = await createApp({ runs, auth, db: fakeDb }).request("/");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not Found" });
  });
});
