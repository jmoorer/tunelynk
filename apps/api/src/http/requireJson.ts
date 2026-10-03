import type { ApiError } from "@tunelynk/shared";
import { createMiddleware } from "hono/factory";

// CSRF backstop for cookie-authenticated mutations: an HTML form or a
// no-preflight fetch can't send application/json cross-origin.
export const requireJson = createMiddleware(async (c, next) => {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    return c.json({ error: "json_required" } satisfies ApiError, 415);
  }
  return next();
});
