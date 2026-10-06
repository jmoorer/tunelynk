import { createDb } from "@tunelynk/db";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { AppleDeps } from "./auth/appleRoutes";
import type { EmailDeps } from "./auth/email";
import type { AuthDeps } from "./auth/middleware";
import type { RunsDeps } from "./runs/routes";

const runs = {} as RunsDeps; // health/static tests never hit /api/runs
// No cookies are sent in these tests, so the middleware never touches the repo.
const auth = {} as AuthDeps;
const email = {} as EmailDeps; // never hit here
const apple: AppleDeps = { client: null }; // never hit here

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("GET /api/health against real Postgres", () => {
  const db = createDb(url ?? "");
  afterAll(() => db.$client.end());

  it("reports db up", async () => {
    const res = await createApp({ runs, auth, email, apple, db }).request(
      "/api/health",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "up" });
  });
});
