import { llmUsage, playlists, users } from "@tunelynk/db";
import { type GenerateResult, RefusalError } from "@tunelynk/engine";
import type { RunResponse } from "@tunelynk/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createTestDatabase } from "../test/db";
import { createRunExecutor, type Engine, type RunJob } from "./executor";
import { RUN_ERRORS } from "./messages";
import { createRunRepo } from "./repo";

const SECRET = "test-secret-test-secret-test-secret!";
const usage = {
  model: "claude-haiku-4-5",
  inputTokens: 100,
  outputTokens: 200,
};
const okResult: GenerateResult = {
  name: "Sunday Drive",
  tracks: [
    {
      appleSongId: "1",
      isrc: "ISRC1",
      title: "Dreams",
      artistName: "Fleetwood Mac",
      artistIds: [],
      album: "Rumours",
      durationMs: 257_000,
      explicit: false,
      artworkUrl: "https://img/1.jpg",
      previewUrl: "https://audio/1.m4a",
      source: "llm",
    },
  ],
  candidates: [
    {
      title: "Dreams",
      artist: "Fleetwood Mac",
      status: "matched",
      appleSongId: "1",
    },
    { title: "Nope", artist: "Nobody", status: "unmatched" },
  ],
  usage,
};

const cookieFrom = (res: Response) =>
  res.headers.get("set-cookie")?.split(";")[0] ?? "";

