# Slice A: Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guests and (future) signed-in users are identified by one server-side session cookie, `tl_session`. Existing `tl_guest` cookies upgrade silently. `finishSignIn` can create or find an account, claim guests and rotate the session. `GET /api/me` and `POST /api/auth/signout` work. Guest generation behaves exactly as before.

**Architecture:**
- New tables `auth_identities`, `login_tokens`, `sessions` (one Drizzle migration).
- A new `apps/api/src/auth/` module:
  - `tokens.ts`: random tokens and SHA-256 hashing.
  - `returnTo.ts`: open-redirect-safe paths.
  - `sessions.ts`: session repo with every session/identity query.
  - `signIn.ts`: `finishSignIn`, a single transaction.
  - `middleware.ts`: Hono middleware that resolves `c.var.user`, plus cookie helpers and `ensureUser`.
  - `routes.ts`: `/me` and `/auth/signout`.
- `runs/routes.ts` drops its own cookie code and uses `ensureUser`.
- The executor records usage by `runId`, so the playlist's *current* owner gets it even after a claim.

**Tech Stack:** Hono 4.13 (`hono/cookie`, `hono/factory`), Drizzle ORM 0.45 + drizzle-kit 0.31, postgres-js, zod 4, Vitest 5, `node:crypto`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-03-accounts-design.md`: sections "Data model", "Sessions (slice A)", "Error handling", "Testing → A". Earlier code: #10 slice C plan `docs/superpowers/plans/2026-10-02-slice-c-runs-api.md`.

## Global Constraints

- Branch `feat/11-slice-a-sessions`, created from `feat/11-accounts-spec` (holds the spec and this plan). The PR targets `main`.
- Node 22.23.3. If the shell resolves 22.19, prefix commands with `export PATH="$HOME/Library/Application Support/Herd/config/nvm/versions/node/v22.23.3/bin:$PATH" &&`.
- Local Postgres up (`pnpm db:up`). Integration tests create and drop their own databases (`apps/api/src/test/db.ts`).
- Session cookie `tl_session`:
  - Value: 32 random bytes, base64url (43 chars). DB stores only `sha256(token)` as lowercase hex in `sessions.token_hash`.
  - Attributes: `httpOnly`, `SameSite=Lax`, `Secure` from `COOKIE_SECURE`, `Path=/`, `Max-Age=2592000` (30 days).
- Session lifetime: 30 days. Non-guest sessions with fewer than **15 days** left are extended to 30 days and the cookie is re-set. Guest sessions never slide.
- Legacy cookie `tl_guest`:
  - Signed with `SESSION_SECRET` via Hono's signed cookies; value = user uuid.
  - If no valid session exists and it names an existing **guest** user: create a session for that user, set `tl_session`, delete `tl_guest`.
  - If present but unusable: delete it.
- `GET /api/me` → `{ "user": null }` or `{ "user": { "id", "isGuest", "label" } }`. `label` is the email subject for `email`, the literal `"Apple ID"` for `apple`, `null` for guests.
- `POST /api/auth/signout` → `204`, deletes the session row if any, clears `tl_session`.
- `GET` requests never create users. A guest user and session are created only by `POST /api/runs` when there is no user.
- `llm_usage.kind`: `'guest'` when the run's creator was a guest at creation time, otherwise `'user'`.
- Tests stay colocated in `src/` (moving them is #29).
- Format each package with `pnpm --filter <pkg> exec biome check --write .` before each commit.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A request carrying both an expired or unknown `tl_session` and a valid legacy `tl_guest`.** The legacy upgrade should win and leave exactly one live `tl_session`, not clear the new cookie. Test in Task 5.
2. **A malformed or tampered legacy `tl_guest`, or one naming a non-guest or missing user.** It should be ignored and deleted, never a 500 (a non-uuid value must not reach a `uuid` column). Test in Task 5.
3. **A signed-in user who generates.** `POST /api/runs` must reuse their user and not mint a guest, and usage must be recorded as `kind = 'user'`. Test in Task 6.
4. **A guest's run that finishes after that guest was claimed.** Usage should land on the account, not fail the FK or vanish. Test in Task 6.
5. **Two simultaneous first sign-ins with the same identity.** Both should end on one user, with one `auth_identities` row and no orphan user. Test in Task 4.

---

### Task 1: Auth tables and migration

**Files:**
- Modify: `packages/db/src/schema.ts` (append after `llmUsage`; add `unique` to the pg-core import)
- Create: `packages/db/migrations/0003_auth_schema.sql` (generated) + `packages/db/migrations/meta/0003_snapshot.json` + journal entry (generated)
- Test: `packages/db/src/migrate.integration.test.ts`

**Interfaces:**
- Produces (from `@tunelynk/db`): `authMethod` enum, the tables `authIdentities`, `loginTokens`, `sessions` with the TS columns `id`, `userId`, `method`, `subject`, `createdAt` / `id`, `tokenHash`, `email`, `returnTo`, `guestUserId`, `expiresAt`, `usedAt`, `createdAt` / `id`, `tokenHash`, `userId`, `expiresAt`, `createdAt`.

- [ ] **Step 1: Write the failing test**

In `packages/db/src/migrate.integration.test.ts`, extend the table check:

```ts
      const tables = await check<{ t: string | null }[]>`
        select to_regclass(name)::text as t from unnest(array[
          'public.users', 'public.playlists', 'public.generation_runs',
          'public.tracks', 'public.run_tracks', 'public.llm_usage',
          'public.auth_identities', 'public.login_tokens', 'public.sessions',
          'public.app_meta'
        ]) as name`;
      expect(tables.map((r) => r.t)).toEqual([
        "users",
        "playlists",
        "generation_runs",
        "tracks",
        "run_tracks",
        "llm_usage",
        "auth_identities",
        "login_tokens",
        "sessions",
        null,
      ]);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tunelynk/db test:integration`
Expected: FAIL. The array has `null` where `"auth_identities"`, `"login_tokens"` and `"sessions"` are expected.

- [ ] **Step 3: Add the schema**

In `packages/db/src/schema.ts`, add `unique` to the `drizzle-orm/pg-core` import list. After the `usageKind` enum add:

```ts
export const authMethod = pgEnum("auth_method", ["email", "apple"]);
```

Append at the end of the file:

```ts
// Login identity (not a music connection). email: lowercased address;
// apple: the id_token `sub`. Identities are never linked across methods.
export const authIdentities = pgTable(
  "auth_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    method: authMethod("method").notNull(),
    subject: text("subject").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("auth_identities_method_subject_key").on(t.method, t.subject),
    index("auth_identities_user_id_idx").on(t.userId),
  ],
);

