# Slice B: Magic Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can request a sign-in link by email and open it to get a signed-in session. Any guest drafts from the requesting browser and the verifying browser move to the account.

**Architecture:**
- `apps/api/src/auth/mailer.ts`: a `Mailer` with two adapters. `console` logs the link; `resend` sends one `fetch` to Resend's HTTPS API.
- `apps/api/src/auth/loginTokens.ts`: a repo that issues tokens under a per-email advisory lock (enforcing 3 per 15 min), consumes them atomically, and deletes them.
- `apps/api/src/auth/email.ts`: Hono routes `POST /api/auth/email/start` and `/verify`. Verify calls slice A's `finishSignIn` and sets the session cookie.
- Env gains `APP_URL` and `EMAIL_PROVIDER` / `RESEND_API_KEY` / `EMAIL_FROM`. These parse into one `EMAIL` config object.

**Tech Stack:** Hono 4.13, Drizzle 0.45 (postgres-js), zod 4, Vitest 5, `fetch` (Resend REST API `POST https://api.resend.com/emails`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-03-accounts-design.md`: sections "Magic link (slice B)", "Env additions", "Error handling", "Testing → B". Slice A plan: `docs/superpowers/plans/2026-10-03-slice-a-sessions.md` (defines `finishSignIn`, `setSessionCookie`, `AuthEnv`, `requireJson`).

## Global Constraints

- Branch `feat/11-slice-b-magic-link`, created from `feat/11-slice-a-sessions` (PR #30). The PR's base is `feat/11-slice-a-sessions` (a stacked PR).
- Node 22.23.3. Local Postgres up (`pnpm db:up`). Integration tests make throwaway databases.
- No migration: `login_tokens` already exists (slice A, `0003_auth_schema`).
- Email is normalized as trimmed and lowercased, then validated with zod `z.email()`, max 254 chars. The identity is `{ method: "email", subject: <normalized email> }`.
- Login token: 32 random bytes as base64url (`newToken`), stored as `hashToken(token)`. It expires **15 minutes** after creation and is single-use (`used_at`).
- Rate limit: at most **3** tokens per normalized email created in the last **15 minutes**, otherwise `429 { "error": "too_many_requests" }`. Enforced inside one transaction holding `pg_advisory_xact_lock(hashtext('login:' || email))`.
- Link: `${APP_URL}/signin/verify#t=<token>`. `APP_URL` has no trailing slash.
- Email content:
  - Subject: exactly `Your Tunelynk sign-in link`.
  - Body includes the link and exactly `This link expires in 15 minutes. If you didn't ask for it, ignore this email.`
- `POST /api/auth/email/start`, body `{ email, returnTo? }`:
  - Bad body or email → `400 { "error": "invalid_email" }`.
  - Success → `202 {}`, whether or not an account exists.
  - Send failure → token row deleted, then `502 { "error": "email_failed" }`.
- `POST /api/auth/email/verify`, body `{ token }`:
  - Miss (unknown, used, expired or malformed) → `400 { "error": "invalid_or_expired" }`.
  - Hit → `200 { "returnTo": <stored returnTo or "/"> }` plus a `tl_session` cookie.
  - Guests claimed: the token's `guest_user_id` and the verifying request's guest.
- Both endpoints require `content-type: application/json`; otherwise `415 json_required` (slice A's `requireJson`).
- `returnTo` is stored only if `safeReturnTo` accepts it.
- Env:
  - `APP_URL`: required, http(s) URL, trailing slashes stripped.
  - `EMAIL_PROVIDER`: `console` (default) or `resend`.
  - `RESEND_API_KEY` and `EMAIL_FROM`: required when `resend`.
- Format with `pnpm --filter <pkg> exec biome check --write .` before each commit. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Several "send link" clicks at once for one email.** Exactly 3 should succeed and the rest get 429; concurrent requests must not slip past the count. Test in Task 3.
2. **A double-clicked or doubly-opened link.** Two verifies of the same token race; exactly one signs in and the other gets `invalid_or_expired`. Test in Task 4.
3. **The same address typed differently** (`" A@B.Co "` vs `a@b.co`). Both should land on the same account. Test in Task 4.
4. **Verifying while already signed in as another user.** The session switches to the email's account, the old session dies, and the old user's playlists stay theirs. Test in Task 4.
5. **The requesting guest is gone by the time the link is opened** (claimed elsewhere or deleted, so `guest_user_id` became null). Verify still signs in. Test in Task 4.

---

### Task 1: Contracts and env

**Files:**
- Modify: `packages/shared/src/auth.ts`, `packages/shared/src/runs.ts` (ApiError codes), `apps/web/src/hooks/useCreateRun.ts` (`CREATE_ERRORS` must cover every ApiError code), `apps/api/src/env.ts`, `.env.example`
- Create: `apps/api/src/auth/mailer.ts` (only the `EmailConfig` type in this task)
- Test: `packages/shared/src/auth.test.ts`, `apps/api/src/env.test.ts`

**Interfaces:**
- Produces, from `@tunelynk/shared`:
  - `EmailStartRequest`: `{ email: string; returnTo?: string }`. The email is trimmed, lowercased and validated.
  - `EmailVerifyRequest`: `{ token: string }`, 1–200 chars.
  - `EmailVerifyResponse`: `{ returnTo: string }`.
  - `ApiError.error` gains `"invalid_email" | "too_many_requests" | "email_failed" | "invalid_or_expired"`.
- Produces from `apps/api/src/auth/mailer.ts`: `export type EmailConfig = { provider: "console" } | { provider: "resend"; apiKey: string; from: string };`
- Produces from `env.ts`: `Env` has `APP_URL: string` and `EMAIL: EmailConfig`, and no longer has `EMAIL_PROVIDER`, `RESEND_API_KEY` or `EMAIL_FROM`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/auth.test.ts`:

```ts
import {
  EmailStartRequest,
  EmailVerifyRequest,
  EmailVerifyResponse,
} from "./auth";

describe("EmailStartRequest", () => {
  it("trims and lowercases the email", () => {
    expect(EmailStartRequest.parse({ email: "  A@B.Co " })).toEqual({
      email: "a@b.co",
    });
  });

  it("keeps an optional returnTo", () => {
    expect(
      EmailStartRequest.parse({ email: "a@b.co", returnTo: "/x" }).returnTo,
    ).toBe("/x");
  });

  it.each([
    ["missing", {}],
    ["not an email", { email: "nope" }],
    ["empty", { email: "   " }],
    ["too long", { email: `${"a".repeat(250)}@b.co` }],
    ["not a string", { email: 42 }],
  ])("rejects %s", (_label, body) => {
    expect(EmailStartRequest.safeParse(body).success).toBe(false);
  });
});

describe("EmailVerifyRequest", () => {
  it("accepts a token", () => {
    expect(EmailVerifyRequest.parse({ token: "abc" })).toEqual({
      token: "abc",
    });
  });

  it.each([{}, { token: "" }, { token: "x".repeat(201) }])(
    "rejects %o",
    (body) => {
      expect(EmailVerifyRequest.safeParse(body).success).toBe(false);
    },
  );
});

describe("EmailVerifyResponse", () => {
  it("parses returnTo", () => {
    expect(EmailVerifyResponse.parse({ returnTo: "/" })).toEqual({
      returnTo: "/",
    });
  });
});
```

(Merge the new import into the file's existing `import { MeResponse } from "./auth";` line.)

In `apps/api/src/env.test.ts`, add `APP_URL: "http://localhost:5173/"` to `base`. In the first test's expected object add `APP_URL: "http://localhost:5173",` (after `PORT`) and `EMAIL: { provider: "console" },` (at the end). Then add inside `describe("parseEnv")`:

```ts
  it("requires APP_URL", () => {
    const { APP_URL: _omit, ...rest } = base;
    expect(() => parseEnv(rest)).toThrow(/APP_URL/);
  });

  it("rejects a non-http APP_URL", () => {
    expect(() => parseEnv({ ...base, APP_URL: "ftp://x.co" })).toThrow(
      /APP_URL/,
    );
  });

  it("strips trailing slashes from APP_URL", () => {
    expect(
      parseEnv({ ...base, APP_URL: "https://tunelynk.bytmoor.com//" }).APP_URL,
    ).toBe("https://tunelynk.bytmoor.com");
  });

  it("configures Resend when EMAIL_PROVIDER=resend", () => {
    const env = parseEnv({
      ...base,
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_123",
      EMAIL_FROM: "Tunelynk <login@bytmoor.com>",
    });
    expect(env.EMAIL).toEqual({
      provider: "resend",
      apiKey: "re_123",
      from: "Tunelynk <login@bytmoor.com>",
    });
    expect(env).not.toHaveProperty("RESEND_API_KEY");
  });

  it.each(["RESEND_API_KEY", "EMAIL_FROM"])(
    "requires %s when EMAIL_PROVIDER=resend",
    (name) => {
      const env = {
        ...base,
        EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: "re_123",
        EMAIL_FROM: "Tunelynk <login@bytmoor.com>",
        [name]: "",
      };
      expect(() => parseEnv(env)).toThrow(new RegExp(name));
    },
  );
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @tunelynk/shared test; pnpm --filter @tunelynk/api exec vitest run src/env.test.ts`
Expected: FAIL. The shared test fails on import (`EmailStartRequest` is undefined, so `.parse` throws a TypeError). The env tests fail on the missing `APP_URL` and `EMAIL` keys and the unthrown errors.

- [ ] **Step 3: Implement**

Append to `packages/shared/src/auth.ts`:

```ts
export const EMAIL_MAX_LENGTH = 254;

// Normalized before validation so " A@B.Co " and "a@b.co" are one account.
export const EmailAddress = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(EMAIL_MAX_LENGTH));

export const EmailStartRequest = z.object({
  email: EmailAddress,
  returnTo: z.string().optional(),
});
export type EmailStartRequest = z.infer<typeof EmailStartRequest>;

export const EmailVerifyRequest = z.object({
  token: z.string().min(1).max(200),
});
export type EmailVerifyRequest = z.infer<typeof EmailVerifyRequest>;

export const EmailVerifyResponse = z.object({ returnTo: z.string() });
export type EmailVerifyResponse = z.infer<typeof EmailVerifyResponse>;
```

In `packages/shared/src/runs.ts`, extend the `ApiError` enum after `"session_expired",`:

```ts
    "invalid_email",
    "too_many_requests",
    "email_failed",
    "invalid_or_expired",
```

In `apps/web/src/hooks/useCreateRun.ts`, add to `CREATE_ERRORS` (create-run never returns these; the map must cover every code):

```ts
  invalid_email: "Something went wrong. Try again.",
  too_many_requests: "Something went wrong. Try again.",
  email_failed: "Something went wrong. Try again.",
  invalid_or_expired: "Something went wrong. Try again.",
```

Create `apps/api/src/auth/mailer.ts` with only:

```ts
export type EmailConfig =
  | { provider: "console" }
  | { provider: "resend"; apiKey: string; from: string };
```

In `apps/api/src/env.ts`:
- Add `import type { EmailConfig } from "./auth/mailer";`.
- Add to the `z.object({...})` after `PORT`:
  ```ts
    // Public origin for links and OAuth redirects, no trailing slash.
    APP_URL: z
      .url({ protocol: /^https?$/ })
      .transform((url) => url.replace(/\/+$/, "")),
  ```
- Add after `LLM_DAILY_BUDGET_USD`:
  ```ts
    EMAIL_PROVIDER: z.enum(["console", "resend"]).default("console"),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
  ```
- In `.transform((env, ctx) => { ... })`, replace the final destructure and return with:
  ```ts
    let email: EmailConfig = { provider: "console" };
    if (env.EMAIL_PROVIDER === "resend") {
      const { RESEND_API_KEY: resendKey, EMAIL_FROM: from } = env;
      if (!resendKey || !from) {
        for (const [name, value] of [
          ["RESEND_API_KEY", resendKey],
          ["EMAIL_FROM", from],
        ] as const) {
          if (!value) {
            ctx.addIssue({
              code: "custom",
              path: [name],
              message: "required when EMAIL_PROVIDER=resend",
            });
          }
        }
        return z.NEVER;
      }
      email = { provider: "resend", apiKey: resendKey, from };
    }
    const {
      ANTHROPIC_API_KEY: _anthropic,
      OPENAI_API_KEY: _openai,
      EMAIL_PROVIDER: _provider,
      RESEND_API_KEY: _resend,
      EMAIL_FROM: _from,
      ...rest
    } = env;
    return {
      ...rest,
      LLM_MODEL_GUEST: model,
      LLM_API_KEY: apiKey,
      EMAIL: email,
    };
  ```
  `apiKey` in the final return is the existing LLM key variable; the Resend key is named `resendKey` so it does not shadow it.

In `.env.example`, add after `PORT=3000`:

```
# Public origin used in sign-in links and the Apple redirect URI (no trailing slash).
# Local dev: the Vite server, which proxies /api.
APP_URL=http://localhost:5173
```

and at the end:

```
# Magic-link email. console logs links (dev); resend sends them.
EMAIL_PROVIDER=console
RESEND_API_KEY=
EMAIL_FROM=Tunelynk <login@bytmoor.com>
```

Also add `APP_URL=http://localhost:5173` to the local, gitignored `.env`, after `PORT=3000`; otherwise the dev server stops booting. Change nothing else in `.env`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @tunelynk/shared test && pnpm --filter @tunelynk/api exec vitest run src/env.test.ts && pnpm --filter @tunelynk/api typecheck && pnpm --filter @tunelynk/web typecheck`
Expected: PASS. The api typecheck may fail in `index.ts` only if something reads the removed `EMAIL_*` fields; nothing does yet.

- [ ] **Step 5: Commit**

```bash
pnpm --filter @tunelynk/shared exec biome check --write . && pnpm --filter @tunelynk/api exec biome check --write . && pnpm --filter @tunelynk/web exec biome check --write .
git add packages/shared/src apps/api/src apps/web/src .env.example
git commit -m "feat: magic-link contracts and APP_URL/EMAIL env

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Mailer adapters

**Files:**
- Modify: `apps/api/src/auth/mailer.ts`
- Test: `apps/api/src/auth/mailer.test.ts`

**Interfaces:**
- Consumes: `EmailConfig` (Task 1).
- Produces:
  ```ts
  export type Mailer = { sendLoginLink(args: { to: string; url: string }): Promise<void> };
  export function loginEmail(url: string): { subject: string; text: string; html: string };
  export function createConsoleMailer(logger?: Pick<Console, "log">): Mailer;
  export function createResendMailer(args: { apiKey: string; from: string; fetch?: typeof fetch }): Mailer;
  export function createMailer(config: EmailConfig, fetchImpl?: typeof fetch): Mailer;
  ```

- [ ] **Step 1: Write the failing test**

`apps/api/src/auth/mailer.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  createConsoleMailer,
  createMailer,
  createResendMailer,
  loginEmail,
} from "./mailer";

