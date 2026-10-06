import type { AuthProviders, MeResponse } from "@tunelynk/shared";
import { Hono } from "hono";
import { type AuthDeps, type AuthEnv, clearSessionCookie } from "./middleware";

export function meRoutes(deps: AuthDeps) {
  return new Hono<AuthEnv>().get("/", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ user: null } satisfies MeResponse);
    const label = user.isGuest ? null : await deps.sessions.label(user.id);
    return c.json({ user: { ...user, label } } satisfies MeResponse);
  });
}

export function authRoutes(deps: AuthDeps, providers: AuthProviders) {
  return new Hono<AuthEnv>()
    .get("/providers", (c) => c.json(providers satisfies AuthProviders))
    .post("/signout", async (c) => {
      const sessionId = c.get("sessionId");
      if (sessionId) await deps.sessions.deleteSession(sessionId);
      clearSessionCookie(c, deps.secureCookies);
      return c.body(null, 204);
    });
}
