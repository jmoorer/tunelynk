# Slice C: Sign in with Apple Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can sign in with Apple on the web. Any guest drafts in that browser move to the Apple account.

**Architecture:**
- `apps/api/src/auth/apple.ts` holds an `AppleClient`:
  - It builds the authorize URL.
  - It signs the ES256 `client_secret` with `jose`, using the MusicKit key by default.
  - It exchanges the code at Apple's token endpoint and verifies the `id_token` against Apple's JWKS (`jose`'s `createRemoteJWKSet`).
  - `fetch`, the token URL and the key set are all injectable.
- `apps/api/src/auth/appleRoutes.ts` serves `GET /api/auth/apple/start` and `/callback`:
  - Start stores `{state, nonce, returnTo}` in a signed, short-lived `tl_apple` cookie scoped to `/api/auth/apple`.
  - Callback checks that cookie, calls slice A's `finishSignIn`, and redirects.
  - Every failure redirects to `/signin?error=apple`.

**Tech Stack:** Hono 4.13 (`hono/cookie` signed cookies), `jose` ~6.2.12 (new dependency), `node:crypto`, Vitest 5, Postgres integration tests.

**Spec:** `docs/superpowers/specs/2026-10-03-accounts-design.md`: sections "Sign in with Apple (slice C)", "Env additions", "Error handling", "Testing → C". Earlier plans: slice A `2026-10-03-slice-a-sessions.md`, slice B `2026-10-04-slice-b-magic-link.md`.

## Global Constraints

- Branch `feat/11-slice-c-apple`, created from `feat/11-slice-b-magic-link` (PR #31). The PR's base is `feat/11-slice-b-magic-link`.
- Node 22.23.3; local Postgres up. pnpm has a minimum-release-age guard: add `jose@~6.2.12`. If `pnpm install` edits `pnpm-workspace.yaml` (`minimumReleaseAgeExclude`), revert that edit and pin an older patch.
- Apple endpoints:
  - authorize `https://appleid.apple.com/auth/authorize`
  - token `https://appleid.apple.com/auth/token`
  - keys `https://appleid.apple.com/auth/keys`
  - issuer `https://appleid.apple.com`
- Authorize parameters: exactly `client_id`, `redirect_uri`, `response_type=code`, `response_mode=query`, `state`, `nonce`. **No `scope`.**
- `redirect_uri` = `${APP_URL}/api/auth/apple/callback`.
- `client_secret`: an ES256 JWT.
  - Header: `{ alg: "ES256", kid: <signin key id> }`.
  - Claims: `iss = APPLE_TEAM_ID`, `sub = APPLE_SIGNIN_CLIENT_ID`, `aud = "https://appleid.apple.com"`, `iat` = now, `exp = iat + 300`.
- `id_token` checks: `RS256`, issuer `https://appleid.apple.com`, audience `APPLE_SIGNIN_CLIENT_ID`, unexpired, `nonce` claim **equal** to the nonce sent, non-empty `sub`.
- State cookie `tl_apple`:
  - Signed with `SESSION_SECRET` via Hono's `setSignedCookie`.
  - Value is base64url JSON `{ state, nonce, returnTo? }`. `state` and `nonce` are each 16 random bytes, base64url.
  - Attributes: `httpOnly`, `SameSite=Lax`, `Secure` per `COOKIE_SECURE`, `Path=/api/auth/apple`, `Max-Age=600`.
  - The callback always deletes it.
- Callback success: `finishSignIn({ method: "apple", subject: sub }, [current guest], currentSessionId)`, then `tl_session` is set and the response is `302` to `returnTo` (default `/`). Claiming the current guest is safe here because the state cookie proves the same browser started the flow.
- **Every** callback failure gives `302` to `/signin?error=apple`, plus `&returnTo=<encoded>` when a safe `returnTo` is known. Failures include: Apple's `error` param (for example `user_cancelled_authorize`), a missing or tampered cookie, a state mismatch, a missing code, a failed exchange, and a failed `id_token` check. The reason is logged; codes and tokens are never logged.
- Env:
  - `APPLE_SIGNIN_CLIENT_ID` is required.
  - `APPLE_SIGNIN_KEY_ID` and `APPLE_SIGNIN_PRIVATE_KEY` are optional and fall back to `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY`.
  - Parsed output: `APPLE_SIGNIN: { clientId, keyId, privateKey }`.
- Format with Biome per package before each commit. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A replayed callback URL, or the back button after sign-in.** The state cookie is gone, so it fails cleanly to `/signin?error=apple`, never a 500 or a second session. Test in Task 3.
2. **Apple rotates its signing keys** (an `id_token` whose `kid` isn't in the key set). This is a handled failure, not a crash. Test in Task 2.
3. **The person cancels on Apple's page.** The callback gets `?error=user_cancelled_authorize` and no code, and lands on `/signin?error=apple` with their `returnTo` kept. Test in Task 3.
4. **A crafted `returnTo` at start** (`//evil.com`). It must never appear in any `Location` header, on success or on failure. Test in Task 3.
5. **An `id_token` signed by the right `kid` but the wrong key, or replayed with another flow's nonce.** It is rejected. Test in Task 2.

---

### Task 1: Env, key loader export, `jose`

**Files:**
- Modify: `apps/api/src/env.ts`, `apps/api/src/env.test.ts`, `packages/connectors/src/apple/index.ts`, `apps/api/package.json` (+ `pnpm-lock.yaml`), `.env.example`, local `.env`
- Test: `apps/api/src/env.test.ts`

**Interfaces:**
- Produces:
  - `Env.APPLE_SIGNIN: { clientId: string; keyId: string; privateKey: string }`. The raw `APPLE_SIGNIN_*` keys are not in the output.
  - `loadPrivateKey(raw: string): KeyObject`, exported from `@tunelynk/connectors`.
  - `jose` importable in `apps/api`.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/env.test.ts`, add `APPLE_SIGNIN_CLIENT_ID: "com.bytmoor.tunelynk.web",` to `base`. In the first test's expected object add, at the end:

```ts
      APPLE_SIGNIN: {
        clientId: "com.bytmoor.tunelynk.web",
        keyId: "KEY",
        privateKey: "PRIVATE",
      },
```

Add inside `describe("parseEnv")`:

```ts
  it("requires APPLE_SIGNIN_CLIENT_ID", () => {
    const { APPLE_SIGNIN_CLIENT_ID: _omit, ...rest } = base;
    expect(() => parseEnv(rest)).toThrow(/APPLE_SIGNIN_CLIENT_ID/);
  });

  it("uses a separate Sign in with Apple key when given", () => {
    const env = parseEnv({
      ...base,
      APPLE_SIGNIN_KEY_ID: "SIWAKEY",
      APPLE_SIGNIN_PRIVATE_KEY: "SIWAPRIVATE",
    });
    expect(env.APPLE_SIGNIN).toEqual({
      clientId: "com.bytmoor.tunelynk.web",
      keyId: "SIWAKEY",
      privateKey: "SIWAPRIVATE",
    });
    expect(env).not.toHaveProperty("APPLE_SIGNIN_KEY_ID");
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @tunelynk/api exec vitest run src/env.test.ts`
Expected: FAIL. The minimal test lacks `APPLE_SIGNIN`, and the required-variable test does not throw.

- [ ] **Step 3: Implement**

In `apps/api/src/env.ts`, add to the object schema after `APPLE_CATALOG_CONCURRENCY`:

```ts
    // Sign in with Apple: the Services ID; the key defaults to the MusicKit key.
    APPLE_SIGNIN_CLIENT_ID: z.string().min(1),
    APPLE_SIGNIN_KEY_ID: z.string().optional(),
    APPLE_SIGNIN_PRIVATE_KEY: z.string().optional(),
```

In the transform's final destructure, add `APPLE_SIGNIN_CLIENT_ID: signinClientId, APPLE_SIGNIN_KEY_ID: signinKeyId, APPLE_SIGNIN_PRIVATE_KEY: signinPrivateKey,` before `...rest`, and add to the returned object:

```ts
      APPLE_SIGNIN: {
        clientId: signinClientId,
        keyId: signinKeyId ?? rest.APPLE_KEY_ID,
        privateKey: signinPrivateKey ?? rest.APPLE_PRIVATE_KEY,
      },
```

In `packages/connectors/src/apple/index.ts`, add the line `export { loadPrivateKey } from "./devToken";` next to the existing `export { AppleApiError } from "./client";`.

Add the dependency:

```bash
pnpm --filter @tunelynk/api add jose@~6.2.12
git diff --stat pnpm-workspace.yaml   # must be empty
```

In `.env.example`, after `APPLE_CATALOG_CONCURRENCY=4` add:

```
# Sign in with Apple. Services ID (client_id); the key defaults to the MusicKit key above.
APPLE_SIGNIN_CLIENT_ID=com.bytmoor.tunelynk.web
APPLE_SIGNIN_KEY_ID=
APPLE_SIGNIN_PRIVATE_KEY=
```

Add `APPLE_SIGNIN_CLIENT_ID=com.bytmoor.tunelynk.web` to the local, gitignored `.env` after `APPLE_PRIVATE_KEY=…`. Otherwise the dev server stops booting.

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm --filter @tunelynk/api exec vitest run src/env.test.ts && pnpm --filter @tunelynk/api typecheck && pnpm --filter @tunelynk/connectors typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm --filter @tunelynk/api exec biome check --write . && pnpm --filter @tunelynk/connectors exec biome check --write .
git add apps/api packages/connectors pnpm-lock.yaml .env.example
git commit -m "feat(api): Sign in with Apple env and jose

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Apple client (client secret, code exchange, id_token)

**Files:**
- Create: `apps/api/src/auth/apple.ts`
- Test: `apps/api/src/auth/apple.test.ts`

**Interfaces:**
- Consumes: `loadPrivateKey` (Task 1), `jose`.
- Produces:
  ```ts
  export const APPLE_ISSUER = "https://appleid.apple.com";
  export class AppleSignInError extends Error {}
  export type AppleSignInConfig = { clientId: string; teamId: string; keyId: string; privateKey: string; redirectUri: string };
  export type AppleClient = {
    authorizeUrl(args: { state: string; nonce: string }): string;
    exchange(code: string, nonce: string): Promise<{ sub: string }>;   // throws AppleSignInError
  };
  export function createAppleClient(config: AppleSignInConfig, deps?: {
    fetch?: typeof fetch; keys?: JWTVerifyGetKey; tokenUrl?: string;
  }): AppleClient;
  ```

- [ ] **Step 1: Write the failing test**

`apps/api/src/auth/apple.test.ts`:

```ts
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  exportJWK,
  type JWTVerifyGetKey,
  jwtVerify,
  SignJWT,
} from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AppleSignInError, createAppleClient } from "./apple";

const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherRsa = generateKeyPairSync("rsa", { modulusLength: 2048 });

const config = {
  clientId: "com.bytmoor.tunelynk.web",
  teamId: "TEAM123",
  keyId: "KEY123",
  privateKey: ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  redirectUri: "https://tunelynk.test/api/auth/apple/callback",
};

let keys: JWTVerifyGetKey;
beforeAll(async () => {
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(rsa.publicKey)), kid: "apple-1", alg: "RS256", use: "sig" }],
  });
});

