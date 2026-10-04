import { loginTokens, users } from "@tunelynk/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test/db";
import { createLoginTokenRepo, type LoginTokenRepo } from "./loginTokens";
import { hashToken } from "./tokens";

describe.skipIf(!process.env.DATABASE_URL)("login token repo", () => {
  let handle: Awaited<ReturnType<typeof createTestDatabase>>;
  let repo: LoginTokenRepo;

  beforeAll(async () => {
    handle = await createTestDatabase();
    repo = createLoginTokenRepo(handle.db);
  });
  afterAll(() => handle.drop());
  beforeEach(async () => {
    await handle.db.execute(sql`truncate login_tokens, users cascade`);
  });

  const issue = (email = "a@b.co") => repo.issue({ email });

  it("stores only the hash, with a 15-minute expiry", async () => {
    const issued = await repo.issue({ email: "a@b.co", returnTo: "/x" });
    expect(issued?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = await handle.db.select().from(loginTokens);
    expect(row?.tokenHash).toBe(hashToken(issued?.token ?? ""));
    expect(row?.returnTo).toBe("/x");
    const ttl = (row?.expiresAt.getTime() ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
  });

  it("consumes a token exactly once and returns its data", async () => {
    const [guest] = await handle.db
      .insert(users)
      .values({ isGuest: true })
      .returning({ id: users.id });
    const issued = await repo.issue({
      email: "a@b.co",
      returnTo: "/x",
      guestUserId: guest?.id,
    });
    expect(await repo.consume(issued?.token ?? "")).toEqual({
      email: "a@b.co",
      returnTo: "/x",
      guestUserId: guest?.id,
    });
    expect(await repo.consume(issued?.token ?? "")).toBeUndefined();
  });

  it("lets only one of two concurrent consumes win", async () => {
    const issued = await issue();
    const results = await Promise.all([
      repo.consume(issued?.token ?? ""),
      repo.consume(issued?.token ?? ""),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("does not consume expired or unknown tokens", async () => {
    const issued = await issue();
    await handle.db
      .update(loginTokens)
      .set({ expiresAt: sql`now() - interval '1 second'` });
    expect(await repo.consume(issued?.token ?? "")).toBeUndefined();
    expect(await repo.consume("unknown")).toBeUndefined();
  });

  it("allows 3 links per email per 15 minutes", async () => {
    expect(await issue()).toBeDefined();
    expect(await issue()).toBeDefined();
    expect(await issue()).toBeDefined();
    expect(await issue()).toBeUndefined();
    expect(await issue("other@b.co")).toBeDefined();
  });

  it("does not count links older than the window", async () => {
    await issue();
    await issue();
    await issue();
    await handle.db
      .update(loginTokens)
      .set({ createdAt: sql`now() - interval '16 minutes'` });
    expect(await issue()).toBeDefined();
  });

  it("holds the limit under concurrent requests", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => issue()));
    expect(results.filter(Boolean)).toHaveLength(3);
  });

  it("removes a token, freeing its slot", async () => {
    const first = await issue();
    await issue();
    await issue();
    await repo.remove(first?.id ?? "");
    expect(await issue()).toBeDefined();
  });

  it("nulls guest_user_id when the guest is deleted", async () => {
    const [guest] = await handle.db
      .insert(users)
      .values({ isGuest: true })
      .returning({ id: users.id });
    const issued = await repo.issue({
      email: "a@b.co",
      guestUserId: guest?.id,
    });
    await handle.db.delete(users).where(eq(users.id, guest?.id ?? ""));
    expect((await repo.consume(issued?.token ?? ""))?.guestUserId).toBeNull();
  });
});
