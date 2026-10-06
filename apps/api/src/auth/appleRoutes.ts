import { randomBytes } from "node:crypto";
import type { Db } from "@tunelynk/db";
import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { AppleClient } from "./apple";
import { type AuthDeps, type AuthEnv, setSessionCookie } from "./middleware";
import { safeReturnTo } from "./returnTo";
import { finishSignIn } from "./signIn";

export const APPLE_STATE_COOKIE = "tl_apple";
const COOKIE_PATH = "/api/auth/apple";
const STATE_TTL_SECONDS = 600;

export type AppleDeps = {
  // Null when Apple sign-in is not configured (APPLE_SIGNIN_CLIENT_ID unset).
  client: AppleClient | null;
  logger?: Pick<Console, "error">;
};

type SavedState = { state: string; nonce: string; returnTo?: string };

const random = () => randomBytes(16).toString("base64url");
const encode = (saved: SavedState) =>
  Buffer.from(JSON.stringify(saved)).toString("base64url");

function decode(raw: string): SavedState | undefined {
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof value?.state !== "string" || typeof value?.nonce !== "string") {
      return undefined;
    }
    return {
      state: value.state,
      nonce: value.nonce,
      returnTo: safeReturnTo(value.returnTo),
    };
  } catch {
    return undefined;
  }
}

export function appleRoutes(deps: AppleDeps & { db: Db; auth: AuthDeps }) {
  const logger = deps.logger ?? console;
  const cookieOptions = {
    httpOnly: true,
    sameSite: "Lax",
    secure: deps.auth.secureCookies,
    path: COOKIE_PATH,
  } as const;

  const { client } = deps;
  if (!client) {
    // Off: send people back to sign-in, which then offers email only.
    const off = new Hono<AuthEnv>();
    off.get("/*", (c) => {
      const query = new URLSearchParams({ error: "apple" });
      const returnTo = safeReturnTo(c.req.query("returnTo"));
      if (returnTo) query.set("returnTo", returnTo);
      return c.redirect(`/signin?${query}`, 302);
    });
    return off;
  }

  return new Hono<AuthEnv>()
    .get("/start", async (c) => {
      const saved: SavedState = {
        state: random(),
        nonce: random(),
        returnTo: safeReturnTo(c.req.query("returnTo")),
      };
      await setSignedCookie(
        c,
        APPLE_STATE_COOKIE,
        encode(saved),
        deps.auth.sessionSecret,
        { ...cookieOptions, maxAge: STATE_TTL_SECONDS },
      );
      return c.redirect(
        client.authorizeUrl({ state: saved.state, nonce: saved.nonce }),
        302,
      );
    })
    .get("/callback", async (c) => {
      const raw = await getSignedCookie(
        c,
        deps.auth.sessionSecret,
        APPLE_STATE_COOKIE,
      );
      // One attempt per start: a replayed callback finds no cookie.
      deleteCookie(c, APPLE_STATE_COOKIE, cookieOptions);
      const saved = raw ? decode(raw) : undefined;

      const fail = (reason: string, err?: unknown) => {
        logger.error(`apple sign-in failed: ${reason}`, err ?? "");
        const query = new URLSearchParams({ error: "apple" });
        if (saved?.returnTo) query.set("returnTo", saved.returnTo);
        return c.redirect(`/signin?${query}`, 302);
      };

      const { code, state, error } = c.req.query();
      if (error) return fail(`apple returned ${error.slice(0, 64)}`);
      if (!saved) return fail("missing or invalid state cookie");
      if (!state || state !== saved.state) return fail("state mismatch");
      if (!code) return fail("missing code");

      let sub: string;
      try {
        ({ sub } = await client.exchange(code, saved.nonce));
      } catch (err) {
        return fail("code exchange or id_token check", err);
      }

      // The state cookie proves this browser started the flow, so its guest
      // is the one signing in.
      const current = c.get("user");
      const { token } = await finishSignIn(deps.db, {
        identity: { method: "apple", subject: sub },
        guestUserIds: [current?.isGuest ? current.id : null],
        currentSessionId: c.get("sessionId"),
      });
      setSessionCookie(c, token, deps.auth.secureCookies);
      return c.redirect(saved.returnTo ?? "/", 302);
    });
}