const now = () => Math.floor(Date.now() / 1000);

const idToken = ({
  nonce = "n-1",
  aud = config.clientId,
  iss = "https://appleid.apple.com",
  sub = "001234.abc",
  kid = "apple-1",
  key = rsa.privateKey as KeyObject,
  exp = now() + 300,
}: Partial<{
  nonce: string; aud: string; iss: string; sub: string; kid: string;
  key: KeyObject; exp: number;
}> = {}) =>
  new SignJWT({ nonce })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject(sub)
    .setIssuedAt(exp - 600)
    .setExpirationTime(exp)
    .sign(key);

const tokenEndpoint = (body: unknown, status = 200) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );

describe("createAppleClient", () => {
  it("builds the authorize URL without scopes", () => {
    const url = new URL(
      createAppleClient(config, { keys }).authorizeUrl({ state: "s-1", nonce: "n-1" }),
    );
    expect(url.origin + url.pathname).toBe("https://appleid.apple.com/auth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      response_mode: "query",
      state: "s-1",
      nonce: "n-1",
    });
  });

  it("exchanges the code with an ES256 client secret and returns sub", async () => {
    const fetch = tokenEndpoint({ id_token: await idToken() });
    const result = await createAppleClient(config, { keys, fetch }).exchange("code-1", "n-1");
    expect(result).toEqual({ sub: "001234.abc" });

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://appleid.apple.com/auth/token");
    expect(init.method).toBe("POST");
    const form = new URLSearchParams(String(init.body));
    expect(form.get("client_id")).toBe(config.clientId);
    expect(form.get("code")).toBe("code-1");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("redirect_uri")).toBe(config.redirectUri);

    const secret = form.get("client_secret") ?? "";
    expect(decodeProtectedHeader(secret)).toEqual({ alg: "ES256", kid: "KEY123" });
    const { payload } = await jwtVerify(secret, ec.publicKey, {
      issuer: "TEAM123",
      audience: "https://appleid.apple.com",
      subject: config.clientId,
    });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
  });

  it.each([
    ["wrong audience", () => idToken({ aud: "com.other.app" })],
    ["wrong issuer", () => idToken({ iss: "https://evil.example" })],
    ["expired", () => idToken({ exp: now() - 60 })],
    ["nonce mismatch", () => idToken({ nonce: "n-other" })],
    ["empty sub", () => idToken({ sub: "" })],
    ["unknown kid (rotated keys)", () => idToken({ kid: "apple-2" })],
    ["right kid, wrong key", () => idToken({ key: otherRsa.privateKey })],
  ])("rejects an id_token with %s", async (_label, make) => {
    const fetch = tokenEndpoint({ id_token: await make() });
    await expect(
      createAppleClient(config, { keys, fetch }).exchange("code-1", "n-1"),
    ).rejects.toBeInstanceOf(AppleSignInError);
  });

  it("rejects a non-2xx token response", async () => {
    const fetch = tokenEndpoint({ error: "invalid_grant" }, 400);
    await expect(
      createAppleClient(config, { keys, fetch }).exchange("code-1", "n-1"),
    ).rejects.toThrow(/400/);
  });

  it("rejects a response without an id_token", async () => {
    const fetch = tokenEndpoint({ access_token: "x" });
    await expect(
      createAppleClient(config, { keys, fetch }).exchange("code-1", "n-1"),
    ).rejects.toBeInstanceOf(AppleSignInError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tunelynk/api exec vitest run src/auth/apple.test.ts`
Expected: FAIL. `./apple` cannot be resolved.

- [ ] **Step 3: Implement `apps/api/src/auth/apple.ts`**

```ts
import { loadPrivateKey } from "@tunelynk/connectors";
import {
  createRemoteJWKSet,
  type JWTVerifyGetKey,
  jwtVerify,
  SignJWT,
} from "jose";

export const APPLE_ISSUER = "https://appleid.apple.com";
const AUTHORIZE_URL = "https://appleid.apple.com/auth/authorize";
const TOKEN_URL = "https://appleid.apple.com/auth/token";
const KEYS_URL = "https://appleid.apple.com/auth/keys";
const CLIENT_SECRET_TTL = "5m";
const TOKEN_TIMEOUT_MS = 10_000;

export class AppleSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleSignInError";
  }
}

export type AppleSignInConfig = {
  clientId: string; // Services ID
  teamId: string;
  keyId: string;
  privateKey: string; // same formats as APPLE_PRIVATE_KEY
  redirectUri: string;
};

export type AppleClient = {
  authorizeUrl(args: { state: string; nonce: string }): string;
  exchange(code: string, nonce: string): Promise<{ sub: string }>;
};

export function createAppleClient(
  config: AppleSignInConfig,
  {
    fetch = globalThis.fetch,
    // Caches Apple's keys and refetches on an unknown kid (key rotation).
    keys = createRemoteJWKSet(new URL(KEYS_URL)),
    tokenUrl = TOKEN_URL,
  }: {
    fetch?: typeof globalThis.fetch;
    keys?: JWTVerifyGetKey;
    tokenUrl?: string;
  } = {},
): AppleClient {
  const key = loadPrivateKey(config.privateKey);

  const clientSecret = () =>
    new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: config.keyId })
      .setIssuer(config.teamId)
      .setSubject(config.clientId)
      .setAudience(APPLE_ISSUER)
      .setIssuedAt()
      .setExpirationTime(CLIENT_SECRET_TTL)
      .sign(key);

  return {
    // No scope: Apple then allows response_mode=query, so the callback is a
    // GET that carries our SameSite=Lax cookies.
    authorizeUrl({ state, nonce }) {
      const query = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        response_mode: "query",
        state,
        nonce,
      });
      return `${AUTHORIZE_URL}?${query}`;
    },

    async exchange(code, nonce) {
      const res = await fetch(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: await clientSecret(),
          code,
          grant_type: "authorization_code",
          redirect_uri: config.redirectUri,
        }),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new AppleSignInError(`token endpoint responded ${res.status}`);
      }
      const body = (await res.json().catch(() => null)) as {
        id_token?: unknown;
      } | null;
      if (typeof body?.id_token !== "string") {
        throw new AppleSignInError("token response has no id_token");
      }

      let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
      try {
        ({ payload } = await jwtVerify(body.id_token, keys, {
          issuer: APPLE_ISSUER,
          audience: config.clientId,
          algorithms: ["RS256"],
        }));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new AppleSignInError(`id_token rejected: ${reason}`);
      }
      if (payload.nonce !== nonce) {
        throw new AppleSignInError("id_token nonce mismatch");
      }
      if (typeof payload.sub !== "string" || payload.sub === "") {
        throw new AppleSignInError("id_token has no sub");
      }
      return { sub: payload.sub };
    },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @tunelynk/api exec vitest run src/auth/apple.test.ts && pnpm --filter @tunelynk/api typecheck`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
pnpm --filter @tunelynk/api exec biome check --write .
git add apps/api/src/auth
git commit -m "feat(api): Apple client: client secret, code exchange, id_token checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Apple routes and wiring

**Files:**
- Create: `apps/api/src/auth/appleRoutes.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/index.ts`, every other `createApp` call site (`app.test.ts`, `app.web.test.ts`, `app.integration.test.ts`, `auth/routes.integration.test.ts`, `auth/email.integration.test.ts`, `runs/routes.integration.test.ts`), `docs/deploy.md`
- Test: `apps/api/src/auth/appleRoutes.integration.test.ts`

**Interfaces:**
- Consumes:
  - `AppleClient` (Task 2).
  - From slice A: `finishSignIn`, `setSessionCookie`, `AuthDeps`, `AuthEnv`, `safeReturnTo`.
- Produces:
  ```ts
  export const APPLE_STATE_COOKIE = "tl_apple";
  export type AppleDeps = { client: AppleClient; logger?: Pick<Console, "error"> };
  export function appleRoutes(deps: AppleDeps & { db: Db; auth: AuthDeps }): Hono<AuthEnv>;
  // app.ts
  export type AppDeps = { db; webDir?; auth; email; apple: AppleDeps; runs };
  ```

- [ ] **Step 1: Write the failing test**

`apps/api/src/auth/appleRoutes.integration.test.ts`:

```ts
import { playlists } from "@tunelynk/db";
import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { createApp } from "../app";
import type { RunsDeps } from "../runs/routes";
import { createTestDatabase } from "../test/db";
import type { AppleClient } from "./apple";
import { AppleSignInError } from "./apple";
import type { EmailDeps } from "./email";
import { createSessionRepo, type SessionRepo } from "./sessions";

