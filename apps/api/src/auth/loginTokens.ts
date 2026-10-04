import { type Db, loginTokens } from "@tunelynk/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { hashToken, newToken } from "./tokens";

export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
export const LOGIN_LINK_LIMIT = 3;
export const LOGIN_LINK_WINDOW_MS = 15 * 60 * 1000;

export type ConsumedToken = {
  email: string;
  returnTo: string | null;
  guestUserId: string | null;
};

export function createLoginTokenRepo(db: Db) {
  return {
    // Undefined when the email already has LOGIN_LINK_LIMIT links in the
    // window. The per-email lock makes count-then-insert race-free.
    async issue(args: {
      email: string;
      returnTo?: string;
      guestUserId?: string | null;
    }): Promise<{ id: string; token: string } | undefined> {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`login:${args.email}`}))`,
        );
        const [recent] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(loginTokens)
          .where(
            and(
              eq(loginTokens.email, args.email),
              gt(
                loginTokens.createdAt,
                sql`now() - make_interval(secs => ${LOGIN_LINK_WINDOW_MS / 1000})`,
              ),
            ),
          );
        if ((recent?.n ?? 0) >= LOGIN_LINK_LIMIT) return undefined;

        const token = newToken();
        const [row] = await tx
          .insert(loginTokens)
          .values({
            tokenHash: hashToken(token),
            email: args.email,
            returnTo: args.returnTo ?? null,
            guestUserId: args.guestUserId ?? null,
            expiresAt: sql`now() + make_interval(secs => ${LOGIN_TOKEN_TTL_MS / 1000})`,
          })
          .returning({ id: loginTokens.id });
        if (!row) throw new Error("login token insert returned no row");
        return { id: row.id, token };
      });
    },

    async remove(id: string): Promise<void> {
      await db.delete(loginTokens).where(eq(loginTokens.id, id));
    },

    // Single use: concurrent consumes of one token race on the WHERE, and
    // only one UPDATE returns the row.
    async consume(token: string): Promise<ConsumedToken | undefined> {
      const [row] = await db
        .update(loginTokens)
        .set({ usedAt: sql`now()` })
        .where(
          and(
            eq(loginTokens.tokenHash, hashToken(token)),
            isNull(loginTokens.usedAt),
            gt(loginTokens.expiresAt, sql`now()`),
          ),
        )
        .returning({
          email: loginTokens.email,
          returnTo: loginTokens.returnTo,
          guestUserId: loginTokens.guestUserId,
        });
      return row;
    },
  };
}

export type LoginTokenRepo = ReturnType<typeof createLoginTokenRepo>;
