import {
  authIdentities,
  llmUsage,
  playlists,
  type sessions,
  users,
} from "@tunelynk/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test/db";
import { createSessionRepo, type SessionRepo } from "./sessions";
import { finishSignIn } from "./signIn";

const email = { method: "email", subject: "a@b.co" } as const;

describe.skipIf(!process.env.DATABASE_URL)("finishSignIn", () => {
  let handle: Awaited<ReturnType<typeof createTestDatabase>>;
  let repo: SessionRepo;

  beforeAll(async () => {
    handle = await createTestDatabase();
    repo = createSessionRepo(handle.db);
  });
  afterAll(() => handle.drop());
  beforeEach(async () => {
    await handle.db.execute(sql`truncate users, llm_usage cascade`);
  });

  const count = async (
    table: typeof users | typeof authIdentities | typeof sessions,
  ) =>
    (await handle.db.select({ n: sql<number>`count(*)::int` }).from(table))[0]
      ?.n ?? 0;

  // A guest with one playlist, one usage row and a session.
  const newGuest = async () => {
    const guest = await repo.createGuestSession();
    const [playlist] = await handle.db
      .insert(playlists)
      .values({ userId: guest.userId, name: "p", prompt: "p", length: 20 })
      .returning({ id: playlists.id });
    await handle.db.insert(llmUsage).values({
      userId: guest.userId,
      model: "claude-haiku-4-5",
      inputTokens: 1,
      outputTokens: 1,
      costMicros: 1,
      kind: "guest",
    });
    return { ...guest, playlistId: playlist?.id ?? "" };
  };

  const ownerOf = async (playlistId: string) =>
    (
      await handle.db
        .select({ u: playlists.userId })
        .from(playlists)
        .where(eq(playlists.id, playlistId))
    )[0]?.u;

  it("creates a user and identity on first sign-in, with a live session", async () => {
    const { userId, token } = await finishSignIn(handle.db, {
      identity: email,
      guestUserIds: [],
    });
    expect(await repo.resolve(token)).toMatchObject({ userId, isGuest: false });
    expect(await repo.label(userId)).toBe("a@b.co");
  });

  it("returns the same user for the same identity", async () => {
    const first = await finishSignIn(handle.db, {
      identity: email,
      guestUserIds: [],
    });
    const second = await finishSignIn(handle.db, {
      identity: email,
      guestUserIds: [],
    });
    expect(second.userId).toBe(first.userId);
    expect(await count(authIdentities)).toBe(1);
  });

  it("keeps methods apart even with the same subject", async () => {
    const a = await finishSignIn(handle.db, {
      identity: email,
      guestUserIds: [],
    });
    const b = await finishSignIn(handle.db, {
      identity: { method: "apple", subject: "a@b.co" },
      guestUserIds: [],
    });
    expect(b.userId).not.toBe(a.userId);
  });

  it("claims a guest: moves playlists and usage, deletes the guest and its sessions", async () => {
    const guest = await newGuest();
    const { userId } = await finishSignIn(handle.db, {
      identity: email,
      guestUserIds: [guest.userId],
      currentSessionId: guest.sessionId,
    });
    expect(await ownerOf(guest.playlistId)).toBe(userId);
    const usage = await handle.db.select({ u: llmUsage.userId }).from(llmUsage);
    expect(usage).toEqual([{ u: userId }]);
    expect(await repo.resolve(guest.token)).toBeUndefined();
    expect(await repo.isGuestUser(guest.userId)).toBe(false);
    expect(await count(users)).toBe(1);
  });

  it("claims two guests and ignores null, undefined and duplicate ids", async () => {
    const a = await newGuest();
    const b = await newGuest();
    const { userId } = await finishSignIn(handle.db, {
      identity: email,
      guestUserIds: [a.userId, null, b.userId, undefined, a.userId],
    });
    expect(await ownerOf(a.playlistId)).toBe(userId);
    expect(await ownerOf(b.playlistId)).toBe(userId);
    expect(await count(users)).toBe(1);
  });

  it("never claims a non-guest user", async () => {
    const other = await finishSignIn(handle.db, {
      identity: { method: "email", subject: "other@b.co" },
      guestUserIds: [],
    });
    const [playlist] = await handle.db
      .insert(playlists)
      .values({ userId: other.userId, name: "p", prompt: "p", length: 20 })
      .returning({ id: playlists.id });
    await finishSignIn(handle.db, {
      identity: email,
      guestUserIds: [other.userId],
    });
    expect(await ownerOf(playlist?.id ?? "")).toBe(other.userId);
    expect(await repo.resolve(other.token)).toBeDefined();
  });

  it("rotates the current session", async () => {
    const first = await finishSignIn(handle.db, {
      identity: email,
      guestUserIds: [],
    });
    const second = await finishSignIn(handle.db, {
      identity: { method: "apple", subject: "001.abc" },
      guestUserIds: [],
      currentSessionId: first.sessionId,
    });
    expect(await repo.resolve(first.token)).toBeUndefined();
    expect(await repo.resolve(second.token)).toMatchObject({
      userId: second.userId,
    });
  });

  it("resolves two simultaneous first sign-ins to one user", async () => {
    const results = await Promise.all([
      finishSignIn(handle.db, { identity: email, guestUserIds: [] }),
      finishSignIn(handle.db, { identity: email, guestUserIds: [] }),
    ]);
    expect(results[0].userId).toBe(results[1].userId);
    expect(await count(authIdentities)).toBe(1);
    expect(await count(users)).toBe(1);
  });
});