const url = "https://tunelynk.bytmoor.com/signin/verify#t=abc_DEF-123";
const EXPIRY =
  "This link expires in 15 minutes. If you didn't ask for it, ignore this email.";

describe("loginEmail", () => {
  it("has the subject, the link, and the expiry line", () => {
    const mail = loginEmail(url);
    expect(mail.subject).toBe("Your Tunelynk sign-in link");
    expect(mail.text).toContain(url);
    expect(mail.text).toContain(EXPIRY);
    expect(mail.html).toContain(`href="${url}"`);
    expect(mail.html).toContain(EXPIRY.replace("'", "&#39;"));
  });

  it("escapes HTML in the link", () => {
    expect(loginEmail('https://x.co/"><script>').html).not.toContain(
      "<script>",
    );
  });
});

describe("createResendMailer", () => {
  it("posts the email to Resend with the API key", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    await createResendMailer({
      apiKey: "re_123",
      from: "Tunelynk <login@bytmoor.com>",
      fetch,
    }).sendLoginLink({ to: "a@b.co", url });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(endpoint).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      authorization: "Bearer re_123",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      from: "Tunelynk <login@bytmoor.com>",
      to: "a@b.co",
      ...loginEmail(url),
    });
  });

  it("throws on a non-2xx response without leaking the key", async () => {
    const fetch = vi.fn(
      async () => new Response('{"message":"domain not verified"}', { status: 403 }),
    );
    const send = createResendMailer({ apiKey: "re_secret", from: "x <a@b.co>", fetch })
      .sendLoginLink({ to: "a@b.co", url });
    await expect(send).rejects.toThrow(/403/);
    await expect(send).rejects.not.toThrow(/re_secret/);
  });
});