// Magic-link tokens. Only the SHA-256 of the token is stored.
export const loginTokens = pgTable(
  "login_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    email: text("email").notNull(),
    returnTo: text("return_to"),
    // The guest that requested the link, claimed on verify.
    guestUserId: uuid("guest_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("login_tokens_email_created_at_idx").on(t.email, t.createdAt)],
);

// Server-side sessions for guests and users. The cookie holds a random token;
// only its SHA-256 is stored.
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate --name auth_schema`
Expected: creates `packages/db/migrations/0003_auth_schema.sql` with `CREATE TYPE "public"."auth_method"`, three `CREATE TABLE`s, FKs and indexes, and adds entry `idx: 3` to `meta/_journal.json`. Open the SQL and confirm it contains no `DROP` and does not alter existing tables.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @tunelynk/db test:integration && pnpm --filter @tunelynk/db typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm --filter @tunelynk/db exec biome check --write .
git add packages/db
git commit -m "feat(db): add auth_identities, login_tokens and sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Token helpers, safe returnTo, and the Me contract

**Files:**
- Create: `apps/api/src/auth/tokens.ts`, `apps/api/src/auth/returnTo.ts`, `packages/shared/src/auth.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `apps/api/src/auth/tokens.test.ts`, `apps/api/src/auth/returnTo.test.ts`, `packages/shared/src/auth.test.ts`

**Interfaces:**
- Produces:
  - `newToken(): string` (43-char base64url)
  - `hashToken(token: string): string` (64-char lowercase hex)
  - `safeReturnTo(value: unknown): string | undefined`
  - `MeResponse` zod schema/type `{ user: { id: string; isGuest: boolean; label: string | null } | null }` from `@tunelynk/shared`

- [ ] **Step 1: Write the failing tests**

`apps/api/src/auth/tokens.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hashToken, newToken } from "./tokens";

describe("newToken", () => {
  it("returns 32 random bytes as base64url", () => {
    const token = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("never repeats", () => {
    const tokens = new Set(Array.from({ length: 100 }, newToken));
    expect(tokens.size).toBe(100);
  });
});

describe("hashToken", () => {
  it("is the lowercase hex SHA-256", () => {
    expect(hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
```

`apps/api/src/auth/returnTo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { safeReturnTo } from "./returnTo";

describe("safeReturnTo", () => {
  it.each([
    "/",
    "/playlists/abc/runs/def?keep=1",
    "/signin?returnTo=%2F",
  ])("keeps the same-site path %s", (path) => {
    expect(safeReturnTo(path)).toBe(path);
  });

  it.each([
    ["protocol-relative", "//evil.com"],
    ["backslash trick", "/\\evil.com"],
    ["absolute URL", "https://evil.com/"],
    ["relative path", "playlists"],
    ["empty", ""],
    ["control character", "/a\nb"],
    ["too long", `/${"a".repeat(512)}`],
    ["not a string", 42],
    ["undefined", undefined],
  ])("drops %s", (_label, value) => {
    expect(safeReturnTo(value)).toBeUndefined();
  });
});
```

`packages/shared/src/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MeResponse } from "./auth";

describe("MeResponse", () => {
  it.each([
    { user: null },
    {
      user: {
        id: "6f1c2a8e-3b7d-4c55-9a10-2f4e8d6b1c33",
        isGuest: true,
        label: null,
      },
    },
    {
      user: {
        id: "6f1c2a8e-3b7d-4c55-9a10-2f4e8d6b1c33",
        isGuest: false,
        label: "a@b.co",
      },
    },
  ])("accepts %o", (payload) => {
    expect(MeResponse.parse(payload)).toEqual(payload);
  });

  it.each([{}, { user: { id: "x", isGuest: true, label: null } }])(
    "rejects %o",
    (payload) => {
      expect(MeResponse.safeParse(payload).success).toBe(false);
    },
  );
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @tunelynk/api exec vitest run src/auth && pnpm --filter @tunelynk/shared test`
Expected: FAIL. The imports cannot be resolved (`./tokens`, `./returnTo`, `./auth`).

- [ ] **Step 3: Implement**

`apps/api/src/auth/tokens.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";

// Session and login tokens: 32 random bytes, URL- and cookie-safe.
export const newToken = (): string => randomBytes(32).toString("base64url");

// Only the hash is stored, so a database leak does not leak live tokens.
export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");
```

`apps/api/src/auth/returnTo.ts`:

```ts
const MAX_LENGTH = 512;

// Accepts only same-site absolute paths, so a crafted link can't bounce a
// freshly signed-in user to another origin.
export function safeReturnTo(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length === 0 || value.length > MAX_LENGTH) return undefined;
  if (!value.startsWith("/")) return undefined;
  if (value.startsWith("//") || value.startsWith("/\\")) return undefined;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return value;
}
```

`packages/shared/src/auth.ts`:

```ts
import { z } from "zod";

export const MeUser = z.object({
  id: z.uuid(),
  isGuest: z.boolean(),
  // Email address, "Apple ID", or null for guests.
  label: z.string().nullable(),
});
export type MeUser = z.infer<typeof MeUser>;

export const MeResponse = z.object({ user: MeUser.nullable() });
export type MeResponse = z.infer<typeof MeResponse>;
```

`packages/shared/src/index.ts` becomes:

```ts
export * from "./auth";
export * from "./health";
export * from "./runs";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @tunelynk/api exec vitest run src/auth && pnpm --filter @tunelynk/shared test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm --filter @tunelynk/api exec biome check --write . && pnpm --filter @tunelynk/shared exec biome check --write .
git add apps/api/src/auth packages/shared/src
git commit -m "feat(api): token hashing, safe returnTo, and the me contract

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Session repo

**Files:**
- Create: `apps/api/src/auth/sessions.ts`
- Test: `apps/api/src/auth/sessions.integration.test.ts`

**Interfaces:**
- Consumes: `newToken`, `hashToken` (Task 2); tables from Task 1.
- Produces:
  ```ts
  export const SESSION_TTL_MS: number;          // 30 days
  export const SESSION_RENEW_BELOW_MS: number;  // 15 days
  export type Tx; export type DbOrTx = Db | Tx;
  export type ResolvedSession = { sessionId: string; userId: string; isGuest: boolean; expiresAt: Date };
  export function insertSession(db: DbOrTx, userId: string): Promise<{ sessionId: string; token: string }>;
  export function createSessionRepo(db: Db): {
    createGuestSession(): Promise<{ userId: string; sessionId: string; token: string }>;
    createSession(userId: string): Promise<{ sessionId: string; token: string }>;
    resolve(token: string): Promise<ResolvedSession | undefined>;
    extend(sessionId: string): Promise<void>;
    deleteSession(sessionId: string): Promise<void>;
    isGuestUser(userId: string): Promise<boolean>;
    touchUser(userId: string): Promise<void>;
    label(userId: string): Promise<string | null>;
  };
  export type SessionRepo = ReturnType<typeof createSessionRepo>;
  ```

- [ ] **Step 1: Write the failing test**

`apps/api/src/auth/sessions.integration.test.ts`:

```ts
import { authIdentities, sessions, users } from "@tunelynk/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test/db";
import { createSessionRepo, type SessionRepo } from "./sessions";
import { hashToken } from "./tokens";

const DAY_MS = 86_400_000;

describe.skipIf(!process.env.DATABASE_URL)("session repo", () => {
  let handle: Awaited<ReturnType<typeof createTestDatabase>>;
  let repo: SessionRepo;

  beforeAll(async () => {
    handle = await createTestDatabase();
    repo = createSessionRepo(handle.db);
  });
  afterAll(() => handle.drop());
  beforeEach(async () => {
    await handle.db.execute(sql`truncate users cascade`);
  });

  const newUser = async (isGuest: boolean) => {
    const [row] = await handle.db
      .insert(users)
      .values({ isGuest })
      .returning({ id: users.id });
    if (!row) throw new Error("no user");
    return row.id;
  };

  it("creates a guest with a session whose token resolves", async () => {
    const { userId, sessionId, token } = await repo.createGuestSession();
    const [stored] = await handle.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(stored?.tokenHash).toBe(hashToken(token));
    expect(stored?.userId).toBe(userId);
    const resolved = await repo.resolve(token);
    expect(resolved).toMatchObject({ sessionId, userId, isGuest: true });
    const ttl = (resolved?.expiresAt.getTime() ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(29 * DAY_MS);
    expect(ttl).toBeLessThanOrEqual(30 * DAY_MS);
  });

  it("resolves sessions for non-guest users", async () => {
    const userId = await newUser(false);
    const { token } = await repo.createSession(userId);
    expect(await repo.resolve(token)).toMatchObject({ userId, isGuest: false });
  });

  it("does not resolve unknown or expired tokens", async () => {
    expect(await repo.resolve("nope")).toBeUndefined();
    const { sessionId, token } = await repo.createGuestSession();
    await handle.db
      .update(sessions)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(sessions.id, sessionId));
    expect(await repo.resolve(token)).toBeUndefined();
  });

  it("extends a session to 30 days", async () => {
    const { sessionId, token } = await repo.createSession(await newUser(false));
    await handle.db
      .update(sessions)
      .set({ expiresAt: sql`now() + interval '1 day'` })
      .where(eq(sessions.id, sessionId));
    await repo.extend(sessionId);
    const ttl = ((await repo.resolve(token))?.expiresAt.getTime() ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(29 * DAY_MS);
  });

  it("deletes a session", async () => {
    const { sessionId, token } = await repo.createGuestSession();
    await repo.deleteSession(sessionId);
    expect(await repo.resolve(token)).toBeUndefined();
  });

  it("drops sessions when their user is deleted", async () => {
    const { userId, token } = await repo.createGuestSession();
    await handle.db.delete(users).where(eq(users.id, userId));
    expect(await repo.resolve(token)).toBeUndefined();
  });

  it("isGuestUser is true only for existing guests", async () => {
    expect(await repo.isGuestUser(await newUser(true))).toBe(true);
    expect(await repo.isGuestUser(await newUser(false))).toBe(false);
    expect(
      await repo.isGuestUser("00000000-0000-4000-8000-000000000000"),
    ).toBe(false);
  });

  it("touches last_seen_at at most once a minute", async () => {
    const userId = await newUser(true);
    await handle.db
      .update(users)
      .set({ lastSeenAt: sql`now() - interval '2 minutes'` })
      .where(eq(users.id, userId));
    const read = async () =>
      (
        await handle.db
          .select({ t: users.lastSeenAt })
          .from(users)
          .where(eq(users.id, userId))
      )[0]?.t.getTime() ?? 0;
    const stale = await read();
    await repo.touchUser(userId);
    const fresh = await read();
    expect(fresh).toBeGreaterThan(stale);
    await repo.touchUser(userId);
    expect(await read()).toBe(fresh);
  });

  it("labels users by their identity", async () => {
    const guest = await newUser(true);
    const emailUser = await newUser(false);
    const appleUser = await newUser(false);
    await handle.db.insert(authIdentities).values([
      { userId: emailUser, method: "email", subject: "a@b.co" },
      { userId: appleUser, method: "apple", subject: "001234.abc" },
    ]);
    expect(await repo.label(guest)).toBeNull();
    expect(await repo.label(emailUser)).toBe("a@b.co");
    expect(await repo.label(appleUser)).toBe("Apple ID");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tunelynk/api exec vitest run src/auth/sessions.integration.test.ts`
Expected: FAIL. `./sessions` cannot be resolved.

- [ ] **Step 3: Implement `apps/api/src/auth/sessions.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tunelynk/api exec vitest run src/auth/sessions.integration.test.ts && pnpm --filter @tunelynk/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm --filter @tunelynk/api exec biome check --write .
git add apps/api/src/auth
git commit -m "feat(api): session repo with hashed tokens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `finishSignIn` with guest claim

**Files:**
- Create: `apps/api/src/auth/signIn.ts`
- Test: `apps/api/src/auth/signIn.integration.test.ts`

**Interfaces:**
- Consumes: `insertSession`, `Tx`, `createSessionRepo` (Task 3).
- Produces:
  ```ts
  export type Identity = { method: "email" | "apple"; subject: string };
  export function finishSignIn(db: Db, args: {
    identity: Identity;
    guestUserIds: (string | null | undefined)[];
    currentSessionId?: string | null;
  }): Promise<{ userId: string; sessionId: string; token: string }>;
  ```
  Slices B and C call this. The caller sets the cookie with `setSessionCookie` (Task 5).

- [ ] **Step 1: Write the failing test**

`apps/api/src/auth/signIn.integration.test.ts`:

```ts
import {
  authIdentities,
  llmUsage,
  playlists,
  sessions,
  users,
} from "@tunelynk/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test/db";
import { createSessionRepo, type SessionRepo } from "./sessions";
import { finishSignIn } from "./signIn";

const email = { method: "email", subject: "a@b.co" } as const;

describe.skipIf(!process.env.DATABASE_URL)("finishSignIn", () => {
  let handle: Awaited<ReturnType<typeof createTestDatabase>>;
  let repo: SessionRepo;

  beforeAll(async () => {
    handle = await createTestDatabase();
    repo = createSessionRepo(handle.db);
  });
  afterAll(() => handle.drop());
  beforeEach(async () => {
    await handle.db.execute(sql`truncate users, llm_usage cascade`);
  });

  const count = async (
    table: typeof users | typeof authIdentities | typeof sessions,
  ) =>
    (await handle.db.select({ n: sql<number>`count(*)::int` }).from(table))[0]
      ?.n ?? 0;

  // A guest with one playlist, one usage row and a session.
  const newGuest = async () => {
    const guest = await repo.createGuestSession();
    const [playlist] = await handle.db
      .insert(playlists)
      .values({ userId: guest.userId, name: "p", prompt: "p", length: 20 })
      .returning({ id: playlists.id });
    await handle.db.insert(llmUsage).values({
      userId: guest.userId,
      model: "claude-haiku-4-5",
      inputTokens: 1,
      outputTokens: 1,
      costMicros: 1,
      kind: "guest",
    });
    return { ...guest, playlistId: playlist?.id ?? "" };
  };

  const ownerOf = async (playlistId: string) =>
    (
      await handle.db
        .select({ u: playlists.userId })
        .from(playlists)
        .where(eq(playlists.id, playlistId))
    )[0]?.u;

  it("creates a user and identity on first sign-in, with a live session", async () => {
    const { userId, token } = await finishSignIn(handle.db, {
      identity: email,
      guestUserIds: [],
    });
    expect(await repo.resolve(token)).toMatchObject({ userId, isGuest: false });
    expect(await repo.label(userId)).toBe("a@b.co");
  });

  it("returns the same user for the same identity", async () => {
    const first = await finishSignIn(handle.db, { identity: email, guestUserIds: [] });
    const second = await finishSignIn(handle.db, { identity: email, guestUserIds: [] });
    expect(second.userId).toBe(first.userId);
    expect(await count(authIdentities)).toBe(1);
  });

  it("keeps methods apart even with the same subject", async () => {
    const a = await finishSignIn(handle.db, { identity: email, guestUserIds: [] });
    const b = await finishSignIn(handle.db, {
      identity: { method: "apple", subject: "a@b.co" },
      guestUserIds: [],
    });
    expect(b.userId).not.toBe(a.userId);
  });

  it("claims a guest: moves playlists and usage, deletes the guest and its sessions", async () => {
    const guest = await newGuest();
    const { userId } = await finishSignIn(handle.db, {
      identity: email,
      guestUserIds: [guest.userId],
      currentSessionId: guest.sessionId,
    });
    expect(await ownerOf(guest.playlistId)).toBe(userId);
    const usage = await handle.db.select({ u: llmUsage.userId }).from(llmUsage);
    expect(usage).toEqual([{ u: userId }]);
    expect(await repo.resolve(guest.token)).toBeUndefined();
    expect(await repo.isGuestUser(guest.userId)).toBe(false);
    expect(await count(users)).toBe(1);
  });

  it("claims two guests and ignores null, undefined and duplicate ids", async () => {
    const a = await newGuest();
    const b = await newGuest();
    const { userId } = await finishSignIn(handle.db, {
      identity: email,
      guestUserIds: [a.userId, null, b.userId, undefined, a.userId],
    });
    expect(await ownerOf(a.playlistId)).toBe(userId);
    expect(await ownerOf(b.playlistId)).toBe(userId);
    expect(await count(users)).toBe(1);
  });

  it("never claims a non-guest user", async () => {
    const other = await finishSignIn(handle.db, {
      identity: { method: "email", subject: "other@b.co" },
      guestUserIds: [],
    });
    const [playlist] = await handle.db
      .insert(playlists)
      .values({ userId: other.userId, name: "p", prompt: "p", length: 20 })
      .returning({ id: playlists.id });
    await finishSignIn(handle.db, {
      identity: email,
      guestUserIds: [other.userId],
    });
    expect(await ownerOf(playlist?.id ?? "")).toBe(other.userId);
    expect(await repo.resolve(other.token)).toBeDefined();
  });

  it("rotates the current session", async () => {
    const first = await finishSignIn(handle.db, { identity: email, guestUserIds: [] });
    const second = await finishSignIn(handle.db, {
      identity: { method: "apple", subject: "001.abc" },
      guestUserIds: [],
      currentSessionId: first.sessionId,
    });
    expect(await repo.resolve(first.token)).toBeUndefined();
    expect(await repo.resolve(second.token)).toMatchObject({
      userId: second.userId,
    });
  });

  it("resolves two simultaneous first sign-ins to one user", async () => {
    const results = await Promise.all([
      finishSignIn(handle.db, { identity: email, guestUserIds: [] }),
      finishSignIn(handle.db, { identity: email, guestUserIds: [] }),
    ]);
    expect(results[0].userId).toBe(results[1].userId);
    expect(await count(authIdentities)).toBe(1);
    expect(await count(users)).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tunelynk/api exec vitest run src/auth/signIn.integration.test.ts`
Expected: FAIL. `./signIn` cannot be resolved.

- [ ] **Step 3: Implement `apps/api/src/auth/signIn.ts`**

```ts
import {
  authIdentities,
  type Db,
  llmUsage,
  playlists,
  sessions,
  users,
} from "@tunelynk/db";
import { and, eq, inArray } from "drizzle-orm";
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tunelynk/api exec vitest run src/auth/signIn.integration.test.ts && pnpm --filter @tunelynk/api typecheck`
Expected: PASS, including the concurrent test.

If the concurrent test fails with a deadlock or unique violation, check that `onConflictDoNothing` targets `(method, subject)` exactly. Postgres makes the second insert wait for the first transaction and then skip.

- [ ] **Step 5: Commit**

```bash
pnpm --filter @tunelynk/api exec biome check --write .
git add apps/api/src/auth
git commit -m "feat(api): finishSignIn claims guests and rotates the session

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Session middleware, `/api/me`, sign out

**Files:**
- Create: `apps/api/src/auth/middleware.ts`, `apps/api/src/auth/routes.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/index.ts`, `apps/api/src/app.test.ts`, `apps/api/src/app.web.test.ts`, `apps/api/src/app.integration.test.ts` (add the `auth` dep to every `createApp` call)
- Test: `apps/api/src/auth/routes.integration.test.ts`

**Interfaces:**
- Consumes: `SessionRepo`, `SESSION_TTL_MS`, `SESSION_RENEW_BELOW_MS` (Task 3); `finishSignIn` (Task 4, test only); `MeResponse` (Task 2).
- Produces:
  ```ts
  export const SESSION_COOKIE = "tl_session";
  export const LEGACY_GUEST_COOKIE = "tl_guest";
  export type CurrentUser = { id: string; isGuest: boolean };
  export type AuthEnv = { Variables: { user: CurrentUser | null; sessionId: string | null } };
  export type AuthDeps = { sessions: SessionRepo; sessionSecret: string; secureCookies: boolean };
  export function setSessionCookie(c: Context, token: string, secure: boolean): void;
  export function clearSessionCookie(c: Context, secure: boolean): void;
  export function sessionMiddleware(deps: AuthDeps): MiddlewareHandler<AuthEnv>;
  export function ensureUser(c: Context<AuthEnv>, deps: AuthDeps): Promise<CurrentUser>;
  // routes.ts
  export function meRoutes(deps: AuthDeps): Hono<AuthEnv>;
  export function authRoutes(deps: AuthDeps): Hono<AuthEnv>;
  // app.ts
  export type AppDeps = { db: Db; webDir?: string; auth: AuthDeps; runs: RunsDeps };
  ```

- [ ] **Step 1: Write the failing test**

`apps/api/src/auth/routes.integration.test.ts`:

```ts
import { sessions, users } from "@tunelynk/db";
import { eq, sql } from "drizzle-orm";
import { generateSignedCookie } from "hono/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { RunsDeps } from "../runs/routes";
import { createTestDatabase } from "../test/db";
import { createSessionRepo, type SessionRepo } from "./sessions";
import { finishSignIn } from "./signIn";

const SECRET = "test-secret-test-secret-test-secret!";
const DAY_MS = 86_400_000;

const setCookies = (res: Response) => res.headers.getSetCookie();
const cookieValue = (res: Response, name: string) =>
  setCookies(res)
    .filter((c) => c.startsWith(`${name}=`))
    .at(-1)
    ?.split(";")[0]
    ?.slice(name.length + 1);
const legacyCookie = async (value: string, secret = SECRET) =>
  (await generateSignedCookie("tl_guest", value, secret)).split(";")[0] ?? "";

describe.skipIf(!process.env.DATABASE_URL)("session middleware + /api/me + signout", () => {
  let handle: Awaited<ReturnType<typeof createTestDatabase>>;
  let repo: SessionRepo;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    handle = await createTestDatabase();
    repo = createSessionRepo(handle.db);
    app = createApp({
      db: handle.db,
      auth: { sessions: repo, sessionSecret: SECRET, secureCookies: false },
      runs: {} as RunsDeps, // never hit here
    });
  });
  afterAll(() => handle.drop());
  beforeEach(async () => {
    await handle.db.execute(sql`truncate users cascade`);
  });

  const me = (cookie = "") =>
    app.request("/api/me", { headers: cookie ? { cookie } : {} });
  const signout = (cookie = "") =>
    app.request("/api/auth/signout", {
      method: "POST",
      headers: cookie ? { cookie } : {},
    });
  const userCount = async () =>
    (await handle.db.select({ n: sql<number>`count(*)::int` }).from(users))[0]
      ?.n ?? 0;

  it("reports no user without cookies and creates nothing", async () => {
    const res = await me();
    expect(await res.json()).toEqual({ user: null });
    expect(setCookies(res)).toEqual([]);
    expect(await userCount()).toBe(0);
  });

  it("reports a guest session", async () => {
    const guest = await repo.createGuestSession();
    const res = await me(`tl_session=${guest.token}`);
    expect(await res.json()).toEqual({
      user: { id: guest.userId, isGuest: true, label: null },
    });
  });

  it("labels email and Apple users", async () => {
    const mail = await finishSignIn(handle.db, {
      identity: { method: "email", subject: "a@b.co" },
      guestUserIds: [],
    });
    const apple = await finishSignIn(handle.db, {
      identity: { method: "apple", subject: "001.abc" },
      guestUserIds: [],
    });
    expect(await (await me(`tl_session=${mail.token}`)).json()).toEqual({
      user: { id: mail.userId, isGuest: false, label: "a@b.co" },
    });
    expect(await (await me(`tl_session=${apple.token}`)).json()).toEqual({
      user: { id: apple.userId, isGuest: false, label: "Apple ID" },
    });
  });

  it("clears an unknown or expired session cookie", async () => {
    const unknown = await me("tl_session=garbage");
    expect(await unknown.json()).toEqual({ user: null });
    expect(setCookies(unknown).join()).toMatch(/tl_session=;.*Max-Age=0/);

    const guest = await repo.createGuestSession();
    await handle.db
      .update(sessions)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(sessions.id, guest.sessionId));
    const expired = await me(`tl_session=${guest.token}`);
    expect(await expired.json()).toEqual({ user: null });
    expect(cookieValue(expired, "tl_session")).toBe("");
  });

  it("slides a signed-in session with under 15 days left", async () => {
    const user = await finishSignIn(handle.db, {
      identity: { method: "email", subject: "a@b.co" },
      guestUserIds: [],
    });
    await handle.db
      .update(sessions)
      .set({ expiresAt: sql`now() + interval '10 days'` })
      .where(eq(sessions.id, user.sessionId));
    const res = await me(`tl_session=${user.token}`);
    expect(cookieValue(res, "tl_session")).toBe(user.token);
    expect(setCookies(res).join()).toMatch(/Max-Age=2592000/);
    const ttl =
      ((await repo.resolve(user.token))?.expiresAt.getTime() ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(29 * DAY_MS);
  });

  it("does not slide a fresh session or any guest session", async () => {
    const user = await finishSignIn(handle.db, {
      identity: { method: "email", subject: "a@b.co" },
      guestUserIds: [],
    });
    expect(setCookies(await me(`tl_session=${user.token}`))).toEqual([]);

    const guest = await repo.createGuestSession();
    await handle.db
      .update(sessions)
      .set({ expiresAt: sql`now() + interval '10 days'` })
      .where(eq(sessions.id, guest.sessionId));
    expect(setCookies(await me(`tl_session=${guest.token}`))).toEqual([]);
  });

  it("upgrades a legacy tl_guest cookie to a session", async () => {
    const [guest] = await handle.db
      .insert(users)
      .values({ isGuest: true })
      .returning({ id: users.id });
    const res = await me(await legacyCookie(guest?.id ?? ""));
    expect(await res.json()).toEqual({
      user: { id: guest?.id, isGuest: true, label: null },
    });
    expect(cookieValue(res, "tl_guest")).toBe("");
    const token = cookieValue(res, "tl_session") ?? "";
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await repo.resolve(token)).toMatchObject({ userId: guest?.id });
  });

  it("prefers the legacy upgrade over clearing a stale session cookie", async () => {
    const [guest] = await handle.db
      .insert(users)
      .values({ isGuest: true })
      .returning({ id: users.id });
    const res = await me(
      `tl_session=garbage; ${await legacyCookie(guest?.id ?? "")}`,
    );
    expect((await res.json()) as unknown).toMatchObject({
      user: { id: guest?.id },
    });
    const token = cookieValue(res, "tl_session") ?? "";
    expect(await repo.resolve(token)).toMatchObject({ userId: guest?.id });
  });

  it.each([
    ["tampered", async () => `${await legacyCookie(crypto.randomUUID())}x`],
    ["wrong secret", () => legacyCookie(crypto.randomUUID(), `${SECRET}?`)],
    ["not a uuid", () => legacyCookie("not-a-uuid")],
    ["missing user", () => legacyCookie(crypto.randomUUID())],
  ])("ignores and deletes a %s legacy cookie", async (_label, make) => {
    const res = await me(await make());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
    expect(cookieValue(res, "tl_guest")).toBe("");
    expect(await userCount()).toBe(0);
  });

  it("does not upgrade a legacy cookie that names a non-guest user", async () => {
    const user = await finishSignIn(handle.db, {
      identity: { method: "email", subject: "a@b.co" },
      guestUserIds: [],
    });
    const res = await me(await legacyCookie(user.userId));
    expect(await res.json()).toEqual({ user: null });
  });

  it("signs out: deletes the session and clears the cookie", async () => {
    const guest = await repo.createGuestSession();
    const res = await signout(`tl_session=${guest.token}`);
    expect(res.status).toBe(204);
    expect(cookieValue(res, "tl_session")).toBe("");
    expect(await repo.resolve(guest.token)).toBeUndefined();
    expect(await (await me(`tl_session=${guest.token}`)).json()).toEqual({
      user: null,
    });
  });

  it("signs out with no session", async () => {
    expect((await signout()).status).toBe(204);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tunelynk/api exec vitest run src/auth/routes.integration.test.ts`
Expected: FAIL. Vitest does not typecheck, so the extra `auth` property is ignored and `/api/me` and `/api/auth/signout` return 404 `{"error":"Not Found"}`.

- [ ] **Step 3: Implement `apps/api/src/auth/middleware.ts`**

```ts
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
```

- [ ] **Step 4: Implement `apps/api/src/auth/routes.ts`**

```ts
import type { MeResponse } from "@tunelynk/shared";
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

export function authRoutes(deps: AuthDeps) {
  return new Hono<AuthEnv>().post("/signout", async (c) => {
    const sessionId = c.get("sessionId");
    if (sessionId) await deps.sessions.deleteSession(sessionId);
    clearSessionCookie(c, deps.secureCookies);
    return c.body(null, 204);
  });
}
```

- [ ] **Step 5: Wire `apps/api/src/app.ts`**

Add the imports:

```ts
import { type AuthDeps, type AuthEnv, sessionMiddleware } from "./auth/middleware";
import { authRoutes, meRoutes } from "./auth/routes";
```

Change `AppDeps` and the `api` sub-app:

```ts
export type AppDeps = {
  db: Db;
  // Built web SPA (must contain index.html). Unset in dev and tests.
  webDir?: string;
  auth: AuthDeps;
  runs: RunsDeps;
};
```

```ts
export function createApp({ db, webDir, auth, runs }: AppDeps) {
  const api = new Hono<AuthEnv>()
    .use("*", sessionMiddleware(auth))
    .get("/health", async (c) => {
      // …unchanged body…
    })
    .route("/me", meRoutes(auth))
    .route("/auth", authRoutes(auth))
    .route("/runs", runsRoutes(runs));
```

Leave `runsRoutes(runs)` as it is for now; Task 6 switches it to the session.

- [ ] **Step 6: Update the other `createApp` call sites**

In `apps/api/src/app.test.ts` and `apps/api/src/app.web.test.ts`, next to `const runs = {} as RunsDeps;` add:

```ts
// No cookies are sent in these tests, so the middleware never touches the repo.
const auth = {} as AuthDeps;
```

with `import type { AuthDeps } from "./auth/middleware";`. Pass `auth` in every `createApp({ ... })` call (`createApp({ runs, auth, db: … })`). In `apps/api/src/app.integration.test.ts`, pass `auth: { sessions: createSessionRepo(db), sessionSecret: "x".repeat(32), secureCookies: false }` (import `createSessionRepo` from `./auth/sessions`). In `apps/api/src/runs/routes.integration.test.ts`, pass `auth: { sessions: createSessionRepo(handle.db), sessionSecret: SECRET, secureCookies: false }` in `build()`; Task 6 rewrites that file further.

In `apps/api/src/index.ts`:

```ts
import { createSessionRepo } from "./auth/sessions";
```

```ts
const app = createApp({
  db,
  webDir,
  auth: {
    sessions: createSessionRepo(db),
    sessionSecret: env.SESSION_SECRET,
    secureCookies: env.COOKIE_SECURE,
  },
  runs: {
    // …unchanged…
  },
});
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @tunelynk/api typecheck && pnpm --filter @tunelynk/api test && pnpm --filter @tunelynk/api test:integration`
Expected: PASS. The existing runs tests still pass because runs still sets `tl_guest`. A follow-up request with that cookie also works through the middleware's legacy upgrade.

- [ ] **Step 8: Commit**

```bash
pnpm --filter @tunelynk/api exec biome check --write .
git add apps/api/src
git commit -m "feat(api): session middleware, /api/me and sign out

Resolves tl_session on every /api request and upgrades legacy tl_guest
cookies to sessions.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Runs on sessions; usage by run owner

**Files:**
- Modify: `apps/api/src/runs/routes.ts`, `apps/api/src/runs/executor.ts`, `apps/api/src/runs/repo.ts`, `apps/api/src/app.ts` (the `runsRoutes(runs, auth)` call), `apps/api/src/index.ts` (drop `sessionSecret`/`secureCookies` from `runs`)
- Test: `apps/api/src/runs/executor.test.ts`, `apps/api/src/runs/repo.integration.test.ts`, `apps/api/src/runs/routes.integration.test.ts`
- Docs: `docs/deploy.md` (one line under Operations)

**Interfaces:**
- Consumes: `ensureUser`, `AuthDeps`, `AuthEnv` (Task 5); `finishSignIn`, `createSessionRepo` (Tasks 3–4, tests).
- Produces:
  ```ts
  export type RunJob = { runId: string; kind: "guest" | "user"; prompt: string; length: number };
  export type RunsDeps = { repo: RunRepo; executor: { start(job: RunJob): Promise<void> };
                           dailyBudgetMicros: number; reservePerRunMicros: number; model: string };
  export function runsRoutes(deps: RunsDeps, auth: AuthDeps): Hono<AuthEnv>;
  // repo
  recordUsage(args: { runId: string; usage: LlmUsage; costMicros: number;
                      kind: "guest" | "user" | "scheduled" }): Promise<void>;
  ```
  `createGuest`, `findUser` and `touchUser` are removed from the run repo (the session repo owns users now).

- [ ] **Step 1: Update the executor unit tests (failing)**

In `apps/api/src/runs/executor.test.ts`, change the job and the first expectation:

```ts
const job = {
  runId: "run-1",
  kind: "guest" as const,
  prompt: "road trip",
  length: 20,
};
```

```ts
    expect(repo.recordUsage).toHaveBeenCalledWith({
      runId: "run-1",
      usage,
      costMicros: costMicros(usage),
      kind: "guest",
    });
```

Add inside `describe("createRunExecutor")`:

```ts
  it("records usage with the job's kind", async () => {
    const repo = fakeRepo();
    await createRunExecutor({ repo, engine: async () => result }).start({
      ...job,
      kind: "user",
    });
    expect(repo.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", kind: "user" }),
    );
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @tunelynk/api exec vitest run src/runs/executor.test.ts`
Expected: FAIL. `recordUsage` was called with `{ userId: …, kind: "guest" }` instead of `{ runId: "run-1", … }`.

- [ ] **Step 3: Change the executor and `recordUsage`**

In `apps/api/src/runs/executor.ts`:

```ts
export type RunJob = {
  runId: string;
  // Who started the run, for llm_usage.kind. The usage row's user is the
  // playlist's owner when it is written (a guest may be claimed mid-run).
  kind: "guest" | "user";
  prompt: string;
  length: number;
};
```

```ts
  const recordUsage = (job: RunJob, usage: LlmUsage) =>
    repo.recordUsage({
      runId: job.runId,
      usage,
      costMicros: costMicros(usage),
      kind: job.kind,
    });
```

Replace the two calls: `await recordUsage(job, result.usage);` and `await recordUsage(job, err.usage).catch(…)`.

In `apps/api/src/runs/repo.ts`, replace `recordUsage`:

```ts
    // Attributes usage to the playlist's owner at write time, so a guest
    // claimed while its run was in flight doesn't break the FK.
    async recordUsage(args: {
      runId: string;
      usage: LlmUsage;
      costMicros: number;
      kind: "guest" | "user" | "scheduled";
    }): Promise<void> {
      await db.insert(llmUsage).values({
        userId: sql`(select ${playlists.userId} from ${generationRuns}
          join ${playlists} on ${playlists.id} = ${generationRuns.playlistId}
          where ${generationRuns.id} = ${args.runId})`,
        model: args.usage.model,
        inputTokens: args.usage.inputTokens,
        outputTokens: args.usage.outputTokens,
        costMicros: args.costMicros,
        kind: args.kind,
      });
    },
```

Delete `createGuest`, `findUser` and `touchUser` from the run repo. Remove `users` from its `@tunelynk/db` import if it is now unused.

- [ ] **Step 4: Update the repo integration tests**

In `apps/api/src/runs/repo.integration.test.ts`:

- Add a helper next to `newRun` and use it wherever `repo.createGuest()` was called:
  ```ts
  const newGuest = async () => {
    const [row] = await handle.db
      .insert(users)
      .values({ isGuest: true })
      .returning({ id: users.id });
    if (!row) throw new Error("no guest");
    return row.id;
  };
  ```
- Replace `expect(await repo.findUser(userId)).toEqual({ id: userId });` with:
  ```ts
  const [owner] = await handle.db
    .select({ userId: playlists.userId })
    .from(playlists)
    .where(eq(playlists.id, playlistId));
  expect(owner?.userId).toBe(userId);
  ```
  (import `playlists` from `@tunelynk/db` if it isn't already imported.)
- Delete the test "touches last_seen_at at most once a minute" (it moved to `auth/sessions.integration.test.ts`).
- Change "sums only today's usage" to record by run:
  ```ts
  it("sums only today's usage", async () => {
    const before = await repo.todaysCostMicros();
    const { userId, runId } = await newRun();
    await repo.recordUsage({ runId, usage, costMicros: 1100, kind: "guest" });
    await handle.db.insert(llmUsage).values({
      userId,
      model: "claude-haiku-4-5",
      inputTokens: 1,
      outputTokens: 1,
      costMicros: 999_999,
      kind: "guest",
      createdAt: new Date(Date.now() - 2 * 86_400_000),
    });
    expect(await repo.todaysCostMicros()).toBe(before + 1100);
  });
  ```
- Add:
  ```ts
  it("records usage against the playlist's current owner", async () => {
    const { runId, playlistId } = await newRun();
    const owner = await newGuest();
    await handle.db
      .update(playlists)
      .set({ userId: owner })
      .where(eq(playlists.id, playlistId));
    await repo.recordUsage({ runId, usage, costMicros: 5, kind: "guest" });
    const [row] = await handle.db
      .select({ u: llmUsage.userId })
      .from(llmUsage)
      .where(eq(llmUsage.costMicros, 5));
    expect(row?.u).toBe(owner);
  });
  ```

- [ ] **Step 5: Rewrite the runs route tests for sessions (failing)**

In `apps/api/src/runs/routes.integration.test.ts`:

1. Imports: add `import { createSessionRepo } from "../auth/sessions";` and `import { finishSignIn } from "../auth/signIn";`.
2. Replace `cookieFrom`:
   ```ts
   const cookieFrom = (res: Response) =>
     res.headers
       .getSetCookie()
       .filter((c) => c.startsWith("tl_session="))
       .at(-1)
       ?.split(";")[0] ?? "";
   ```
3. In `build()`, move `sessionSecret`/`secureCookies` out of `runs` into `auth`:
   ```ts
   createApp({
     db: handle.db,
     auth: {
       sessions: createSessionRepo(handle.db),
       sessionSecret: SECRET,
       get secureCookies() {
         return secureCookies;
       },
     },
     runs: {
       repo,
       executor: { start: (job: RunJob) => { const p = real.start(job); pending.push(p); return p; } },
       dailyBudgetMicros: 2_000_000,
       get reservePerRunMicros() {
         return reservePerRunMicros;
       },
       model: "claude-haiku-4-5",
     },
   });
   ```
4. In the first test, replace the cookie assertions with:
   ```ts
   const setCookie = res.headers.getSetCookie().join("\n");
   expect(setCookie).toMatch(/^tl_session=[A-Za-z0-9_-]{43};/);
   expect(setCookie).toMatch(/HttpOnly/);
   expect(setCookie).toMatch(/SameSite=Lax/);
   expect(setCookie).toMatch(/Max-Age=2592000/);
   expect(setCookie).not.toMatch(/Secure/);
   ```
5. In "reuses the guest across runs with the same cookie", the reuse assertion stays `expect(second.headers.get("set-cookie")).toBe(null);`.
6. In "creates a new guest for a tampered cookie" and "creates a new guest when the cookie's user no longer exists", change `/^tl_guest=/` to `/tl_session=[A-Za-z0-9_-]{43};/` and match against `second.headers.getSetCookie().join("\n")`.
7. Add these tests at the end of the `describe`:
   ```ts
   it("keeps a legacy tl_guest user across the upgrade", async () => {
     const [guest] = await handle.db
       .insert(users)
       .values({ isGuest: true })
       .returning({ id: users.id });
     const legacy = (
       await generateSignedCookie("tl_guest", guest?.id ?? "", SECRET)
     ).split(";")[0];
     const res = await post({ prompt: "p" }, legacy);
     expect(res.status).toBe(202);
     await Promise.all(pending);
     expect(await count(users)).toBe(1);
     const [owner] = await handle.db.select({ u: playlists.userId }).from(playlists);
     expect(owner?.u).toBe(guest?.id);
   });

   it("runs as the signed-in user and records user usage", async () => {
     const user = await finishSignIn(handle.db, {
       identity: { method: "email", subject: "a@b.co" },
       guestUserIds: [],
     });
     const res = await post({ prompt: "p" }, `tl_session=${user.token}`);
     expect(res.status).toBe(202);
     expect(res.headers.getSetCookie()).toEqual([]);
     await Promise.all(pending);
     expect(await count(users)).toBe(1);
     const [owner] = await handle.db.select({ u: playlists.userId }).from(playlists);
     expect(owner?.u).toBe(user.userId);
     const [spent] = await handle.db
       .select({ u: llmUsage.userId, k: llmUsage.kind })
       .from(llmUsage);
     expect(spent).toEqual({ u: user.userId, k: "user" });
   });

   it("credits usage to the account when the guest is claimed mid-run", async () => {
     let release: (r: GenerateResult) => void = () => {};
     let started: () => void = () => {};
     const engineStarted = new Promise<void>((r) => (started = r));
     engine = () =>
       new Promise((resolve) => {
         release = resolve;
         started();
       });
     const res = await post({ prompt: "p" });
     const guestToken = cookieFrom(res).slice("tl_session=".length);
     await engineStarted;
     const guest = await createSessionRepo(handle.db).resolve(guestToken);
     const account = await finishSignIn(handle.db, {
       identity: { method: "email", subject: "a@b.co" },
       guestUserIds: [guest?.userId],
       currentSessionId: guest?.sessionId,
     });
     release(okResult);
     await Promise.all(pending);
     const [spent] = await handle.db
       .select({ u: llmUsage.userId, k: llmUsage.kind })
       .from(llmUsage);
     expect(spent).toEqual({ u: account.userId, k: "guest" });
   });
   ```
   Add `import { generateSignedCookie } from "hono/cookie";` at the top.

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm --filter @tunelynk/api test:integration`
Expected: FAIL. The first test sees `tl_guest=` instead of `tl_session=`, and "runs as the signed-in user" sees a new guest and `kind: "guest"`.

- [ ] **Step 7: Switch the runs routes to the session**

Replace the top of `apps/api/src/runs/routes.ts` through `ensureGuest` with:

```ts
import {
  type ApiError,
  CreateRunRequest,
  type CreateRunResponse,
  type RunResponse,
} from "@tunelynk/shared";
import { Hono } from "hono";
import { type AuthDeps, type AuthEnv, ensureUser } from "../auth/middleware";
import type { RunJob } from "./executor";
import type { RunRepo } from "./repo";

export const GUEST_LENGTH = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RunsDeps = {
  repo: RunRepo;
  executor: { start(job: RunJob): Promise<void> };
  dailyBudgetMicros: number;
  reservePerRunMicros: number;
  model: string;
};
```

Change the function signature and its body:

```ts
export function runsRoutes(deps: RunsDeps, auth: AuthDeps) {
  return new Hono<AuthEnv>()
    .post("/", async (c) => {
      // …body parse and budget check unchanged…

      const user = await ensureUser(c, auth);
      const run = await deps.repo.createRun({
        userId: user.id,
        prompt,
        length: GUEST_LENGTH,
        model: deps.model,
      });
      // …409 branch unchanged…

      // Fire and forget: the client polls GET /api/runs/:id.
      void deps.executor.start({
        runId: run.runId,
        kind: user.isGuest ? "guest" : "user",
        prompt,
        length: GUEST_LENGTH,
      });
      // …202 response unchanged…
    })
    .get("/:id", async (c) => {
      const id = c.req.param("id");
      const run = UUID.test(id) ? await deps.repo.getRun(id) : undefined;
      if (!run) return c.json({ error: "not_found" } satisfies ApiError, 404);
      return c.json(run satisfies RunResponse, 200);
    });
}
```

(`GUEST_COOKIE` and `GUEST_COOKIE_MAX_AGE` are deleted. The middleware now touches `last_seen_at` on every `/api` request.)

In `apps/api/src/app.ts`: `.route("/runs", runsRoutes(runs, auth))`.

In `apps/api/src/index.ts`, delete `sessionSecret` and `secureCookies` from the `runs:` object; they live under `auth:` now.

Search for leftovers: `grep -rn "GUEST_COOKIE\|createGuest\|findUser\|userId:" apps/api/src/runs`. The only `userId` left should be `createRun`'s argument and test fixtures.

- [ ] **Step 8: Run everything to verify it passes**

Run: `pnpm --filter @tunelynk/api typecheck && pnpm --filter @tunelynk/api test && pnpm --filter @tunelynk/api test:integration`
Expected: PASS.

- [ ] **Step 9: Docs**

In `docs/deploy.md` under **Operations**, add after the "Stuck runs" bullet:

```markdown
- **Sessions:** guests and signed-in users carry an httpOnly `tl_session` cookie; the database stores only its SHA-256 (`sessions`). Old `tl_guest` cookies from before #11 are upgraded to a session on the next request. `SESSION_SECRET` still signs those legacy cookies (and, from #11 slice C, the short-lived Apple sign-in state cookie), so keep it unchanged.
```

- [ ] **Step 10: Commit**

```bash
pnpm --filter @tunelynk/api exec biome check --write .
git add apps/api/src docs/deploy.md
git commit -m "feat(api): runs use the session; usage follows the playlist owner

POST /api/runs creates a guest session instead of tl_guest, reuses a
signed-in user, and records usage as 'user' for them. Usage is
attributed to the run's playlist owner at write time, so claiming a
guest mid-run credits the account.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Whole-slice verification

**Files:** none new.

- [ ] **Step 1: Full check**

Run: `pnpm check && pnpm build`
Expected: typecheck, lint, unit and integration tests pass in every package; the build succeeds.

- [ ] **Step 2: Local smoke against the real server**

Start Postgres (`pnpm db:up`), apply migrations (`pnpm db:migrate`), then run `pnpm --filter @tunelynk/api dev` in the background. Then:

```bash
curl -s -c /tmp/tl.jar -b /tmp/tl.jar localhost:3000/api/me            # {"user":null}
curl -s -c /tmp/tl.jar -b /tmp/tl.jar -H 'content-type: application/json' \
  -d '{"prompt":"rainy sunday jazz"}' localhost:3000/api/runs           # 202 {runId, playlistId}
grep tl_session /tmp/tl.jar                                              # cookie present, HttpOnly
curl -s -b /tmp/tl.jar localhost:3000/api/me                             # {"user":{"id":…,"isGuest":true,"label":null}}
curl -s -b /tmp/tl.jar localhost:3000/api/runs/<runId>                   # reaches "draft"
curl -s -i -b /tmp/tl.jar -X POST localhost:3000/api/auth/signout | head -1   # 204
curl -s -b /tmp/tl.jar localhost:3000/api/me                             # {"user":null}
```

Use the scratchpad directory instead of `/tmp` for the cookie jar when running as an agent. Then open the web app (`pnpm dev`), generate once, and confirm in DevTools that `tl_session` is set and that no `tl_guest` cookie is set.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/11-slice-a-sessions
gh pr create --base main --title "#11 slice A: sessions for guests and users" --body "…summary, test plan, 'Part of #11'…

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

No new env vars in this slice, so no Dokploy change is needed before merge. After the deploy, verify on production that a fresh `POST /api/runs` sets `tl_session`; that response comes only from the new code.