const SECRET = "test-secret-test-secret-test-secret!";

describe.skipIf(!process.env.DATABASE_URL)("/api/auth/apple", () => {
  let handle: Awaited<ReturnType<typeof createTestDatabase>>;
  let sessionRepo: SessionRepo;
  let app: ReturnType<typeof createApp>;
  let exchange: Mock<AppleClient["exchange"]>;
  let errors: unknown[][];

  beforeAll(async () => {
    handle = await createTestDatabase();
    sessionRepo = createSessionRepo(handle.db);
    const client: AppleClient = {
      authorizeUrl: ({ state, nonce }) =>
        `https://appleid.apple.com/auth/authorize?state=${state}&nonce=${nonce}`,
      exchange: (code, nonce) => exchange(code, nonce),
    };
    app = createApp({
      db: handle.db,
      auth: { sessions: sessionRepo, sessionSecret: SECRET, secureCookies: false },
      email: {} as EmailDeps,
      apple: { client, logger: { error: (...args) => errors.push(args) } },
      runs: {} as RunsDeps,
    });
  });
  afterAll(() => handle.drop());
  beforeEach(async () => {
    await handle.db.execute(sql`truncate users cascade`);
    exchange = vi.fn<AppleClient["exchange"]>(async () => ({
      sub: "001234.abc",
    }));
    errors = [];
  });

  const cookieNamed = (res: Response, name: string) =>
    res.headers
      .getSetCookie()
      .filter((c) => c.startsWith(`${name}=`))
      .at(-1);
  const pair = (res: Response, name: string) =>
    cookieNamed(res, name)?.split(";")[0] ?? "";

  // Runs /start, returns the state cookie and the state Apple would echo back.
  const begin = async (returnTo?: string, cookie = "") => {
    const query = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : "";
    const res = await app.request(`/api/auth/apple/start${query}`, {
      headers: cookie ? { cookie } : {},
    });
    const location = new URL(res.headers.get("location") ?? "");
    return {
      res,
      stateCookie: pair(res, "tl_apple"),
      state: location.searchParams.get("state") ?? "",
      nonce: location.searchParams.get("nonce") ?? "",
    };
  };
  const callback = (query: string, cookie: string) =>
    app.request(`/api/auth/apple/callback?${query}`, { headers: { cookie } });
  const me = async (cookie: string) =>
    (await (await app.request("/api/me", { headers: { cookie } })).json()) as {
      user: { id: string; label: string | null } | null;
    };

  it("start redirects to Apple and sets a scoped, short-lived state cookie", async () => {
    const { res, state, nonce } = await begin("/x");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/appleid\.apple\.com\/auth\/authorize\?/);
    expect(state).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(nonce).not.toBe(state);
    const cookie = cookieNamed(res, "tl_apple") ?? "";
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/api\/auth\/apple/);
    expect(cookie).toMatch(/Max-Age=600/);
  });

  it("signs in on a valid callback and returns to returnTo", async () => {
    const { stateCookie, state, nonce } = await begin("/playlists/p/runs/r?keep=1");
    const res = await callback(`code=c-1&state=${state}`, stateCookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/playlists/p/runs/r?keep=1");
    expect(exchange).toHaveBeenCalledWith("c-1", nonce);
    expect(pair(res, "tl_apple")).toBe("tl_apple=");
    expect((await me(pair(res, "tl_session"))).user?.label).toBe("Apple ID");
  });

  it("defaults to / and reuses the account for the same Apple sub", async () => {
    const first = await begin();
    const a = await callback(`code=c-1&state=${first.state}`, first.stateCookie);
    expect(a.headers.get("location")).toBe("/");
    const second = await begin();
    const b = await callback(`code=c-2&state=${second.state}`, second.stateCookie);
    expect((await me(pair(b, "tl_session"))).user?.id).toBe(
      (await me(pair(a, "tl_session"))).user?.id,
    );
  });

  it("claims this browser's guest drafts", async () => {
    const guest = await sessionRepo.createGuestSession();
    const [playlist] = await handle.db
      .insert(playlists)
      .values({ userId: guest.userId, name: "p", prompt: "p", length: 20 })
      .returning({ id: playlists.id });
    const guestCookie = `tl_session=${guest.token}`;
    const { stateCookie, state } = await begin(undefined, guestCookie);
    const res = await callback(`code=c-1&state=${state}`, `${guestCookie}; ${stateCookie}`);
    const account = (await me(pair(res, "tl_session"))).user;
    const [owner] = await handle.db
      .select({ u: playlists.userId })
      .from(playlists)
      .where(eq(playlists.id, playlist?.id ?? ""));
    expect(owner?.u).toBe(account?.id);
    expect(await sessionRepo.resolve(guest.token)).toBeUndefined();
  });

  const expectFailure = (res: Response, returnTo?: string) => {
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/signin?")).toBe(true);
    const params = new URL(location, "http://x").searchParams;
    expect(params.get("error")).toBe("apple");
    expect(params.get("returnTo")).toBe(returnTo ?? null);
    expect(cookieNamed(res, "tl_session")).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  };

  it("fails cleanly when the person cancels on Apple, keeping returnTo", async () => {
    const { stateCookie, state } = await begin("/x");
    const res = await callback(`error=user_cancelled_authorize&state=${state}`, stateCookie);
    expectFailure(res, "/x");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("fails on a state mismatch", async () => {
    const { stateCookie } = await begin();
    expectFailure(await callback("code=c-1&state=forged", stateCookie));
    expect(exchange).not.toHaveBeenCalled();
  });

  it("fails without the state cookie (replayed callback or other browser)", async () => {
    const { state } = await begin();
    expectFailure(await callback(`code=c-1&state=${state}`, ""));
  });

  it("fails on a tampered state cookie", async () => {
    const { stateCookie, state } = await begin();
    expectFailure(await callback(`code=c-1&state=${state}`, `${stateCookie}x`));
  });

  it("fails without a code", async () => {
    const { stateCookie, state } = await begin();
    expectFailure(await callback(`state=${state}`, stateCookie));
  });

  it("fails when the exchange or id_token check fails", async () => {
    exchange = vi.fn<AppleClient["exchange"]>(async () => {
      throw new AppleSignInError("id_token nonce mismatch");
    });
    const { stateCookie, state } = await begin("/x");
    expectFailure(await callback(`code=c-1&state=${state}`, stateCookie), "/x");
  });

  it("never redirects to an unsafe returnTo", async () => {
    const ok = await begin("//evil.com");
    const success = await callback(`code=c-1&state=${ok.state}`, ok.stateCookie);
    expect(success.headers.get("location")).toBe("/");
    const bad = await begin("//evil.com");
    const failure = await callback("code=c-1&state=forged", bad.stateCookie);
    expect(failure.headers.get("location")).toBe("/signin?error=apple");
  });

  it("never logs the code", async () => {
    exchange = vi.fn<AppleClient["exchange"]>(async () => {
      throw new AppleSignInError("token endpoint responded 400");
    });
    const { stateCookie, state } = await begin();
    await callback(`code=secret-code-123&state=${state}`, stateCookie);
    expect(JSON.stringify(errors.map((e) => e.map(String)))).not.toContain(
      "secret-code-123",
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tunelynk/api exec vitest run src/auth/appleRoutes.integration.test.ts`
Expected: FAIL. The routes do not exist, so responses are 404 and the 302 assertions fail.

- [ ] **Step 3: Implement `apps/api/src/auth/appleRoutes.ts`**

```ts
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
  client: AppleClient;
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
        deps.client.authorizeUrl({ state: saved.state, nonce: saved.nonce }),
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
        ({ sub } = await deps.client.exchange(code, saved.nonce));
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
```

- [ ] **Step 4: Wire it**

In `apps/api/src/app.ts`:
- Add `import { type AppleDeps, appleRoutes } from "./auth/appleRoutes";`.
- Add `apple: AppleDeps;` to `AppDeps` after `email`.
- Destructure `apple` in `createApp`.
- Add after the `/auth/email` route:
  ```ts
      .route("/auth/apple", appleRoutes({ ...apple, db, auth }))
  ```

Every other `createApp` call site gets `apple: {} as AppleDeps`, importing the type from `./auth/appleRoutes` or `../auth/appleRoutes`. In `app.test.ts`, `app.web.test.ts` and `app.integration.test.ts`, add `const apple = {} as AppleDeps; // never hit here` and pass `apple` next to `email`. In `auth/routes.integration.test.ts`, `auth/email.integration.test.ts` and `runs/routes.integration.test.ts`, add `apple: {} as AppleDeps,` next to `email`.

In `apps/api/src/index.ts`:

```ts
import { createAppleClient } from "./auth/apple";
```

```ts
  apple: {
    client: createAppleClient({
      clientId: env.APPLE_SIGNIN.clientId,
      teamId: env.APPLE_TEAM_ID,
      keyId: env.APPLE_SIGNIN.keyId,
      privateKey: env.APPLE_SIGNIN.privateKey,
      redirectUri: `${env.APP_URL}/api/auth/apple/callback`,
    }),
  },
```

(placed after the `email: { ... }` block in `createApp({ ... })`).

- [ ] **Step 5: Run everything to verify it passes**

Run: `pnpm --filter @tunelynk/api typecheck && pnpm --filter @tunelynk/api test && pnpm --filter @tunelynk/api test:integration`
Expected: PASS, including all 12 Apple route tests.

- [ ] **Step 6: Deploy docs**

In `docs/deploy.md` step 3 **Environment**, add `APPLE_SIGNIN_CLIENT_ID=com.bytmoor.tunelynk.web` after `APPLE_PRIVATE_KEY=…` in the env block. Then add this paragraph after the Resend paragraph:

```markdown
   **Sign in with Apple.** In the Apple Developer portal (Certificates, Identifiers & Profiles):
   1. **Identifiers → +  → App IDs → App**: description `Tunelynk`, Bundle ID (explicit) `com.bytmoor.tunelynk`, enable **Sign in with Apple**. Register.
   2. **Identifiers → + → Services IDs**: description `Tunelynk Web`, identifier `com.bytmoor.tunelynk.web`. Register, open it, tick **Sign in with Apple → Configure**: primary App ID `com.bytmoor.tunelynk`, domain `tunelynk.bytmoor.com`, return URL `https://tunelynk.bytmoor.com/api/auth/apple/callback`. Save, then Continue/Save.
   3. **Keys**: open the MusicKit key (`APPLE_KEY_ID`) → Edit → enable **Sign in with Apple** → Configure → primary App ID `com.bytmoor.tunelynk` → Save. If the portal won't edit that key, create a new key with only Sign in with Apple and set `APPLE_SIGNIN_KEY_ID` and `APPLE_SIGNIN_PRIVATE_KEY` (base64 of its `.p8`).
   4. Set `APPLE_SIGNIN_CLIENT_ID` to the Services ID. Apple does not allow `localhost` return URLs; local end-to-end tests need an HTTPS tunnel whose domain and return URL are added to the Services ID.
```

- [ ] **Step 7: Commit**

```bash
pnpm --filter @tunelynk/api exec biome check --write .
git add apps/api/src docs/deploy.md
git commit -m "feat(api): Sign in with Apple routes

GET /api/auth/apple/start sets a signed, path-scoped state cookie and
redirects to Apple (no scopes, response_mode=query). The callback checks
state, exchanges the code, verifies the id_token, signs in and claims this
browser's guest; every failure lands on /signin?error=apple.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Whole-slice verification

**Files:** none new.

- [ ] **Step 1: Full check**

Run: `pnpm check && pnpm build`
Expected: everything passes.

- [ ] **Step 2: Local smoke (redirect leg only)**

Start the built API on a free port (`PORT=3100`, local `.env`, which now has `APPLE_SIGNIN_CLIENT_ID`). Then:

```bash
curl -s -i 'localhost:3100/api/auth/apple/start?returnTo=/x' | grep -iE '^(HTTP|location|set-cookie)'
#   302; Location https://appleid.apple.com/auth/authorize?client_id=com.bytmoor.tunelynk.web&redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fapi%2Fauth%2Fapple%2Fcallback&response_type=code&response_mode=query&state=…&nonce=…
#   tl_apple=…; Max-Age=600; Path=/api/auth/apple; HttpOnly; SameSite=Lax
curl -s -i 'localhost:3100/api/auth/apple/callback?error=user_cancelled_authorize' | grep -iE '^(HTTP|location)'
#   302; Location /signin?error=apple
```

Stop the server. The real Apple round trip runs on production after merge, because Apple won't redirect to `localhost`.

- [ ] **Step 3: Push and open the stacked PR**

```bash
git push -u origin feat/11-slice-c-apple
gh pr create --base feat/11-slice-b-magic-link --title "#11 slice C: Sign in with Apple" --body "…summary, test plan, env, 'Part of #11; stacked on #31'…

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

**Before this PR merges** (walk the user through it, see memory): the Apple portal App ID, the Services ID, Sign in with Apple enabled on the key, and Dokploy env `APPLE_SIGNIN_CLIENT_ID`. Without that variable the new container exits at boot.