describe("createConsoleMailer", () => {
  it("logs the recipient and the link", async () => {
    const logger = { log: vi.fn() };
    await createConsoleMailer(logger).sendLoginLink({ to: "a@b.co", url });
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("a@b.co"));
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining(url));
  });
});

describe("createMailer", () => {
  it("picks the adapter from the config", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    await createMailer(
      { provider: "resend", apiKey: "k", from: "x <a@b.co>" },
      fetch,
    ).sendLoginLink({ to: "a@b.co", url });
    expect(fetch).toHaveBeenCalled();

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createMailer({ provider: "console" }).sendLoginLink({ to: "a@b.co", url });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tunelynk/api exec vitest run src/auth/mailer.test.ts`
Expected: FAIL. `loginEmail`, `createResendMailer` and the other functions are not exported (TypeError: not a function).

- [ ] **Step 3: Implement**

Replace `apps/api/src/auth/mailer.ts` with:

```ts
export type EmailConfig =
  | { provider: "console" }
  | { provider: "resend"; apiKey: string; from: string };

export type Mailer = {
  sendLoginLink(args: { to: string; url: string }): Promise<void>;
};

const SUBJECT = "Your Tunelynk sign-in link";
const EXPIRY =
  "This link expires in 15 minutes. If you didn't ask for it, ignore this email.";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export function loginEmail(url: string) {
  return {
    subject: SUBJECT,
    text: `Sign in to Tunelynk:\n\n${url}\n\n${EXPIRY}\n`,
    html: `<p>Sign in to Tunelynk:</p><p><a href="${escapeHtml(url)}">Sign in</a></p><p>${escapeHtml(EXPIRY)}</p>`,
  };
}

// Dev and tests: the link is printed instead of sent.
export function createConsoleMailer(
  logger: Pick<Console, "log"> = console,
): Mailer {
  return {
    async sendLoginLink({ to, url }) {
      logger.log(`[mail] sign-in link for ${to}: ${url}`);
    },
  };
}

export function createResendMailer({
  apiKey,
  from,
  fetch = globalThis.fetch,
}: {
  apiKey: string;
  from: string;
  fetch?: typeof globalThis.fetch;
}): Mailer {
  return {
    async sendLoginLink({ to, url }) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ from, to, ...loginEmail(url) }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Resend responded ${res.status}: ${detail.slice(0, 200)}`);
      }
    },
  };
}

export function createMailer(
  config: EmailConfig,
  fetchImpl?: typeof globalThis.fetch,
): Mailer {
  return config.provider === "resend"
    ? createResendMailer({ apiKey: config.apiKey, from: config.from, fetch: fetchImpl })
    : createConsoleMailer();
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @tunelynk/api exec vitest run src/auth/mailer.test.ts && pnpm --filter @tunelynk/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm --filter @tunelynk/api exec biome check --write .
git add apps/api/src/auth
git commit -m "feat(api): mailer with console and Resend adapters

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Login token repo

**Files:**
- Create: `apps/api/src/auth/loginTokens.ts`
- Test: `apps/api/src/auth/loginTokens.integration.test.ts`

**Interfaces:**
- Consumes: `newToken`, `hashToken` (slice A `auth/tokens.ts`); `loginTokens` table (slice A).
- Produces:
  ```ts
  export const LOGIN_TOKEN_TTL_MS: number;      // 15 min
  export const LOGIN_LINK_LIMIT = 3;
  export const LOGIN_LINK_WINDOW_MS: number;    // 15 min
  export type ConsumedToken = { email: string; returnTo: string | null; guestUserId: string | null };
  export function createLoginTokenRepo(db: Db): {
    issue(args: { email: string; returnTo?: string; guestUserId?: string | null }): Promise<{ id: string; token: string } | undefined>; // undefined = rate limited
    remove(id: string): Promise<void>;
    consume(token: string): Promise<ConsumedToken | undefined>;
  };
  export type LoginTokenRepo = ReturnType<typeof createLoginTokenRepo>;
  ```

- [ ] **Step 1: Write the failing test**

`apps/api/src/auth/loginTokens.integration.test.ts`:

```ts
import { loginTokens, users } from "@tunelynk/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test/db";
import { createLoginTokenRepo, type LoginTokenRepo } from "./loginTokens";
import { hashToken } from "./tokens";

describe.skipIf(!process.env.DATABASE_URL)("login token repo", () => {
  let handle: Awaited<ReturnType<typeof createTestDatabase>>;
  let repo: LoginTokenRepo;

  beforeAll(async () => {
    handle = await createTestDatabase();
    repo = createLoginTokenRepo(handle.db);
  });
  afterAll(() => handle.drop());
  beforeEach(async () => {
    await handle.db.execute(sql`truncate login_tokens, users cascade`);
  });

  const issue = (email = "a@b.co") => repo.issue({ email });

  it("stores only the hash, with a 15-minute expiry", async () => {
    const issued = await repo.issue({ email: "a@b.co", returnTo: "/x" });
    expect(issued?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = await handle.db.select().from(loginTokens);
    expect(row?.tokenHash).toBe(hashToken(issued?.token ?? ""));
    expect(row?.returnTo).toBe("/x");
    const ttl = (row?.expiresAt.getTime() ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
  });

  it("consumes a token exactly once and returns its data", async () => {
    const [guest] = await handle.db
      .insert(users)
      .values({ isGuest: true })
      .returning({ id: users.id });
    const issued = await repo.issue({
      email: "a@b.co",
      returnTo: "/x",
      guestUserId: guest?.id,
    });
    expect(await repo.consume(issued?.token ?? "")).toEqual({
      email: "a@b.co",
      returnTo: "/x",
      guestUserId: guest?.id,
    });
    expect(await repo.consume(issued?.token ?? "")).toBeUndefined();
  });

  it("lets only one of two concurrent consumes win", async () => {
    const issued = await issue();
    const results = await Promise.all([
      repo.consume(issued?.token ?? ""),
      repo.consume(issued?.token ?? ""),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("does not consume expired or unknown tokens", async () => {
    const issued = await issue();
    await handle.db
      .update(loginTokens)
      .set({ expiresAt: sql`now() - interval '1 second'` });
    expect(await repo.consume(issued?.token ?? "")).toBeUndefined();
    expect(await repo.consume("unknown")).toBeUndefined();
  });

  it("allows 3 links per email per 15 minutes", async () => {
    expect(await issue()).toBeDefined();
    expect(await issue()).toBeDefined();
    expect(await issue()).toBeDefined();
    expect(await issue()).toBeUndefined();
    expect(await issue("other@b.co")).toBeDefined();
  });

  it("does not count links older than the window", async () => {
    await issue();
    await issue();
    await issue();
    await handle.db
      .update(loginTokens)
      .set({ createdAt: sql`now() - interval '16 minutes'` });
    expect(await issue()).toBeDefined();
  });

  it("holds the limit under concurrent requests", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => issue()));
    expect(results.filter(Boolean)).toHaveLength(3);
  });

  it("removes a token, freeing its slot", async () => {
    const first = await issue();
    await issue();
    await issue();
    await repo.remove(first?.id ?? "");
    expect(await issue()).toBeDefined();
  });

  it("nulls guest_user_id when the guest is deleted", async () => {
    const [guest] = await handle.db
      .insert(users)
      .values({ isGuest: true })
      .returning({ id: users.id });
    const issued = await repo.issue({ email: "a@b.co", guestUserId: guest?.id });
    await handle.db.delete(users).where(eq(users.id, guest?.id ?? ""));
    expect((await repo.consume(issued?.token ?? ""))?.guestUserId).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tunelynk/api exec vitest run src/auth/loginTokens.integration.test.ts`
Expected: FAIL. `./loginTokens` cannot be resolved.

- [ ] **Step 3: Implement `apps/api/src/auth/loginTokens.ts`**

```ts
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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @tunelynk/api exec vitest run src/auth/loginTokens.integration.test.ts && pnpm --filter @tunelynk/api typecheck`
Expected: PASS (9 tests). Run it 3 times to confirm the concurrency tests are stable.

- [ ] **Step 5: Commit**

```bash
pnpm --filter @tunelynk/api exec biome check --write .
git add apps/api/src/auth
git commit -m "feat(api): login token repo with per-email rate limit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Email sign-in routes and wiring

**Files:**
- Create: `apps/api/src/auth/email.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/index.ts`, `apps/api/src/app.test.ts`, `apps/api/src/app.web.test.ts`, `apps/api/src/app.integration.test.ts`, `apps/api/src/auth/routes.integration.test.ts`, `apps/api/src/runs/routes.integration.test.ts` (each `createApp` call gains `email`), `docs/deploy.md`
- Test: `apps/api/src/auth/email.integration.test.ts`

**Interfaces:**
- Consumes:
  - From slice A: `finishSignIn(db, { identity, guestUserIds, currentSessionId })`, `setSessionCookie(c, token, secure)`, `AuthDeps`, `AuthEnv`, `requireJson`, `safeReturnTo`.
  - From Tasks 1–3: `EmailStartRequest`, `EmailVerifyRequest`, `EmailVerifyResponse`, `Mailer`, `LoginTokenRepo`.
- Produces:
  ```ts
  export type EmailDeps = { loginTokens: LoginTokenRepo; mailer: Mailer; appUrl: string; logger?: Pick<Console, "error"> };
  export function emailRoutes(deps: EmailDeps & { db: Db; auth: AuthDeps }): Hono<AuthEnv>;
  export const loginLink: (appUrl: string, token: string) => string;
  // app.ts
  export type AppDeps = { db: Db; webDir?: string; auth: AuthDeps; email: EmailDeps; runs: RunsDeps };
  ```

- [ ] **Step 1: Write the failing test**

`apps/api/src/auth/email.integration.test.ts`:

```ts
import { playlists, sessions, users } from "@tunelynk/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { RunsDeps } from "../runs/routes";
import { createTestDatabase } from "../test/db";
import { createLoginTokenRepo } from "./loginTokens";
import type { Mailer } from "./mailer";
import { createSessionRepo, type SessionRepo } from "./sessions";
import { finishSignIn } from "./signIn";

const SECRET = "test-secret-test-secret-test-secret!";
const APP_URL = "https://tunelynk.test";

describe.skipIf(!process.env.DATABASE_URL)("/api/auth/email", () => {
  let handle: Awaited<ReturnType<typeof createTestDatabase>>;
  let sessionRepo: SessionRepo;
  let app: ReturnType<typeof createApp>;
  let sent: { to: string; url: string }[];
  let mailFails: boolean;

  beforeAll(async () => {
    handle = await createTestDatabase();
    sessionRepo = createSessionRepo(handle.db);
    const mailer: Mailer = {
      async sendLoginLink(message) {
        if (mailFails) throw new Error("resend down");
        sent.push(message);
      },
    };
    app = createApp({
      db: handle.db,
      auth: { sessions: sessionRepo, sessionSecret: SECRET, secureCookies: false },
      email: {
        loginTokens: createLoginTokenRepo(handle.db),
        mailer,
        appUrl: APP_URL,
        logger: { error: () => {} },
      },
      runs: {} as RunsDeps,
    });
  });
  afterAll(() => handle.drop());
  beforeEach(async () => {
    await handle.db.execute(sql`truncate users, login_tokens cascade`);
    sent = [];
    mailFails = false;
  });

  const post = (path: string, body: unknown, cookie = "") =>
    app.request(`/api/auth/email/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  const start = (email: string, cookie = "", returnTo?: string) =>
    post("start", { email, returnTo }, cookie);
  const verify = (token: string, cookie = "") => post("verify", { token }, cookie);
  const lastToken = () => {
    const url = sent.at(-1)?.url ?? "";
    expect(url.startsWith(`${APP_URL}/signin/verify#t=`)).toBe(true);
    return url.slice(`${APP_URL}/signin/verify#t=`.length);
  };
  const sessionCookie = (res: Response) =>
    res.headers
      .getSetCookie()
      .filter((c) => c.startsWith("tl_session="))
      .at(-1)
      ?.split(";")[0] ?? "";
  const me = async (cookie: string) =>
    (await (await app.request("/api/me", { headers: { cookie } })).json()) as {
      user: { id: string; isGuest: boolean; label: string | null } | null;
    };
  const signIn = async (email: string, cookie = "") => {
    expect((await start(email, cookie)).status).toBe(202);
    const res = await verify(lastToken(), cookie);
    expect(res.status).toBe(200);
    return { res, cookie: sessionCookie(res) };
  };
  const guestWithPlaylist = async () => {
    const guest = await sessionRepo.createGuestSession();
    const [playlist] = await handle.db
      .insert(playlists)
      .values({ userId: guest.userId, name: "p", prompt: "p", length: 20 })
      .returning({ id: playlists.id });
    return { ...guest, cookie: `tl_session=${guest.token}`, playlistId: playlist?.id ?? "" };
  };
  const ownerOf = async (playlistId: string) =>
    (
      await handle.db
        .select({ u: playlists.userId })
        .from(playlists)
        .where(eq(playlists.id, playlistId))
    )[0]?.u;

  it("sends a link and signs in with it", async () => {
    const res = await start("a@b.co");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({});
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("a@b.co");
    expect(lastToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const verified = await verify(lastToken());
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({ returnTo: "/" });
    const cookie = sessionCookie(verified);
    expect((await me(cookie)).user).toMatchObject({
      isGuest: false,
      label: "a@b.co",
    });
  });

  it("normalizes the address so different spellings reach one account", async () => {
    const first = await signIn(" A@B.Co ");
    expect(sent[0]?.to).toBe("a@b.co");
    const second = await signIn("a@b.co");
    expect((await me(second.cookie)).user?.id).toBe(
      (await me(first.cookie)).user?.id,
    );
  });

  it("answers the same for new and existing addresses", async () => {
    await signIn("a@b.co");
    const existing = await start("a@b.co");
    const fresh = await start("new@b.co");
    expect([existing.status, await existing.json()]).toEqual([
      fresh.status,
      await fresh.json(),
    ]);
  });

  it.each([
    ["bad email", { email: "nope" }],
    ["missing email", {}],
  ])("rejects %s with 400 invalid_email and sends nothing", async (_l, body) => {
    const res = await post("start", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_email" });
    expect(sent).toEqual([]);
  });

  it("requires a JSON content type", async () => {
    const res = await app.request("/api/auth/email/start", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ email: "a@b.co" }),
    });
    expect(res.status).toBe(415);
  });

  it("returns to a safe returnTo and drops an unsafe one", async () => {
    await start("a@b.co", "", "/playlists/p/runs/r?keep=1");
    expect(await (await verify(lastToken())).json()).toEqual({
      returnTo: "/playlists/p/runs/r?keep=1",
    });
    await start("a@b.co", "", "//evil.com");
    expect(await (await verify(lastToken())).json()).toEqual({ returnTo: "/" });
  });

  it("rate-limits to 3 links per address", async () => {
    for (let i = 0; i < 3; i++) expect((await start("a@b.co")).status).toBe(202);
    const limited = await start("a@b.co");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "too_many_requests" });
    expect(sent).toHaveLength(3);
  });

  it("returns 502 and frees the slot when the email fails", async () => {
    mailFails = true;
    const res = await start("a@b.co");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "email_failed" });
    const [row] = await handle.db.execute<{ n: number }>(
      sql`select count(*)::int as n from login_tokens`,
    );
    expect(row?.n).toBe(0);
  });

  it.each([
    ["unknown", "not-a-real-token"],
    ["empty", ""],
  ])("rejects an %s token with 400 invalid_or_expired", async (_l, token) => {
    const res = await verify(token);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_or_expired" });
  });

  it("rejects a reused link", async () => {
    await start("a@b.co");
    const token = lastToken();
    expect((await verify(token)).status).toBe(200);
    expect((await verify(token)).status).toBe(400);
  });

  it("lets exactly one of two simultaneous verifies sign in", async () => {
    await start("a@b.co");
    const token = lastToken();
    const statuses = (await Promise.all([verify(token), verify(token)])).map(
      (r) => r.status,
    );
    expect(statuses.sort()).toEqual([200, 400]);
  });

  it("claims the requesting guest even when the link opens elsewhere", async () => {
    const guest = await guestWithPlaylist();
    await start("a@b.co", guest.cookie);
    // Opened in another cookie jar (e.g. a mail app's in-app browser).
    const res = await verify(lastToken());
    expect(res.status).toBe(200);
    const account = (await me(sessionCookie(res))).user;
    expect(await ownerOf(guest.playlistId)).toBe(account?.id);
    expect(await sessionRepo.resolve(guest.token)).toBeUndefined();
  });

  it("claims the verifying browser's guest", async () => {
    const guest = await guestWithPlaylist();
    await start("a@b.co");
    const res = await verify(lastToken(), guest.cookie);
    const account = (await me(sessionCookie(res))).user;
    expect(await ownerOf(guest.playlistId)).toBe(account?.id);
  });

  it("still signs in when the requesting guest is gone", async () => {
    const guest = await guestWithPlaylist();
    await start("a@b.co", guest.cookie);
    await handle.db.delete(users).where(eq(users.id, guest.userId));
    expect((await verify(lastToken())).status).toBe(200);
  });

  it("switches accounts when verifying while signed in as someone else", async () => {
    const other = await finishSignIn(handle.db, {
      identity: { method: "email", subject: "other@b.co" },
      guestUserIds: [],
    });
    const [kept] = await handle.db
      .insert(playlists)
      .values({ userId: other.userId, name: "p", prompt: "p", length: 20 })
      .returning({ id: playlists.id });
    await start("a@b.co");
    const res = await verify(lastToken(), `tl_session=${other.token}`);
    expect((await me(sessionCookie(res))).user?.label).toBe("a@b.co");
    expect(await sessionRepo.resolve(other.token)).toBeUndefined();
    expect(await ownerOf(kept?.id ?? "")).toBe(other.userId);
    const [left] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(sessions)
      .where(eq(sessions.userId, other.userId));
    expect(left?.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tunelynk/api exec vitest run src/auth/email.integration.test.ts`
Expected: FAIL. The routes do not exist yet, so requests return 404 `{"error":"Not Found"}` and assertions on 202/200 fail.

- [ ] **Step 3: Implement `apps/api/src/auth/email.ts`**

```ts
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
```

- [ ] **Step 4: Wire `apps/api/src/app.ts`**

Add the import `import { type EmailDeps, emailRoutes } from "./auth/email";`. Add `email: EmailDeps;` to `AppDeps` after `auth`. Destructure `email` in `createApp({ db, webDir, auth, email, runs })`. Add the route after `.route("/auth", authRoutes(auth))`:

```ts
    .route("/auth/email", emailRoutes({ ...email, db, auth }))
```

- [ ] **Step 5: Update every other `createApp` call site**

- In `apps/api/src/app.test.ts`, `apps/api/src/app.web.test.ts` and `apps/api/src/app.integration.test.ts`:
  - Add `import type { EmailDeps } from "./auth/email";`.
  - Add `const email = {} as EmailDeps; // never hit here`.
  - Pass `email` next to `auth` in every `createApp` call.
- In `apps/api/src/auth/routes.integration.test.ts`: add `email: {} as EmailDeps` (import the type from `./email`).
- In `apps/api/src/runs/routes.integration.test.ts`: add `email: {} as EmailDeps` (import from `../auth/email`) to both `createApp` calls.

In `apps/api/src/index.ts`:

```ts
import { createLoginTokenRepo } from "./auth/loginTokens";
import { createMailer } from "./auth/mailer";
```

```ts
  email: {
    loginTokens: createLoginTokenRepo(db),
    mailer: createMailer(env.EMAIL),
    appUrl: env.APP_URL,
  },
```

(placed after the `auth: { ... }` block in `createApp({ ... })`). After `const env = loadEnv();`, add a boot warning:

```ts
if (env.EMAIL.provider === "console") {
  console.warn("EMAIL_PROVIDER=console: sign-in links are logged, not sent");
}
```

- [ ] **Step 6: Run everything to verify it passes**

Run: `pnpm --filter @tunelynk/api typecheck && pnpm --filter @tunelynk/api test && pnpm --filter @tunelynk/api test:integration`
Expected: PASS, including all 17 email route tests.

- [ ] **Step 7: Deploy docs**

In `docs/deploy.md`, step 3 **Environment**, add these lines to the env block after `PORT=3000`:

```
APP_URL=https://tunelynk.bytmoor.com
EMAIL_PROVIDER=resend
RESEND_API_KEY=<Resend API key, sending access>
EMAIL_FROM=Tunelynk <login@bytmoor.com>
```

Add this paragraph after the "Set these before a deploy…" paragraph:

```markdown
   **Resend (magic-link email).** Create a Resend account, add the sending domain `bytmoor.com` (Domains → Add), and create the DNS records Resend lists (an SPF `TXT` and the DKIM `TXT`/`CNAME` records; DMARC is optional) at the DNS provider. Wait until Resend shows the domain as **Verified**, then create an API key with **Sending access** and put it in `RESEND_API_KEY`. `EMAIL_FROM` must use the verified domain. With `EMAIL_PROVIDER` unset the server logs sign-in links instead of sending them and warns at boot.
```

- [ ] **Step 8: Commit**

```bash
pnpm --filter @tunelynk/api exec biome check --write .
git add apps/api/src docs/deploy.md
git commit -m "feat(api): email magic-link sign-in

POST /api/auth/email/start issues a single-use, 15-minute link (3 per
address per 15 min) and mails it; POST /api/auth/email/verify consumes
it, signs in, and claims the requesting and verifying browsers' guests.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Whole-slice verification

**Files:** none new.

- [ ] **Step 1: Full check**

Run: `pnpm check && pnpm build`
Expected: all packages pass and the build succeeds.

- [ ] **Step 2: Local smoke with the console mailer**

Start the built API on a free port with the local `.env`. `EMAIL_PROVIDER` is unset, so links are logged:

```bash
cd apps/api && PORT=3100 node --env-file=../../.env dist/index.js > <scratchpad>/api.log 2>&1 &
```

Then, with a cookie jar in the scratchpad:

```bash
B=localhost:3100/api
curl -s -c $J -b $J -H 'content-type: application/json' -d '{"prompt":"late night drive"}' $B/runs    # guest + run
curl -s -c $J -b $J -H 'content-type: application/json' -d '{"email":"Smoke@Example.com","returnTo":"/x"}' $B/auth/email/start   # {}
grep 'sign-in link' <scratchpad>/api.log      # [mail] sign-in link for smoke@example.com: http://localhost:5173/signin/verify#t=…
T=<token after #t=>
curl -s -c $J -b $J -H 'content-type: application/json' -d "{\"token\":\"$T\"}" $B/auth/email/verify   # {"returnTo":"/x"}
curl -s -b $J $B/me                            # {"user":{…,"isGuest":false,"label":"smoke@example.com"}}
curl -s -c $J -b $J -H 'content-type: application/json' -d "{\"token\":\"$T\"}" $B/auth/email/verify   # {"error":"invalid_or_expired"}
```

Confirm in Postgres that the guest's playlist now belongs to the account: `select user_id from playlists order by created_at desc limit 1` matches `/api/me`'s `id`. Stop the server.

- [ ] **Step 3: Push and open the stacked PR**

```bash
git push -u origin feat/11-slice-b-magic-link
gh pr create --base feat/11-slice-a-sessions --title "#11 slice B: email magic link" --body "…summary, test plan, env changes, 'Part of #11; stacked on #30'…

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

**Before this PR merges** (tracked in memory: walk the user through it): Resend account and domain verification, then the Dokploy env `APP_URL`, `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and `EMAIL_FROM`. `APP_URL` is required at boot, so a deploy without it rolls back.
