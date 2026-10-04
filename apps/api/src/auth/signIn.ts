import {
  authIdentities,
  type Db,
  llmUsage,
  playlists,
  sessions,
  users,
} from "@tunelynk/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { insertSession, type Tx } from "./sessions";

export type Identity = { method: "email" | "apple"; subject: string };

async function findIdentityUser(
  tx: Tx,
  identity: Identity,
): Promise<string | undefined> {
  const [row] = await tx
    .select({ userId: authIdentities.userId })
    .from(authIdentities)
    .where(
      and(
        eq(authIdentities.method, identity.method),
        eq(authIdentities.subject, identity.subject),
      ),
    );
  return row?.userId;
}

async function findOrCreateUser(tx: Tx, identity: Identity): Promise<string> {
  const existing = await findIdentityUser(tx, identity);
  if (existing) return existing;

  const [user] = await tx
    .insert(users)
    .values({ isGuest: false })
    .returning({ id: users.id });
  if (!user) throw new Error("user insert returned no row");
  const [linked] = await tx
    .insert(authIdentities)
    .values({ userId: user.id, ...identity })
    .onConflictDoNothing({
      target: [authIdentities.method, authIdentities.subject],
    })
    .returning({ userId: authIdentities.userId });
  if (linked) return linked.userId;

  // A concurrent sign-in created this identity first (the insert waited for
  // it to commit). Drop our user and use theirs.
  await tx.delete(users).where(eq(users.id, user.id));
  const winner = await findIdentityUser(tx, identity);
  if (!winner) throw new Error("identity vanished during sign-in");
  return winner;
}

// Signs a person in as `identity`. Claims each listed guest (its playlists and
// usage move to the account, then the guest and its sessions are deleted), and
// replaces the current session so a pre-login cookie never becomes a login.
export async function finishSignIn(
  db: Db,
  args: {
    identity: Identity;
    guestUserIds: (string | null | undefined)[];
    currentSessionId?: string | null;
  },
): Promise<{ userId: string; sessionId: string; token: string }> {
  return db.transaction(async (tx) => {
    const userId = await findOrCreateUser(tx, args.identity);

    const candidates = [
      ...new Set(
        args.guestUserIds.filter(
          (id): id is string => typeof id === "string" && id !== userId,
        ),
      ),
    ];
    // createRun holds the same per-user lock while it inserts, so a claim
    // never misses (and cascade-deletes) a playlist that is mid-insert.
    // Sorted so two sign-ins can't take the locks in opposite orders.
    for (const id of [userId, ...candidates].sort()) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
    }
    if (candidates.length > 0) {
      const guests = (
        await tx
          .select({ id: users.id })
          .from(users)
          .where(and(inArray(users.id, candidates), eq(users.isGuest, true)))
      ).map((row) => row.id);
      if (guests.length > 0) {
        await tx
          .update(playlists)
          .set({ userId })
          .where(inArray(playlists.userId, guests));
        await tx
          .update(llmUsage)
          .set({ userId })
          .where(inArray(llmUsage.userId, guests));
        // Cascades to the guests' sessions.
        await tx.delete(users).where(inArray(users.id, guests));
      }
    }

    if (args.currentSessionId) {
      await tx.delete(sessions).where(eq(sessions.id, args.currentSessionId));
    }
    const session = await insertSession(tx, userId);
    return { userId, ...session };
  });
}
