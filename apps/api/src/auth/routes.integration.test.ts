import { sessions, users } from "@tunelynk/db";
import { eq, sql } from "drizzle-orm";
import { generateSignedCookie } from "hono/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { RunsDeps } from "../runs/routes";
import { createTestDatabase } from "../test/db";
import type { EmailDeps } from "./email";
import { createSessionRepo, type SessionRepo } from "./sessions";
import { finishSignIn } from "./signIn";

const SECRET = "test-secret-test-secret-test-secret!";
const DAY_MS = 86_400_000;

const setCookies = (res: Response) => res.headers.getSetCookie();
const cookieValue = (res: Response, name: string) =>
  setCookies(res)
    .filter((c) => c.startsWith(`${name}=`))
    .at(-1)
    ?.split(";")[0]
    ?.slice(name.length + 1);
const legacyCookie = async (value: string, secret = SECRET) =>
  (await generateSignedCookie("tl_guest", value, secret)).split(";")[0] ?? "";

describe.skipIf(!process.env.DATABASE_URL)(
  "session middleware + /api/me + signout",
  () => {
    let handle: Awaited<ReturnType<typeof createTestDatabase>>;
    let repo: SessionRepo;
    let app: ReturnType<typeof createApp>;

    beforeAll(async () => {
      handle = await createTestDatabase();
      repo = createSessionRepo(handle.db);
      app = createApp({
        db: handle.db,
        auth: { sessions: repo, sessionSecret: SECRET, secureCookies: false },
        email: {} as EmailDeps,
        runs: {} as RunsDeps, // never hit here
      });
    });
    afterAll(() => handle.drop());
    beforeEach(async () => {
      await handle.db.execute(sql`truncate users cascade`);
    });

    const me = (cookie = "") =>
      app.request("/api/me", { headers: cookie ? { cookie } : {} });
    const signout = (cookie = "") =>
      app.request("/api/auth/signout", {
        method: "POST",
        headers: cookie ? { cookie } : {},
      });
    const userCount = async () =>
      (await handle.db.select({ n: sql<number>`count(*)::int` }).from(users))[0]
        ?.n ?? 0;

    it("reports no user without cookies and creates nothing", async () => {
      const res = await me();
      expect(await res.json()).toEqual({ user: null });
      expect(setCookies(res)).toEqual([]);
      expect(await userCount()).toBe(0);
    });

    it("reports a guest session", async () => {
      const guest = await repo.createGuestSession();
      const res = await me(`tl_session=${guest.token}`);
      expect(await res.json()).toEqual({
        user: { id: guest.userId, isGuest: true, label: null },
      });
    });

    it("labels email and Apple users", async () => {
      const mail = await finishSignIn(handle.db, {
        identity: { method: "email", subject: "a@b.co" },
        guestUserIds: [],
      });
      const apple = await finishSignIn(handle.db, {
        identity: { method: "apple", subject: "001.abc" },
        guestUserIds: [],
      });
      expect(await (await me(`tl_session=${mail.token}`)).json()).toEqual({
        user: { id: mail.userId, isGuest: false, label: "a@b.co" },
      });
      expect(await (await me(`tl_session=${apple.token}`)).json()).toEqual({
        user: { id: apple.userId, isGuest: false, label: "Apple ID" },
      });
    });

    it("clears an unknown or expired session cookie", async () => {
      const unknown = await me("tl_session=garbage");
      expect(await unknown.json()).toEqual({ user: null });
      expect(setCookies(unknown).join()).toMatch(/tl_session=;.*Max-Age=0/);

      const guest = await repo.createGuestSession();
      await handle.db
        .update(sessions)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(sessions.id, guest.sessionId));
      const expired = await me(`tl_session=${guest.token}`);
      expect(await expired.json()).toEqual({ user: null });
      expect(cookieValue(expired, "tl_session")).toBe("");
    });

    it("slides a signed-in session with under 15 days left", async () => {
      const user = await finishSignIn(handle.db, {
        identity: { method: "email", subject: "a@b.co" },
        guestUserIds: [],
      });
      await handle.db
        .update(sessions)
        .set({ expiresAt: sql`now() + interval '10 days'` })
        .where(eq(sessions.id, user.sessionId));
      const res = await me(`tl_session=${user.token}`);
      expect(cookieValue(res, "tl_session")).toBe(user.token);
      expect(setCookies(res).join()).toMatch(/Max-Age=2592000/);
      const ttl =
        ((await repo.resolve(user.token))?.expiresAt.getTime() ?? 0) -
        Date.now();
      expect(ttl).toBeGreaterThan(29 * DAY_MS);
    });

    it("does not slide a fresh session or any guest session", async () => {
      const user = await finishSignIn(handle.db, {
        identity: { method: "email", subject: "a@b.co" },
        guestUserIds: [],
      });
      expect(setCookies(await me(`tl_session=${user.token}`))).toEqual([]);

      const guest = await repo.createGuestSession();
      await handle.db
        .update(sessions)
        .set({ expiresAt: sql`now() + interval '10 days'` })
        .where(eq(sessions.id, guest.sessionId));
      expect(setCookies(await me(`tl_session=${guest.token}`))).toEqual([]);
    });

    it("upgrades a legacy tl_guest cookie to a session", async () => {
      const [guest] = await handle.db
        .insert(users)
        .values({ isGuest: true })
        .returning({ id: users.id });
      const res = await me(await legacyCookie(guest?.id ?? ""));
      expect(await res.json()).toEqual({
        user: { id: guest?.id, isGuest: true, label: null },
      });
      expect(cookieValue(res, "tl_guest")).toBe("");
      const token = cookieValue(res, "tl_session") ?? "";
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await repo.resolve(token)).toMatchObject({ userId: guest?.id });
    });

    it("prefers the legacy upgrade over clearing a stale session cookie", async () => {
      const [guest] = await handle.db
        .insert(users)
        .values({ isGuest: true })
        .returning({ id: users.id });
      const res = await me(
        `tl_session=garbage; ${await legacyCookie(guest?.id ?? "")}`,
      );
      expect((await res.json()) as unknown).toMatchObject({
        user: { id: guest?.id },
      });
      const token = cookieValue(res, "tl_session") ?? "";
      expect(await repo.resolve(token)).toMatchObject({ userId: guest?.id });
    });

    it.each([
      ["tampered", async () => `${await legacyCookie(crypto.randomUUID())}x`],
      ["wrong secret", () => legacyCookie(crypto.randomUUID(), `${SECRET}?`)],
      ["not a uuid", () => legacyCookie("not-a-uuid")],
      ["missing user", () => legacyCookie(crypto.randomUUID())],
    ])("ignores and deletes a %s legacy cookie", async (_label, make) => {
      const res = await me(await make());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ user: null });
      expect(cookieValue(res, "tl_guest")).toBe("");
      expect(await userCount()).toBe(0);
    });

    it("does not upgrade a legacy cookie that names a non-guest user", async () => {
      const user = await finishSignIn(handle.db, {
        identity: { method: "email", subject: "a@b.co" },
        guestUserIds: [],
      });
      const res = await me(await legacyCookie(user.userId));
      expect(await res.json()).toEqual({ user: null });
    });

    it("signs out: deletes the session and clears the cookie", async () => {
      const guest = await repo.createGuestSession();
      const res = await signout(`tl_session=${guest.token}`);
      expect(res.status).toBe(204);
      expect(cookieValue(res, "tl_session")).toBe("");
      expect(await repo.resolve(guest.token)).toBeUndefined();
      expect(await (await me(`tl_session=${guest.token}`)).json()).toEqual({
        user: null,
      });
    });

    it("signs out with no session", async () => {
      expect((await signout()).status).toBe(204);
    });
  },
);
