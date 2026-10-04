import type { Db } from "@tunelynk/db";
import {
  type ApiError,
  EmailStartRequest,
  EmailVerifyRequest,
  type EmailVerifyResponse,
} from "@tunelynk/shared";
import { Hono } from "hono";
import { requireJson } from "../http/requireJson";
import type { LoginTokenRepo } from "./loginTokens";
import type { Mailer } from "./mailer";
import { type AuthDeps, type AuthEnv, setSessionCookie } from "./middleware";
import { safeReturnTo } from "./returnTo";
import { finishSignIn } from "./signIn";

export type EmailDeps = {
  loginTokens: LoginTokenRepo;
  mailer: Mailer;
  appUrl: string;
  logger?: Pick<Console, "error">;
};

// The token rides in the fragment: it never reaches server logs or a
// Referer, and mail scanners that prefetch links can't consume it.
export const loginLink = (appUrl: string, token: string) =>
  `${appUrl}/signin/verify#t=${token}`;

export function emailRoutes(deps: EmailDeps & { db: Db; auth: AuthDeps }) {
  const logger = deps.logger ?? console;

  return new Hono<AuthEnv>()
    .post("/start", requireJson, async (c) => {
      const body = EmailStartRequest.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!body.success) {
        return c.json({ error: "invalid_email" } satisfies ApiError, 400);
      }
      const { email } = body.data;
      const user = c.get("user");
      const issued = await deps.loginTokens.issue({
        email,
        returnTo: safeReturnTo(body.data.returnTo),
        guestUserId: user?.isGuest ? user.id : null,
      });
      if (!issued) {
        return c.json({ error: "too_many_requests" } satisfies ApiError, 429);
      }
      try {
        await deps.mailer.sendLoginLink({
          to: email,
          url: loginLink(deps.appUrl, issued.token),
        });
      } catch (err) {
        logger.error("sign-in email failed", err);
        await deps.loginTokens.remove(issued.id);
        return c.json({ error: "email_failed" } satisfies ApiError, 502);
      }
      // Same answer whether or not an account exists.
      return c.json({}, 202);
    })
    .post("/verify", requireJson, async (c) => {
      const body = EmailVerifyRequest.safeParse(
        await c.req.json().catch(() => null),
      );
      const consumed = body.success
        ? await deps.loginTokens.consume(body.data.token)
        : undefined;
      if (!consumed) {
        return c.json({ error: "invalid_or_expired" } satisfies ApiError, 400);
      }
      const current = c.get("user");
      const { token } = await finishSignIn(deps.db, {
        identity: { method: "email", subject: consumed.email },
        // The requesting browser's guest and this browser's guest.
        guestUserIds: [
          consumed.guestUserId,
          current?.isGuest ? current.id : null,
        ],
        currentSessionId: c.get("sessionId"),
      });
      setSessionCookie(c, token, deps.auth.secureCookies);
      return c.json(
        { returnTo: consumed.returnTo ?? "/" } satisfies EmailVerifyResponse,
        200,
      );
    });
}
