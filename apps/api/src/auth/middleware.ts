import type { Context } from "hono";
import {
  deleteCookie,
  getCookie,
  getSignedCookie,
  setCookie,
} from "hono/cookie";
import { createMiddleware } from "hono/factory";
import {
  SESSION_RENEW_BELOW_MS,
  SESSION_TTL_MS,
  type SessionRepo,
} from "./sessions";

export const SESSION_COOKIE = "tl_session";
// #10's stateless guest cookie. Upgraded to a session on sight; remove this
// path 30 days after #11 ships (its max age).
export const LEGACY_GUEST_COOKIE = "tl_guest";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CurrentUser = { id: string; isGuest: boolean };
export type AuthEnv = {
  Variables: { user: CurrentUser | null; sessionId: string | null };
};
export type AuthDeps = {
  sessions: SessionRepo;
  sessionSecret: string;
  secureCookies: boolean;
};

const baseCookie = (secure: boolean) =>
  ({ httpOnly: true, sameSite: "Lax", secure, path: "/" }) as const;

export function setSessionCookie(c: Context, token: string, secure: boolean) {
  setCookie(c, SESSION_COOKIE, token, {
    ...baseCookie(secure),
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(c: Context, secure: boolean) {
  deleteCookie(c, SESSION_COOKIE, baseCookie(secure));
}

function signIn(c: Context<AuthEnv>, user: CurrentUser, sessionId: string) {
  c.set("user", user);
  c.set("sessionId", sessionId);
}

// Returns true when a valid legacy guest cookie became a session.
async function upgradeLegacyGuest(
  c: Context<AuthEnv>,
  deps: AuthDeps,
): Promise<boolean> {
  if (getCookie(c, LEGACY_GUEST_COOKIE) === undefined) return false;
  const userId = await getSignedCookie(
    c,
    deps.sessionSecret,
    LEGACY_GUEST_COOKIE,
  );
  deleteCookie(c, LEGACY_GUEST_COOKIE, { path: "/" });
  if (!userId || !UUID.test(userId)) return false;
  if (!(await deps.sessions.isGuestUser(userId))) return false;
  const { sessionId, token } = await deps.sessions.createSession(userId);
  setSessionCookie(c, token, deps.secureCookies);
  signIn(c, { id: userId, isGuest: true }, sessionId);
  await deps.sessions.touchUser(userId);
  return true;
}

// Resolves c.var.user from tl_session (or a legacy tl_guest). Never creates a
// user; POST /api/runs does that through ensureUser.
export function sessionMiddleware(deps: AuthDeps) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    c.set("user", null);
    c.set("sessionId", null);

    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      const session = await deps.sessions.resolve(token);
      if (session) {
        signIn(
          c,
          { id: session.userId, isGuest: session.isGuest },
          session.sessionId,
        );
        await deps.sessions.touchUser(session.userId);
        const remaining = session.expiresAt.getTime() - Date.now();
        if (!session.isGuest && remaining < SESSION_RENEW_BELOW_MS) {
          await deps.sessions.extend(session.sessionId);
          setSessionCookie(c, token, deps.secureCookies);
        }
        return next();
      }
    }

    const upgraded = await upgradeLegacyGuest(c, deps);
    if (token && !upgraded) clearSessionCookie(c, deps.secureCookies);
    return next();
  });
}

// The current user, or a new guest with a session (POST /api/runs only).
export async function ensureUser(
  c: Context<AuthEnv>,
  deps: AuthDeps,
): Promise<CurrentUser> {
  const current = c.get("user");
  if (current) return current;
  const { userId, sessionId, token } = await deps.sessions.createGuestSession();
  setSessionCookie(c, token, deps.secureCookies);
  const user = { id: userId, isGuest: true };
  signIn(c, user, sessionId);
  return user;
}
