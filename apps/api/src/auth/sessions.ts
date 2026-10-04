import { authIdentities, type Db, sessions, users } from "@tunelynk/db";
import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import { hashToken, newToken } from "./tokens";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Signed-in sessions slide: renewed once fewer than 15 days remain.
export const SESSION_RENEW_BELOW_MS = 15 * 24 * 60 * 60 * 1000;

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export type ResolvedSession = {
  sessionId: string;
  userId: string;
  isGuest: boolean;
  expiresAt: Date;
};

const newExpiry = () =>
  sql`now() + make_interval(secs => ${SESSION_TTL_MS / 1000})`;

export async function insertSession(
  db: DbOrTx,
  userId: string,
): Promise<{ sessionId: string; token: string }> {
  const token = newToken();
  const [row] = await db
    .insert(sessions)
    .values({ userId, tokenHash: hashToken(token), expiresAt: newExpiry() })
    .returning({ id: sessions.id });
  if (!row) throw new Error("session insert returned no row");
  return { sessionId: row.id, token };
}

export function createSessionRepo(db: Db) {
  return {
    async createGuestSession(): Promise<{
      userId: string;
      sessionId: string;
      token: string;
    }> {
      return db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({ isGuest: true })
          .returning({ id: users.id });
        if (!user) throw new Error("guest insert returned no row");
        return { userId: user.id, ...(await insertSession(tx, user.id)) };
      });
    },

    createSession(userId: string) {
      return insertSession(db, userId);
    },

    async resolve(token: string): Promise<ResolvedSession | undefined> {
      const [row] = await db
        .select({
          sessionId: sessions.id,
          userId: sessions.userId,
          isGuest: users.isGuest,
          expiresAt: sessions.expiresAt,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            eq(sessions.tokenHash, hashToken(token)),
            gt(sessions.expiresAt, sql`now()`),
          ),
        );
      return row;
    },

    async extend(sessionId: string): Promise<void> {
      await db
        .update(sessions)
        .set({ expiresAt: newExpiry() })
        .where(eq(sessions.id, sessionId));
    },

    async deleteSession(sessionId: string): Promise<void> {
      await db.delete(sessions).where(eq(sessions.id, sessionId));
    },

    async isGuestUser(userId: string): Promise<boolean> {
      const [row] = await db
        .select({ isGuest: users.isGuest })
        .from(users)
        .where(eq(users.id, userId));
      return row?.isGuest === true;
    },

    async touchUser(userId: string): Promise<void> {
      await db
        .update(users)
        .set({ lastSeenAt: sql`now()` })
        .where(
          and(
            eq(users.id, userId),
            lt(users.lastSeenAt, sql`now() - interval '1 minute'`),
          ),
        );
    },

    async label(userId: string): Promise<string | null> {
      const [row] = await db
        .select({
          method: authIdentities.method,
          subject: authIdentities.subject,
        })
        .from(authIdentities)
        .where(eq(authIdentities.userId, userId))
        .orderBy(asc(authIdentities.createdAt))
        .limit(1);
      if (!row) return null;
      return row.method === "email" ? row.subject : "Apple ID";
    },
  };
}

export type SessionRepo = ReturnType<typeof createSessionRepo>;
