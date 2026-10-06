import { playlists, sessions, users } from "@tunelynk/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { RunsDeps } from "../runs/routes";
import { createTestDatabase } from "../test/db";
import type { AppleDeps } from "./appleRoutes";
import { createLoginTokenRepo } from "./loginTokens";
import type { Mailer } from "./mailer";
import { createSessionRepo, type SessionRepo } from "./sessions";
import { finishSignIn } from "./signIn";

const SECRET = "test-secret-test-secret-test-secret!";
const APP_URL = "https://tunelynk.test";

describe.skipIf(!process.env.DATABASE_URL)("/api/auth/email", () => {
  let handle: Awaited<ReturnType<typeof createTestDatabase>>;
  let sessionRepo: SessionRepo;
  let app: ReturnType<typeof createApp>;
  let sent: { to: string; url: string }[];
  let mailFails: boolean;

  beforeAll(async () => {
    handle = await createTestDatabase();
    sessionRepo = createSessionRepo(handle.db);
    const mailer: Mailer = {
      async sendLoginLink(message) {
        if (mailFails) throw new Error("resend down");
        sent.push(message);
      },
    };
    app = createApp({
      db: handle.db,
      auth: {
        sessions: sessionRepo,
        sessionSecret: SECRET,
        secureCookies: false,
      },
      email: {
        loginTokens: createLoginTokenRepo(handle.db),
        mailer,
        appUrl: APP_URL,
        logger: { error: () => {} },
      },
      apple: {} as AppleDeps,
      runs: {} as RunsDeps,
    });
  });
  afterAll(() => handle.drop());
  beforeEach(async () => {
    await handle.db.execute(sql`truncate users, login_tokens cascade`);
    sent = [];
    mailFails = false;
  });

  const post = (path: string, body: unknown, cookie = "") =>
    app.request(`/api/auth/email/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  const start = (email: string, cookie = "", returnTo?: string) =>
    post("start", { email, returnTo }, cookie);
  const verify = (token: string, cookie = "") =>
    post("verify", { token }, cookie);
  const lastToken = () => {
    const url = sent.at(-1)?.url ?? "";
    expect(url.startsWith(`${APP_URL}/signin/verify#t=`)).toBe(true);
    return url.slice(`${APP_URL}/signin/verify#t=`.length);
  };
  const sessionCookie = (res: Response) =>
    res.headers
      .getSetCookie()
      .filter((c) => c.startsWith("tl_session="))
      .at(-1)
      ?.split(";")[0] ?? "";
  const me = async (cookie: string) =>
    (await (await app.request("/api/me", { headers: { cookie } })).json()) as {
      user: { id: string; isGuest: boolean; label: string | null } | null;
    };
  const signIn = async (email: string, cookie = "") => {
    expect((await start(email, cookie)).status).toBe(202);
    const res = await verify(lastToken(), cookie);
    expect(res.status).toBe(200);
    return { res, cookie: sessionCookie(res) };
  };
  const guestWithPlaylist = async () => {
    const guest = await sessionRepo.createGuestSession();
    const [playlist] = await handle.db
      .insert(playlists)
      .values({ userId: guest.userId, name: "p", prompt: "p", length: 20 })
      .returning({ id: playlists.id });
    return {
      ...guest,
      cookie: `tl_session=${guest.token}`,
      playlistId: playlist?.id ?? "",
    };
  };
  const ownerOf = async (playlistId: string) =>
    (
      await handle.db
        .select({ u: playlists.userId })
        .from(playlists)
        .where(eq(playlists.id, playlistId))
    )[0]?.u;

  it("sends a link and signs in with it", async () => {
    const res = await start("a@b.co");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({});
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("a@b.co");
    expect(lastToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const verified = await verify(lastToken());
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({ returnTo: "/" });
    const cookie = sessionCookie(verified);
    expect((await me(cookie)).user).toMatchObject({
      isGuest: false,
      label: "a@b.co",
    });
  });

  it("normalizes the address so different spellings reach one account", async () => {
    const first = await signIn(" A@B.Co ");
    expect(sent[0]?.to).toBe("a@b.co");
    const second = await signIn("a@b.co");
    expect((await me(second.cookie)).user?.id).toBe(
      (await me(first.cookie)).user?.id,
    );
  });

  it("answers the same for new and existing addresses", async () => {
    await signIn("a@b.co");
    const existing = await start("a@b.co");
    const fresh = await start("new@b.co");
    expect([existing.status, await existing.json()]).toEqual([
      fresh.status,
      await fresh.json(),
    ]);
  });

  it.each([
    ["bad email", { email: "nope" }],
    ["missing email", {}],
  ])(
    "rejects %s with 400 invalid_email and sends nothing",
    async (_l, body) => {
      const res = await post("start", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_email" });
      expect(sent).toEqual([]);
    },
  );

  it("requires a JSON content type", async () => {
    const res = await app.request("/api/auth/email/start", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ email: "a@b.co" }),
    });
    expect(res.status).toBe(415);
  });

  it("returns to a safe returnTo and drops an unsafe one", async () => {
    await start("a@b.co", "", "/playlists/p/runs/r?keep=1");
    expect(await (await verify(lastToken())).json()).toEqual({
      returnTo: "/playlists/p/runs/r?keep=1",
    });
    await start("a@b.co", "", "//evil.com");
    expect(await (await verify(lastToken())).json()).toEqual({ returnTo: "/" });
  });

  it("rate-limits to 3 links per address", async () => {
    for (let i = 0; i < 3; i++)
      expect((await start("a@b.co")).status).toBe(202);
    const limited = await start("a@b.co");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "too_many_requests" });
    expect(sent).toHaveLength(3);
  });

  it("returns 502 and frees the slot when the email fails", async () => {
    mailFails = true;
    const res = await start("a@b.co");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "email_failed" });
    const [row] = await handle.db.execute<{ n: number }>(
      sql`select count(*)::int as n from login_tokens`,
    );
    expect(row?.n).toBe(0);
  });

  it.each([
    ["unknown", "not-a-real-token"],
    ["empty", ""],
  ])("rejects an %s token with 400 invalid_or_expired", async (_l, token) => {
    const res = await verify(token);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_or_expired" });
  });

  it("rejects a reused link", async () => {
    await start("a@b.co");
    const token = lastToken();
    expect((await verify(token)).status).toBe(200);
    expect((await verify(token)).status).toBe(400);
  });

  it("lets exactly one of two simultaneous verifies sign in", async () => {
    await start("a@b.co");
    const token = lastToken();
    const statuses = (await Promise.all([verify(token), verify(token)])).map(
      (r) => r.status,
    );
    expect(statuses.sort()).toEqual([200, 400]);
  });

  it("claims the requesting guest even when the link opens elsewhere", async () => {
    const guest = await guestWithPlaylist();
    await start("a@b.co", guest.cookie);
    // Opened in another cookie jar (e.g. a mail app's in-app browser).
    const res = await verify(lastToken());
    expect(res.status).toBe(200);
    const account = (await me(sessionCookie(res))).user;
    expect(await ownerOf(guest.playlistId)).toBe(account?.id);
    expect(await sessionRepo.resolve(guest.token)).toBeUndefined();
  });

  it("claims the guest when one browser requests and opens the link", async () => {
    const guest = await guestWithPlaylist();
    await start("a@b.co", guest.cookie);
    const res = await verify(lastToken(), guest.cookie);
    const account = (await me(sessionCookie(res))).user;
    expect(await ownerOf(guest.playlistId)).toBe(account?.id);
  });

  it("never claims the opening browser's guest for a link it didn't request", async () => {
    // Someone shares their own sign-in link with a guest who has drafts.
    const victim = await guestWithPlaylist();
    await start("attacker@b.co");
    const res = await verify(lastToken(), victim.cookie);
    expect(res.status).toBe(200);
    expect(await ownerOf(victim.playlistId)).toBe(victim.userId);
  });

  it("still signs in when the requesting guest is gone", async () => {
    const guest = await guestWithPlaylist();
    await start("a@b.co", guest.cookie);
    await handle.db.delete(users).where(eq(users.id, guest.userId));
    expect((await verify(lastToken())).status).toBe(200);
  });

  it("switches accounts when verifying while signed in as someone else", async () => {
    const other = await finishSignIn(handle.db, {
      identity: { method: "email", subject: "other@b.co" },
      guestUserIds: [],
    });
    const [kept] = await handle.db
      .insert(playlists)
      .values({ userId: other.userId, name: "p", prompt: "p", length: 20 })
      .returning({ id: playlists.id });
    await start("a@b.co");
    const res = await verify(lastToken(), `tl_session=${other.token}`);
    expect((await me(sessionCookie(res))).user?.label).toBe("a@b.co");
    expect(await sessionRepo.resolve(other.token)).toBeUndefined();
    expect(await ownerOf(kept?.id ?? "")).toBe(other.userId);
    const [left] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(sessions)
      .where(eq(sessions.userId, other.userId));
    expect(left?.n).toBe(0);
  });
});
