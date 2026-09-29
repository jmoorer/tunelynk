import { createDb } from "@tunelynk/db";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "./app";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("GET /api/health against real Postgres", () => {
  const db = createDb(url ?? "");
  afterAll(() => db.$client.end());

  it("reports db up", async () => {
    const res = await createApp({ db }).request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "up" });
  });
});
