import { playlists } from "@tunelynk/db";
import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { createApp } from "../app";
import type { RunsDeps } from "../runs/routes";
import { createTestDatabase } from "../test/db";
import type { AppleClient } from "./apple";
import { AppleSignInError } from "./apple";
import type { EmailDeps } from "./email";
import { createSessionRepo, type SessionRepo } from "./sessions";

const SECRET = "test-secret-test-secret-test-secret!";

describe.skipIf(!process.env.DATABASE_URL)("/api/auth/apple", () => {
  let handle: Awaited<ReturnType<typeof createTestDatabase>>;
  let sessionRepo: SessionRepo;
  let app: ReturnType<typeof createApp>;
  let exchange: Mock<AppleClient["exchange"]>;
  let errors: unknown[][];

  beforeAll(async () => {
    handle = await createTestDatabase();
    sessionRepo = createSessionRepo(handle.db);
    const client: AppleClient = {
      authorizeUrl: ({ state, nonce }) =>
        `https://appleid.apple.com/auth/authorize?state=${state}&nonce=${nonce}`,
      exchange: (code, nonce) => exchange(code, nonce),
    };
    app = createApp({
      db: handle.db,
      auth: {
        sessions: sessionRepo,
        sessionSecret: SECRET,
        secureCookies: false,
      },
      email: {} as EmailDeps,
      apple: { client, logger: { error: (...args) => errors.push(args) } },
      runs: {} as RunsDeps,
    });
  });
  afterAll(() => handle.drop());
  beforeEach(async () => {
    await handle.db.execute(sql`truncate users cascade`);
    exchange = vi.fn<AppleClient["exchange"]>(async () => ({
      sub: "001234.abc",
    }));
    errors = [];
  });

  const cookieNamed = (res: Response, name: string) =>
    res.headers
      .getSetCookie()
      .filter((c) => c.startsWith(`${name}=`))
      .at(-1);
  const pair = (res: Response, name: string) =>
    cookieNamed(res, name)?.split(";")[0] ?? "";

  // Runs /start, returns the state cookie and the state Apple would echo back.
  const begin = async (returnTo?: string, cookie = "") => {
    const query = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : "";
    const res = await app.request(`/api/auth/apple/start${query}`, {
      headers: cookie ? { cookie } : {},
    });
    const location = new URL(res.headers.get("location") ?? "");
    return {
      res,
      stateCookie: pair(res, "tl_apple"),
      state: location.searchParams.get("state") ?? "",
      nonce: location.searchParams.get("nonce") ?? "",
    };
  };
  const callback = (query: string, cookie: string) =>
    app.request(`/api/auth/apple/callback?${query}`, { headers: { cookie } });
  const me = async (cookie: string) =>
    (await (await app.request("/api/me", { headers: { cookie } })).json()) as {
      user: { id: string; label: string | null } | null;
    };

  it("start redirects to Apple and sets a scoped, short-lived state cookie", async () => {
    const { res, state, nonce } = await begin("/x");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(
      /^https:\/\/appleid\.apple\.com\/auth\/authorize\?/,
    );
    expect(state).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(nonce).not.toBe(state);
    const cookie = cookieNamed(res, "tl_apple") ?? "";
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/api\/auth\/apple/);
    expect(cookie).toMatch(/Max-Age=600/);
  });

  it("signs in on a valid callback and returns to returnTo", async () => {
    const { stateCookie, state, nonce } = await begin(
      "/playlists/p/runs/r?keep=1",
    );
    const res = await callback(`code=c-1&state=${state}`, stateCookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/playlists/p/runs/r?keep=1");
    expect(exchange).toHaveBeenCalledWith("c-1", nonce);
    expect(pair(res, "tl_apple")).toBe("tl_apple=");
    expect((await me(pair(res, "tl_session"))).user?.label).toBe("Apple ID");
  });

  it("defaults to / and reuses the account for the same Apple sub", async () => {
    const first = await begin();
    const a = await callback(
      `code=c-1&state=${first.state}`,
      first.stateCookie,
    );
    expect(a.headers.get("location")).toBe("/");
    const second = await begin();
    const b = await callback(
      `code=c-2&state=${second.state}`,
      second.stateCookie,
    );
    expect((await me(pair(b, "tl_session"))).user?.id).toBe(
      (await me(pair(a, "tl_session"))).user?.id,
    );
  });

  it("claims this browser's guest drafts", async () => {
    const guest = await sessionRepo.createGuestSession();
    const [playlist] = await handle.db
      .insert(playlists)
      .values({ userId: guest.userId, name: "p", prompt: "p", length: 20 })
      .returning({ id: playlists.id });
    const guestCookie = `tl_session=${guest.token}`;
    const { stateCookie, state } = await begin(undefined, guestCookie);
    const res = await callback(
      `code=c-1&state=${state}`,
      `${guestCookie}; ${stateCookie}`,
    );
    const account = (await me(pair(res, "tl_session"))).user;
    const [owner] = await handle.db
      .select({ u: playlists.userId })
      .from(playlists)
      .where(eq(playlists.id, playlist?.id ?? ""));
    expect(owner?.u).toBe(account?.id);
    expect(await sessionRepo.resolve(guest.token)).toBeUndefined();
  });

  const expectFailure = (res: Response, returnTo?: string) => {
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/signin?")).toBe(true);
    const params = new URL(location, "http://x").searchParams;
    expect(params.get("error")).toBe("apple");
    expect(params.get("returnTo")).toBe(returnTo ?? null);
    expect(cookieNamed(res, "tl_session")).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  };

  it("fails cleanly when the person cancels on Apple, keeping returnTo", async () => {
    const { stateCookie, state } = await begin("/x");
    const res = await callback(
      `error=user_cancelled_authorize&state=${state}`,
      stateCookie,
    );
    expectFailure(res, "/x");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("fails on a state mismatch", async () => {
    const { stateCookie } = await begin();
    expectFailure(await callback("code=c-1&state=forged", stateCookie));
    expect(exchange).not.toHaveBeenCalled();
  });

  it("fails without the state cookie (replayed callback or other browser)", async () => {
    const { state } = await begin();
    expectFailure(await callback(`code=c-1&state=${state}`, ""));
  });

  it("fails on a tampered state cookie", async () => {
    const { stateCookie, state } = await begin();
    expectFailure(await callback(`code=c-1&state=${state}`, `${stateCookie}x`));
  });

  it("fails without a code", async () => {
    const { stateCookie, state } = await begin();
    expectFailure(await callback(`state=${state}`, stateCookie));
  });

  it("fails when the exchange or id_token check fails", async () => {
    exchange = vi.fn<AppleClient["exchange"]>(async () => {
      throw new AppleSignInError("id_token nonce mismatch");
    });
    const { stateCookie, state } = await begin("/x");
    expectFailure(await callback(`code=c-1&state=${state}`, stateCookie), "/x");
  });

  it("never redirects to an unsafe returnTo", async () => {
    const ok = await begin("//evil.com");
    const success = await callback(
      `code=c-1&state=${ok.state}`,
      ok.stateCookie,
    );
    expect(success.headers.get("location")).toBe("/");
    const bad = await begin("//evil.com");
    const failure = await callback("code=c-1&state=forged", bad.stateCookie);
    expect(failure.headers.get("location")).toBe("/signin?error=apple");
  });

  it("never logs the code", async () => {
    exchange = vi.fn<AppleClient["exchange"]>(async () => {
      throw new AppleSignInError("token endpoint responded 400");
    });
    const { stateCookie, state } = await begin();
    await callback(`code=secret-code-123&state=${state}`, stateCookie);
    expect(JSON.stringify(errors.map((e) => e.map(String)))).not.toContain(
      "secret-code-123",
    );
  });

  it("reports Apple as available", async () => {
    const res = await app.request("/api/auth/providers");
    expect(await res.json()).toEqual({ email: true, apple: true });
  });

  describe("with Apple sign-in not configured", () => {
    let off: ReturnType<typeof createApp>;
    beforeAll(() => {
      off = createApp({
        db: handle.db,
        auth: {
          sessions: sessionRepo,
          sessionSecret: SECRET,
          secureCookies: false,
        },
        email: {} as EmailDeps,
        apple: {
          client: null,
          logger: { error: (...args) => errors.push(args) },
        },
        runs: {} as RunsDeps,
      });
    });

    it("reports Apple as unavailable", async () => {
      const res = await off.request("/api/auth/providers");
      expect(await res.json()).toEqual({ email: true, apple: false });
    });

    it("start bounces back to sign-in without contacting Apple", async () => {
      const res = await off.request("/api/auth/apple/start?returnTo=%2Fx");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "/signin?error=apple&returnTo=%2Fx",
      );
      expect(res.headers.getSetCookie()).toEqual([]);
    });

    it("callback bounces back to sign-in", async () => {
      const res = await off.request("/api/auth/apple/callback?code=c&state=s");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/signin?error=apple");
      expect(exchange).not.toHaveBeenCalled();
    });
  });
});
