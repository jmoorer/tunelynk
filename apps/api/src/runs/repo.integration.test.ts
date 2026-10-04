import { generationRuns, llmUsage, playlists, users } from "@tunelynk/db";
import type { GeneratedTrack } from "@tunelynk/engine";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test/db";
import { RUN_ERRORS } from "./messages";
import { createRunRepo, type RunRepo, UserGoneError } from "./repo";

const track = (
  id: string,
  title: string,
  extra: Partial<GeneratedTrack> = {},
): GeneratedTrack => ({
  appleSongId: id,
  isrc: `ISRC${id}`,
  title,
  artistName: "Fleetwood Mac",
  artistIds: [],
  album: "Rumours",
  durationMs: 200_000,
  explicit: false,
  artworkUrl: `https://img/${id}.jpg`,
  previewUrl: `https://audio/${id}.m4a`,
  source: "llm",
  ...extra,
});

const usage = {
  model: "claude-haiku-4-5",
  inputTokens: 100,
  outputTokens: 200,
};

describe.skipIf(!process.env.DATABASE_URL)("run repository", () => {
  let handle: Awaited<ReturnType<typeof createTestDatabase>>;
  let repo: RunRepo;

  beforeAll(async () => {
    handle = await createTestDatabase();
    repo = createRunRepo(handle.db);
  });
  afterAll(() => handle.drop());

  const newGuest = async () => {
    const [row] = await handle.db
      .insert(users)
      .values({ isGuest: true })
      .returning({ id: users.id });
    if (!row) throw new Error("no guest");
    return row.id;
  };

  const newRun = async () => {
    const userId = await newGuest();
    const run = await repo.createRun({
      userId,
      prompt: "road trip",
      length: 20,
      model: "claude-haiku-4-5",
    });
    return { userId, ...run };
  };

  it("creates a guest, a draft playlist, and a queued run", async () => {
    const { userId, created, runId, playlistId } = await newRun();
    expect(created).toBe(true);
    const [owner] = await handle.db
      .select({ userId: playlists.userId })
      .from(playlists)
      .where(eq(playlists.id, playlistId));
    expect(owner?.userId).toBe(userId);
    expect(await repo.getRun(runId)).toEqual({
      id: runId,
      status: "queued",
      stage: null,
      error: null,
      playlist: { id: playlistId, name: "road trip", prompt: "road trip" },
      tracks: [],
      unmatched: [],
    });
  });

  it("returns the existing run instead of creating a second active one", async () => {
    const first = await newRun();
    const second = await repo.createRun({
      userId: first.userId,
      prompt: "again",
      length: 20,
      model: "claude-haiku-4-5",
    });
    expect(second).toEqual({
      created: false,
      runId: first.runId,
      playlistId: first.playlistId,
    });
  });

  it("serializes concurrent creation for one user", async () => {
    const userId = await newGuest();
    const args = { userId, prompt: "p", length: 20, model: "claude-haiku-4-5" };
    const results = await Promise.all([
      repo.createRun(args),
      repo.createRun(args),
    ]);
    expect(results.map((r) => r.created).sort()).toEqual([false, true]);
  });

  it("runs the lifecycle: running → stage → draft with tracks", async () => {
    const { runId, playlistId } = await newRun();
    expect(await repo.markRunning(runId)).toBe(true);
    expect(await repo.markRunning(runId)).toBe(false);
    await repo.setStage(runId, "matching");
    expect((await repo.getRun(runId))?.stage).toBe("matching");

    const done = await repo.completeRun(runId, {
      name: "Sunday Drive",
      tracks: [
        track("1", "Dreams"),
        track("2", "Landslide", {
          source: "backfill",
          previewUrl: undefined,
          artworkUrl: undefined,
        }),
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
    });

    expect(done).toBe(true);
    const run = await repo.getRun(runId);
    expect(run).toMatchObject({
      status: "draft",
      stage: null,
      playlist: { id: playlistId, name: "Sunday Drive" },
      unmatched: [{ title: "Nope", artist: "Nobody" }],
    });
    expect(run?.tracks).toEqual([
      {
        position: 1,
        appleSongId: "1",
        title: "Dreams",
        artistName: "Fleetwood Mac",
        album: "Rumours",
        artworkUrl: "https://img/1.jpg",
        previewUrl: "https://audio/1.m4a",
        durationMs: 200_000,
        explicit: false,
        source: "llm",
      },
      {
        position: 2,
        appleSongId: "2",
        title: "Landslide",
        artistName: "Fleetwood Mac",
        album: "Rumours",
        artworkUrl: null,
        previewUrl: null,
        durationMs: 200_000,
        explicit: false,
        source: "backfill",
      },
    ]);
  });

  it("upserts tracks shared across runs", async () => {
    const a = await newRun();
    await repo.markRunning(a.runId);
    await repo.completeRun(a.runId, {
      name: "A",
      tracks: [track("77", "Old Title")],
      candidates: [],
    });
    const b = await newRun();
    await repo.markRunning(b.runId);
    await repo.completeRun(b.runId, {
      name: "B",
      tracks: [track("77", "New Title")],
      candidates: [],
    });
    expect((await repo.getRun(a.runId))?.tracks[0]?.title).toBe("New Title");
  });

  it("does not complete or fail a run that already finished", async () => {
    const { runId } = await newRun();
    await repo.markRunning(runId);
    expect(await repo.failRun(runId, RUN_ERRORS.timeout)).toBe(true);
    expect(
      await repo.completeRun(runId, {
        name: "late",
        tracks: [track("9", "Late")],
        candidates: [],
      }),
    ).toBe(false);
    expect(await repo.failRun(runId, RUN_ERRORS.generic)).toBe(false);
    expect(await repo.getRun(runId)).toMatchObject({
      status: "failed",
      error: RUN_ERRORS.timeout,
      tracks: [],
    });
  });

  it("stores candidates on failure", async () => {
    const { runId } = await newRun();
    await repo.markRunning(runId);
    await repo.failRun(runId, RUN_ERRORS.notEnough, [
      { title: "X", artist: "Y", status: "unmatched" },
    ]);
    expect((await repo.getRun(runId))?.unmatched).toEqual([
      { title: "X", artist: "Y" },
    ]);
  });

  it("sums only today's usage", async () => {
    const before = await repo.todaysCostMicros();
    const { userId, runId } = await newRun();
    await repo.recordUsage({ runId, usage, costMicros: 1100, kind: "guest" });
    await handle.db.insert(llmUsage).values({
      userId,
      model: "claude-haiku-4-5",
      inputTokens: 1,
      outputTokens: 1,
      costMicros: 999_999,
      kind: "guest",
      createdAt: new Date(Date.now() - 2 * 86_400_000),
    });
    expect(await repo.todaysCostMicros()).toBe(before + 1100);
  });

  it("records usage against the playlist's current owner", async () => {
    const { runId, playlistId } = await newRun();
    const owner = await newGuest();
    await handle.db
      .update(playlists)
      .set({ userId: owner })
      .where(eq(playlists.id, playlistId));
    await repo.recordUsage({ runId, usage, costMicros: 5, kind: "guest" });
    const [row] = await handle.db
      .select({ u: llmUsage.userId })
      .from(llmUsage)
      .where(eq(llmUsage.costMicros, 5));
    expect(row?.u).toBe(owner);
  });

  it("reserves cost for every active run", async () => {
    await newRun();
    const [row] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(generationRuns)
      .where(sql`${generationRuns.status} in ('queued', 'running')`);
    const active = row?.n ?? 0;
    expect(active).toBeGreaterThan(0);
    const spent = await repo.todaysCostMicros();
    expect(await repo.committedCostMicros(0)).toBe(spent);
    expect(await repo.committedCostMicros(500)).toBe(spent + 500 * active);
  });

  it("re-attributes usage when its owner is claimed during the insert", async () => {
    const { userId: guest, runId, playlistId } = await newRun();
    const account = await newGuest();
    let commit: () => void = () => {};
    const gate = new Promise<void>((r) => (commit = r));
    let ready: () => void = () => {};
    const locked = new Promise<void>((r) => (ready = r));
    // An uncommitted claim: playlist moved, guest deleted.
    const claim = handle.db.transaction(async (tx) => {
      await tx
        .update(playlists)
        .set({ userId: account })
        .where(eq(playlists.id, playlistId));
      await tx.delete(users).where(eq(users.id, guest));
      ready();
      await gate;
    });
    await locked;
    const write = repo.recordUsage({
      runId,
      usage,
      costMicros: 7,
      kind: "guest",
    });
    // The insert reads the old owner and blocks on its FK check.
    await new Promise((r) => setTimeout(r, 150));
    commit();
    await claim;
    await write;
    const [row] = await handle.db
      .select({ u: llmUsage.userId })
      .from(llmUsage)
      .where(eq(llmUsage.costMicros, 7));
    expect(row?.u).toBe(account);
  });

  it("refuses to create a run for a user that no longer exists", async () => {
    const userId = await newGuest();
    await handle.db.delete(users).where(eq(users.id, userId));
    await expect(
      repo.createRun({ userId, prompt: "p", length: 20, model: "m" }),
    ).rejects.toBeInstanceOf(UserGoneError);
  });

  it("fails only stale active runs at boot", async () => {
    const old = await newRun();
    const recent = await newRun();
    await handle.db
      .update(generationRuns)
      .set({ createdAt: sql`now() - interval '10 minutes'` })
      .where(eq(generationRuns.id, old.runId));
    expect(await repo.failStaleRuns(5 * 60_000)).toBeGreaterThanOrEqual(1);
    expect(await repo.getRun(old.runId)).toMatchObject({
      status: "failed",
      error: RUN_ERRORS.interrupted,
    });
    expect((await repo.getRun(recent.runId))?.status).toBe("queued");
  });

  it("returns undefined for an unknown run", async () => {
    expect(await repo.getRun("00000000-0000-4000-8000-000000000000")).toBe(
      undefined,
    );
  });
});
