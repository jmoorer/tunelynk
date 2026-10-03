import { authIdentities, sessions, users } from "@tunelynk/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test/db";
import { createSessionRepo, type SessionRepo } from "./sessions";
import { hashToken } from "./tokens";

const DAY_MS = 86_400_000;

describe.skipIf(!process.env.DATABASE_URL)("session repo", () => {
  let handle: Awaited<ReturnType<typeof createTestDatabase>>;
  let repo: SessionRepo;

  beforeAll(async () => {
    handle = await createTestDatabase();
    repo = createSessionRepo(handle.db);
  });
  afterAll(() => handle.drop());
  beforeEach(async () => {
    await handle.db.execute(sql`truncate users cascade`);
  });

  const newUser = async (isGuest: boolean) => {
    const [row] = await handle.db
      .insert(users)
      .values({ isGuest })
      .returning({ id: users.id });
    if (!row) throw new Error("no user");
    return row.id;
  };

  it("creates a guest with a session whose token resolves", async () => {
    const { userId, sessionId, token } = await repo.createGuestSession();
    const [stored] = await handle.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(stored?.tokenHash).toBe(hashToken(token));
    expect(stored?.userId).toBe(userId);
    const resolved = await repo.resolve(token);
    expect(resolved).toMatchObject({ sessionId, userId, isGuest: true });
    const ttl = (resolved?.expiresAt.getTime() ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(29 * DAY_MS);
    expect(ttl).toBeLessThanOrEqual(30 * DAY_MS);
  });

  it("resolves sessions for non-guest users", async () => {
    const userId = await newUser(false);
    const { token } = await repo.createSession(userId);
    expect(await repo.resolve(token)).toMatchObject({ userId, isGuest: false });
  });

  it("does not resolve unknown or expired tokens", async () => {
    expect(await repo.resolve("nope")).toBeUndefined();
    const { sessionId, token } = await repo.createGuestSession();
    await handle.db
      .update(sessions)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(sessions.id, sessionId));
    expect(await repo.resolve(token)).toBeUndefined();
  });

  it("extends a session to 30 days", async () => {
    const { sessionId, token } = await repo.createSession(await newUser(false));
    await handle.db
      .update(sessions)
      .set({ expiresAt: sql`now() + interval '1 day'` })
      .where(eq(sessions.id, sessionId));
    await repo.extend(sessionId);
    const ttl =
      ((await repo.resolve(token))?.expiresAt.getTime() ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(29 * DAY_MS);
  });

  it("deletes a session", async () => {
    const { sessionId, token } = await repo.createGuestSession();
    await repo.deleteSession(sessionId);
    expect(await repo.resolve(token)).toBeUndefined();
  });

  it("drops sessions when their user is deleted", async () => {
    const { userId, token } = await repo.createGuestSession();
    await handle.db.delete(users).where(eq(users.id, userId));
    expect(await repo.resolve(token)).toBeUndefined();
  });

  it("isGuestUser is true only for existing guests", async () => {
    expect(await repo.isGuestUser(await newUser(true))).toBe(true);
    expect(await repo.isGuestUser(await newUser(false))).toBe(false);
    expect(await repo.isGuestUser("00000000-0000-4000-8000-000000000000")).toBe(
      false,
    );
  });

  it("touches last_seen_at at most once a minute", async () => {
    const userId = await newUser(true);
    await handle.db
      .update(users)
      .set({ lastSeenAt: sql`now() - interval '2 minutes'` })
      .where(eq(users.id, userId));
    const read = async () =>
      (
        await handle.db
          .select({ t: users.lastSeenAt })
          .from(users)
          .where(eq(users.id, userId))
      )[0]?.t.getTime() ?? 0;
    const stale = await read();
    await repo.touchUser(userId);
    const fresh = await read();
    expect(fresh).toBeGreaterThan(stale);
    await repo.touchUser(userId);
    expect(await read()).toBe(fresh);
  });

  it("labels users by their identity", async () => {
    const guest = await newUser(true);
    const emailUser = await newUser(false);
    const appleUser = await newUser(false);
    await handle.db.insert(authIdentities).values([
      { userId: emailUser, method: "email", subject: "a@b.co" },
      { userId: appleUser, method: "apple", subject: "001234.abc" },
    ]);
    expect(await repo.label(guest)).toBeNull();
    expect(await repo.label(emailUser)).toBe("a@b.co");
    expect(await repo.label(appleUser)).toBe("Apple ID");
  });
});