describe.skipIf(!process.env.DATABASE_URL)("/api/runs", () => {
  let handle: Awaited<ReturnType<typeof createTestDatabase>>;
  let engine: Engine;
  let pending: Promise<void>[];
  let secureCookies: boolean;
  let reservePerRunMicros: number;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });
  afterAll(() => handle.drop());

  beforeEach(async () => {
    await handle.db.execute(sql`truncate users, llm_usage, tracks cascade`);
    engine = async () => okResult;
    pending = [];
    secureCookies = false;
    reservePerRunMicros = 0;
    const repo = createRunRepo(handle.db);
    const real = createRunExecutor({
      repo,
      engine: (input, onStage) => engine(input, onStage),
      logger: { error: () => {} },
    });
    const build = () =>
      createApp({
        db: handle.db,
        runs: {
          repo,
          executor: {
            start: (job: RunJob) => {
              const p = real.start(job);
              pending.push(p);
              return p;
            },
          },
          sessionSecret: SECRET,
          get secureCookies() {
            return secureCookies;
          },
          dailyBudgetMicros: 2_000_000,
          get reservePerRunMicros() {
            return reservePerRunMicros;
          },
          model: "claude-haiku-4-5",
        },
      });
    app = build();
  });

  const post = (body: unknown, cookie = "") =>
    app.request("/api/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const get = (id: string, cookie = "") =>
    app.request(`/api/runs/${id}`, { headers: cookie ? { cookie } : {} });
  const count = async (table: typeof users | typeof playlists) =>
    (await handle.db.select({ n: sql<number>`count(*)::int` }).from(table))[0]
      ?.n ?? 0;

  it("creates a run, sets the guest cookie, and serves the finished playlist", async () => {
    const res = await post({ prompt: "  sunday drive  " });
    expect(res.status).toBe(202);
    const { runId, playlistId } = (await res.json()) as {
      runId: string;
      playlistId: string;
    };

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^tl_guest=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Max-Age=2592000/);
    expect(setCookie).not.toMatch(/Secure/);

    await Promise.all(pending);
    const run = (await (await get(runId)).json()) as RunResponse;
    expect(run).toEqual({
      id: runId,
      status: "draft",
      stage: null,
      error: null,
      playlist: {
        id: playlistId,
        name: "Sunday Drive",
        prompt: "sunday drive",
      },
      tracks: [
        {
          position: 1,
          appleSongId: "1",
          title: "Dreams",
          artistName: "Fleetwood Mac",
          album: "Rumours",
          artworkUrl: "https://img/1.jpg",
          previewUrl: "https://audio/1.m4a",
          durationMs: 257_000,
          explicit: false,
          source: "llm",
        },
      ],
      unmatched: [{ title: "Nope", artist: "Nobody" }],
    });
    const [spent] = await handle.db
      .select({ c: llmUsage.costMicros, k: llmUsage.kind })
      .from(llmUsage);
    expect(spent).toEqual({ c: 1100, k: "guest" });
  });

  it("sets Secure on the cookie when configured", async () => {
    secureCookies = true;
    const res = await post({ prompt: "p" });
    expect(res.headers.get("set-cookie")).toMatch(/Secure/);
    await Promise.all(pending);
  });

  it("reports a refusal as a failed run with the user-safe message", async () => {
    engine = async () => {
      throw new RefusalError("not music", usage);
    };
    const { runId } = (await (
      await post({ prompt: "write python" })
    ).json()) as { runId: string };
    await Promise.all(pending);
    expect(await (await get(runId)).json()).toMatchObject({
      status: "failed",
      error: RUN_ERRORS.refusal,
      tracks: [],
    });
    expect(await count(users)).toBe(1);
  });

  it.each([
    ["empty prompt", { prompt: "" }],
    ["281 characters", { prompt: "x".repeat(281) }],
    ["missing prompt", {}],
    ["non-JSON body", "not json"],
  ])("rejects %s with 400 and writes nothing", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_prompt" });
    expect(await count(users)).toBe(0);
    expect(await count(playlists)).toBe(0);
  });

  it("returns 409 with the active run while one is in progress", async () => {
    let release: (r: GenerateResult) => void = () => {};
    let started: () => void = () => {};
    const engineStarted = new Promise<void>((r) => (started = r));
    engine = () =>
      new Promise((resolve) => {
        release = resolve;
        started();
      });
    const first = await post({ prompt: "one" });
    const cookie = cookieFrom(first);
    const ids = (await first.json()) as Record<string, string>;

    const second = await post({ prompt: "two" }, cookie);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "run_in_progress", ...ids });

    await engineStarted;
    release(okResult);
    await Promise.all(pending);
    engine = async () => okResult;
    expect((await post({ prompt: "three" }, cookie)).status).toBe(202);
    await Promise.all(pending);
  });

  it("allows exactly one of two simultaneous POSTs with the same cookie", async () => {
    engine = () => new Promise(() => {});
    const seed = await post({ prompt: "seed" });
    const cookie = cookieFrom(seed);
    await handle.db.execute(sql`update generation_runs set status = 'failed'`);
    const statuses = (
      await Promise.all([
        post({ prompt: "a" }, cookie),
        post({ prompt: "b" }, cookie),
      ])
    ).map((r) => r.status);
    expect(statuses.sort()).toEqual([202, 409]);
  });

  it("returns 503 when today's budget is spent, before writing a playlist", async () => {
    await handle.db.insert(llmUsage).values({
      userId: null,
      model: "claude-haiku-4-5",
      inputTokens: 1,
      outputTokens: 1,
      costMicros: 2_000_000,
      kind: "guest",
    });
    const res = await post({ prompt: "p" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "budget_exceeded" });
    expect(await count(playlists)).toBe(0);
  });

  it("reserves budget for runs still in flight", async () => {
    reservePerRunMicros = 2_000_000;
    engine = () => new Promise(() => {});
    expect((await post({ prompt: "first guest" })).status).toBe(202);
    const second = await post({ prompt: "second guest, no cookie" });
    expect(second.status).toBe(503);
    expect(await second.json()).toEqual({ error: "budget_exceeded" });
  });

  it("reuses the guest across runs with the same cookie", async () => {
    const first = await post({ prompt: "one" });
    const cookie = cookieFrom(first);
    await Promise.all(pending);
    const second = await post({ prompt: "two" }, cookie);
    expect(second.status).toBe(202);
    expect(second.headers.get("set-cookie")).toBe(null);
    await Promise.all(pending);
    expect(await count(users)).toBe(1);
  });

  it("creates a new guest for a tampered cookie", async () => {
    const first = await post({ prompt: "one" });
    await Promise.all(pending);
    const tampered = `${cookieFrom(first).slice(0, -3)}abc`;
    const second = await post({ prompt: "two" }, tampered);
    expect(second.headers.get("set-cookie")).toMatch(/^tl_guest=/);
    await Promise.all(pending);
    expect(await count(users)).toBe(2);
  });

  it("creates a new guest when the cookie's user no longer exists", async () => {
    const first = await post({ prompt: "one" });
    const cookie = cookieFrom(first);
    const ids = (await first.json()) as { runId: string };
    await Promise.all(pending);
    expect((await get(ids.runId, cookie)).status).toBe(200);
    await handle.db.delete(users);

    const second = await post({ prompt: "two" }, cookie);
    expect(second.status).toBe(202);
    expect(second.headers.get("set-cookie")).toMatch(/^tl_guest=/);
    await Promise.all(pending);
    expect(await count(users)).toBe(1);
  });

  it("GET never creates users and 404s unknown or malformed ids", async () => {
    expect((await get("00000000-0000-4000-8000-000000000000")).status).toBe(
      404,
    );
    const malformed = await get("not-a-uuid");
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual({ error: "not_found" });
    expect(await count(users)).toBe(0);
  });
});
