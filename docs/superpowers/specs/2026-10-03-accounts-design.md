# Accounts: Magic Link + Sign in with Apple — Design

**Date:** 2026-10-03
**Status:** Draft (pending review)
**Issue:** #11 (sub-project 2 of the [product flow map](2026-09-30-product-flow-map-design.md))
**Builds on:** [Engine on Apple catalog + guest generate](2026-10-01-engine-guest-generate-design.md) (#10)

## Goal

A guest who generated a playlist can sign in with an email magic link or Sign in with Apple, and keep that playlist in a real account.

### Brief

The flow map fixes the identity model: `users`, `auth_identities`, `login_tokens`, `sessions`. Login identity is separate from music connections. Guests are anonymous `users` rows, and signing in claims their drafts. One-off playlists follow **Keep**: run `draft` → `published`, playlist `draft` → `active`.

Today (#10) a guest is a `users` row with `is_guest = true`, identified by the HMAC-signed cookie `tl_guest=<userId>` (`SESSION_SECRET`). The cookie is created on `POST /api/runs`. There is no `sessions` table. The run view shows a disabled "Sign in to keep (coming soon)".

### Success criteria

- On production, a guest generates a playlist and clicks **Sign in to keep**. They sign in with a real magic-link email, and they land back on the run with the playlist kept and listed on `/`.
- The same works with Sign in with Apple in another browser.
- Existing guests (holding `tl_guest`) are not lost when this ships.

### In scope

- `auth_identities`, `login_tokens`, `sessions` tables, and one session cookie for guests and users.
- Email magic link through a swappable `Mailer` (Resend in production, console in dev and tests).
- Sign in with Apple on the web (Services ID, server-side code exchange).
- Guest claim on sign-in, Keep, sign out, `GET /api/me`, `GET /api/playlists`.
- Web: sign-in pages, account menu, working Keep, a "Your playlists" list on `/` when signed in.

### Out of scope

- Account linking across methods (decided: never link).
- `/settings`, login-method management, account deletion.
- `/playlists/:id` detail page, the full dashboard (status overlays, next run), `/new`.
- Per-tier models (`LLM_MODEL_USER`) and per-user quotas. Signed-in users use the guest model and length.
- Sweeping expired sessions and login tokens (#6 cleanup job).
- Abuse hardening beyond the per-email link rate limit (#20).
- Server-state libraries and a typed RPC client (#28). Moving tests out of `src/` (#29).

## Decisions

| Area | Choice | Reason |
|---|---|---|
| Delivery | Four slices, one stacked PR each: A sessions, B magic link, C Apple, D Keep + web | Each slice is testable on its own; same shape as #10 |
| Email provider | **Resend** behind a `Mailer` interface; `EMAIL_PROVIDER=console\|resend` | Plain HTTPS API, free tier fits; the interface keeps it swappable |
| Apple key | **Reuse the MusicKit key** (`APPLE_KEY_ID` / `APPLE_PRIVATE_KEY`); `APPLE_SIGNIN_KEY_ID` / `APPLE_SIGNIN_PRIVATE_KEY` optional overrides | Fewer secrets; splitting later is env-only |
| Apple flow | Server redirect, `response_type=code`, `response_mode=query`, **no scopes** | No scopes allows a GET callback, so the SameSite=Lax session cookie arrives and no `SameSite=None` cookie is needed. Email is not needed because identities never link |
| Session model | **One cookie for everyone**: `tl_session` = random token, DB stores its SHA-256; guests get sessions too | One identity path; revocable; legacy `tl_guest` upgraded on sight |
| Account linking | **Never link**: identity = `(method, subject)` | No takeover-by-email reasoning; the same person using both methods has two accounts |
| Magic link landing | SPA page `/signin/verify#t=<token>` that POSTs the token | Fragment stays out of logs and Referer; mail scanners that prefetch GET links cannot consume it |
| id_token verification | `jose` (`createRemoteJWKSet`, `jwtVerify`) | Standard, audited JWKS + JWT handling instead of hand-rolled RS256 |
| Web data layer | Hand-rolled fetch wrappers + hooks, `MeProvider` context | Matches #10; TanStack Query / Hono RPC evaluated later in #28 |
| Tests | Colocated in `src/`, as today | #29 moves all tests after this issue |

## Data model

One migration (slice A). `users` is unchanged.

```
auth_identities  id uuid, user_id → users (cascade), method ('email'|'apple'),
                 subject text, created_at                 UNIQUE(method, subject)
                 -- email: trimmed, lowercased address; apple: id_token `sub`
login_tokens     id uuid, token_hash text UNIQUE, email text, return_to text?,
                 guest_user_id? → users (set null), expires_at, used_at?, created_at
                                                          INDEX(email, created_at)
sessions         id uuid, token_hash text UNIQUE, user_id → users (cascade),
                 expires_at, created_at                   INDEX(user_id)
```

- New enum `auth_method ('email','apple')`.
- An account's display label comes from its identity: the email address, or `"Apple ID"`. Guests have no label.

## Sessions (slice A)

### Cookie

- `tl_session=<token>`. The token is 32 random bytes as base64url. Only `sha256(token)` (hex) is stored, in `sessions.token_hash`.
- Cookie attributes: `httpOnly`, `SameSite=Lax`, `Secure` per `COOKIE_SECURE`, `path=/`, max age 30 days.
- Sessions last 30 days. When a non-guest session is resolved with fewer than 15 days left, `expires_at` is extended to 30 days and the cookie is re-set. Guest sessions do not slide; a guest's activity creates new rows anyway.

### Middleware

One `session` middleware runs on all `/api/*` routes and sets `c.var.user: { id, isGuest } | null` and `c.var.sessionId`:

1. Valid, unexpired `tl_session` → load its user and bump `last_seen_at` (at most once per minute, as `touchUser` does today).
2. Otherwise, a valid legacy `tl_guest` that names an existing user → create a session for that user, set `tl_session`, delete `tl_guest`. This upgrade path can be removed once 30 days have passed since deploy (the `tl_guest` max age).
3. Otherwise → `user = null`. An invalid or expired `tl_session` is cleared.

Guests are still created lazily: `POST /api/runs` with `user = null` inserts a guest user and a session. `GET` requests never create users. `runs/routes.ts` drops its own `readGuest`/`ensureGuest` cookie code and uses `c.var.user`.

### Sign-in core: `finishSignIn`

`auth/signIn.ts` exports `finishSignIn(tx-capable db, { method, subject }, guestUserIds: string[], currentSessionId?)`. It runs in one transaction:

1. Find the identity by `(method, subject)`. If none exists, insert a user (`is_guest = false`) and the identity. A concurrent insert of the same identity hits the unique constraint; retry the lookup once.
2. **Claim** each distinct guest id that is not null, still exists and has `is_guest = true`, and is not the target user:
   - Move `playlists.user_id` and `llm_usage.user_id` to the target user.
   - Delete the guest's sessions and the guest user.
3. Delete the current session (if any) and insert a new session for the target user (prevents session fixation).

It returns `{ userId, token }`, and the route sets the cookie. Signing in while already signed in as another user simply switches accounts. The old user's playlists are not claimed, because only guests are claimed.

### Usage attribution after a claim

The executor captures `userId` when a run starts. A claim can delete that guest before the run finishes, so writing `llm_usage.user_id` from the captured id would fail the FK. `recordUsage` changes to take `runId` and inserts `user_id = (SELECT p.user_id FROM generation_runs r JOIN playlists p ON p.id = r.playlist_id WHERE r.id = $runId)`. The usage `kind` comes from the job: `'guest'` or `'user'`, decided by `user.isGuest` when the run is created.

### Endpoints

- `GET /api/me` → `{ user: null }` or `{ user: { id, isGuest, label } }`, where `label` is the email address, `"Apple ID"`, or `null` for guests.
- `POST /api/auth/signout` → deletes the current session row, clears the cookie, returns `204`. With no session it still returns `204`.

### CSRF

The session cookie is `SameSite=Lax`, so cross-site POSTs do not carry it. Every mutating endpoint also requires a JSON body (`content-type: application/json`), except sign-out, which has no body and is harmless.

## Magic link (slice B)

### Mailer

```ts
interface Mailer {
  sendLoginLink(args: { to: string; url: string }): Promise<void>;
}
```

- `console` adapter: logs `to` and `url`. It is the default, and the one used in dev and tests (tests use a capturing fake).
- `resend` adapter: `POST https://api.resend.com/emails` with `Authorization: Bearer RESEND_API_KEY` and body `{ from: EMAIL_FROM, to, subject, text, html }`, sent with an injected `fetch`. A non-2xx response throws.
- Email content: subject "Your Tunelynk sign-in link". Plain text and minimal HTML with one link, plus the line "This link expires in 15 minutes. If you didn't ask for it, ignore this email."

### `POST /api/auth/email/start`

Body `{ email, returnTo? }` (zod).

1. Validate and normalize `email` (trim, lowercase). Invalid → `400 invalid_email`.
2. Sanitize `returnTo`: keep it only if it starts with `/` and not `//` or `/\`; otherwise drop it. The same rule applies everywhere `returnTo` is accepted.
3. Rate limit: if 3 or more `login_tokens` for this email were created in the last 15 minutes → `429 too_many_requests`.
4. Insert a token row (`expires_at = now + 15 min`, `guest_user_id` = current user if it is a guest).
5. Send `${APP_URL}/signin/verify#t=<token>`. If sending throws, delete the row and return `502 email_failed`.
6. `202 {}`. The response does not reveal whether an account exists.

### `POST /api/auth/email/verify`

Body `{ token }`.

1. `UPDATE login_tokens SET used_at = now() WHERE token_hash = sha256($token) AND used_at IS NULL AND expires_at > now() RETURNING email, return_to, guest_user_id`. No row → `400 invalid_or_expired`.
2. `finishSignIn({ method: 'email', subject: email }, [guest_user_id], currentSessionId)`.
3. Set the cookie and return `200 { returnTo }` (default `/`).

Only the guest that requested the link is claimed. Claiming it through `guest_user_id` still covers a link opened in a different cookie jar, such as a phone mail app's in-app browser. The opening browser's own guest is never claimed: anyone could send someone their own sign-in link and take that person's guest drafts. (Changed during slice B review; it originally claimed both guests.)

### `POST /api/auth/email/preview` (slice D)

Body `{ token }`. Returns `200 { email }` for a valid, unused, unexpired token without consuming it. Otherwise it returns `400 invalid_or_expired`. The verify page uses it to ask "Continue as {email}?" before POSTing to verify, so a forwarded link can't silently sign someone into another person's account.

## Sign in with Apple (slice C)

### Apple Developer setup (manual)

1. An App ID, `com.bytmoor.tunelynk`, with Sign in with Apple enabled.
2. A Services ID, `com.bytmoor.tunelynk.web`, with Sign in with Apple configured: primary App ID from step 1, domain `tunelynk.bytmoor.com`, return URL `https://tunelynk.bytmoor.com/api/auth/apple/callback`.
3. Sign in with Apple enabled on the existing MusicKit key, with the primary App ID from step 1. If the portal does not allow editing that key, create a new key and set `APPLE_SIGNIN_KEY_ID` / `APPLE_SIGNIN_PRIVATE_KEY`.

Apple does not accept `localhost` return URLs. Local end-to-end testing needs an HTTPS tunnel whose domain and return URL are added to the Services ID; otherwise the real flow is verified on production.

### `GET /api/auth/apple/start?returnTo=`

1. Generate `state` and `nonce` (16 random bytes each, base64url).
2. Set the signed cookie `tl_apple` (`SESSION_SECRET`; httpOnly, Lax, Secure per env, path `/api/auth/apple`, 10 min) holding `{ state, nonce, returnTo }` as JSON.
3. `302` to `https://appleid.apple.com/auth/authorize` with `client_id=APPLE_SIGNIN_CLIENT_ID`, `redirect_uri=${APP_URL}/api/auth/apple/callback`, `response_type=code`, `response_mode=query`, `state`, `nonce`. No `scope`.

### `GET /api/auth/apple/callback?code&state` (or `?error=…`)

1. Read and clear `tl_apple`. If the cookie is missing, `error` is present, or `state` differs → fail.
2. Exchange the code: `POST https://appleid.apple.com/auth/token` (form-encoded) with `client_id`, `client_secret`, `code`, `grant_type=authorization_code`, `redirect_uri`. Non-2xx → fail.
3. `client_secret`: an ES256 JWT with header `{ alg: ES256, kid }`, claims `iss = APPLE_TEAM_ID`, `iat`, `exp = iat + 5 min`, `aud = https://appleid.apple.com`, `sub = APPLE_SIGNIN_CLIENT_ID`. It is signed with the Sign in with Apple key (by default the MusicKit key), and `APPLE_PRIVATE_KEY` formats are accepted as in #10.
4. Verify `id_token` with `jose`: JWKS from `https://appleid.apple.com/auth/keys` (`createRemoteJWKSet`, which caches and refetches on an unknown `kid`), `issuer = https://appleid.apple.com`, `audience = APPLE_SIGNIN_CLIENT_ID`, `exp` checked, and `nonce` claim equal to the cookie nonce. Failure → fail.
5. `finishSignIn({ method: 'apple', subject: sub }, [currentGuestId], currentSessionId)`, set the cookie, `302` to `returnTo` (default `/`).

**Fail** means: log the reason (never the code or tokens), then `302 /signin?error=apple`, keeping `returnTo` as a query parameter when known. User cancel (`error=user_cancelled_authorize`) takes the same path.

The Apple token URL, JWKS URL and `fetch` are injectable for tests.

## Keep and playlists (slice D, API)

- `RunResponse` adds `playlist.status` and `viewer: { isOwner: boolean, signedIn: boolean }`. `signedIn` is true only for a non-guest user. `GET /api/runs/:id` stays public.
- `POST /api/runs/:id/keep`:
  - No user or a guest → `401 sign_in_required`.
  - Run not found, or the caller does not own its playlist → `404 not_found`.
  - Run `published` → `200`, idempotent.
  - Run not `draft` → `409 not_keepable`.
  - Otherwise, in one transaction: run → `published`; playlist → `active` with `current_run_id = run`. Returns `200 { playlistId, runId }`.
- `GET /api/playlists`:
  - Non-guest only; otherwise `401 sign_in_required`.
  - Returns the caller's playlists with `status <> 'deleted'`, newest first: `{ playlists: [{ id, name, prompt, status, createdAt, latestRun: { id, status } | null }] }`.
  - `latestRun` is the newest run by `created_at`.
  - No pagination yet.
- New `ApiError` codes: `invalid_email`, `too_many_requests`, `email_failed`, `invalid_or_expired`, `sign_in_required`, `not_keepable`.
- Contracts live in `packages/shared/src/auth.ts` (`MeResponse`, `EmailStartRequest`, `EmailVerifyRequest`, `EmailVerifyResponse`) and `packages/shared/src/playlists.ts` (`PlaylistsResponse`, `KeepResponse`). `ApiError` is extended in place.

## Web (slice D)

### Data layer

Hand-rolled, following `lib/api.ts`: each wrapper zod-parses the response and returns a typed result union, the same shape as `createRun`.

- New wrappers: `fetchMe`, `startEmailSignIn`, `verifyEmailToken`, `signOut`, `keepRun`, `fetchPlaylists`.
- `MeProvider` (React context at `App`) fetches `/api/me` once and exposes `{ me, loading, refresh }`. If that fetch fails, the app renders as signed out with no banner.
- `useRun` gains `refetch()`.
- `useKeep(runId)` returns `{ keep, pending, error, kept }`. On success it calls the run's `refetch()`.
- `usePlaylists()` fetches when signed in and refetches when the `me` user id changes.

### Screens

- **TopBar.** The right side shows a **Sign in** link (`/signin?returnTo=<current path>`) or the account label with a **Sign out** action. Sign out calls the API, then `refresh()`. If the call fails, the app clears `me` locally anyway and logs the error.
- **`/signin`.**
  - Email form. Client-side zod validation shows "Enter a valid email address." inline, and submit stays disabled until the address is valid. Success → `/signin/check-email?email=…&returnTo=…`.
  - **Sign in with Apple** button: a plain link to `/api/auth/apple/start?returnTo=…`, shown only when `GET /api/auth/providers` reports `apple: true`.
  - `?error=apple` shows a banner, then is removed from the URL.
- **`/signin/check-email`.** "Check your inbox at {email}." with a **Resend** button. Success shows a muted "Sent again."
- **`/signin/verify`.**
  1. Reads `#t`, then clears the hash with `history.replaceState`.
  2. Calls `preview` and shows "Continue as {email}?" with **Continue** and **Cancel**.
  3. **Continue** POSTs the token, showing "Signing you in…".
  4. Success → `refresh()`, then navigate to `returnTo`.
- **Run view footer (draft).**
  - No user or a guest: **Sign in to keep** → `/signin?returnTo=/playlists/:p/runs/:r?keep=1`.
  - Signed-in owner: **Keep** (busy label "Keeping…") → "Kept ✓".
  - Already published: "Kept ✓".
  - Non-owner: no button.
  - `?keep=1` with a signed-in owner and a draft run triggers one automatic keep, then the parameter is removed. A failure there shows the Keep error and does not retry.
- **`/` signed in.** The same prompt hero, plus **Your playlists** below it: name, prompt, a Draft/Kept badge (from `status`: `draft` → Draft, `active` → Kept), and a link to the latest run. Empty state: "Generate your first playlist." Styled to match the #10 visual grid. No UI spike.

### Error display

Errors use the existing `ErrorBanner`, which gains an optional `linkLabel` prop (its link text is hardcoded "Open it" today). API codes map to copy in one place, `AUTH_ERRORS` in `lib/api.ts`, next to the existing `CREATE_ERRORS`. Raw codes and server details are never shown.

| Where | Trigger | Shown |
|---|---|---|
| `/signin` email | invalid address (client) | Inline: "Enter a valid email address." |
| `/signin` email, check-email Resend | `429 too_many_requests` | Banner: "Too many sign-in links. Try again in 15 minutes." |
| same | `502 email_failed` | Banner: "Couldn't send the email. Try again, or sign in with Apple." |
| same | network | Banner: "Couldn't reach Tunelynk. Check your connection and try again." |
| `/signin?error=apple` | any Apple failure or cancel | Banner: "Apple sign-in didn't complete. Try again or use email." |
| `/signin/verify` | `400 invalid_or_expired`, or no `#t` | Full-page state: "This link expired or was already used." + **Send a new link** (→ `/signin`, keeping `returnTo`) |
| `/signin/verify` | network | Banner + **Retry** |
| Run view Keep | `401 sign_in_required` | Button becomes **Sign in to keep**; banner: "Your session ended. Sign in again to keep this playlist." |
| Run view Keep | `409`, `404`, network, 5xx | Banner: "Couldn't keep this playlist. Try again." Button re-enabled |
| `/` Your playlists | fetch fails | Inline muted line: "Couldn't load your playlists." + **Retry**; the prompt still works |
| `GET /api/me` on boot | fails | Render as signed out, no banner |

Buttons show busy labels and stay disabled while a request is in flight, as `TopBar`'s `busyLabel` does today.

## Env additions

| Var | Default | Notes |
|---|---|---|
| `APP_URL` | required | Public origin, no trailing slash: `https://tunelynk.bytmoor.com`; local `http://localhost:5173` (the Vite dev server, which proxies `/api`) |
| `EMAIL_PROVIDER` | `console` only when `COOKIE_SECURE=false` | `console` or `resend`. Required when `COOKIE_SECURE=true` (production), so a missing value never silently logs live links |
| `RESEND_API_KEY` | — | Required when `EMAIL_PROVIDER=resend` |
| `EMAIL_FROM` | — | Required when `EMAIL_PROVIDER=resend`, e.g. `Tunelynk <login@bytmoor.com>` |
| `APPLE_SIGNIN_CLIENT_ID` | — (Apple sign-in off) | The Services ID, e.g. `com.bytmoor.tunelynk.web`. Optional since 2026-10-06 (the Apple Developer membership lapsed): unset ⇒ Apple routes redirect to `/signin?error=apple` and `GET /api/auth/providers` returns `{ email: true, apple: false }` |
| `APPLE_SIGNIN_KEY_ID` | `APPLE_KEY_ID` | Override to use a separate Sign in with Apple key |
| `APPLE_SIGNIN_PRIVATE_KEY` | `APPLE_PRIVATE_KEY` | Same formats as `APPLE_PRIVATE_KEY` |

`APP_URL` is added in slice B, and `APPLE_SIGNIN_*` in slice C. `docs/deploy.md` and `.env.example` are updated in the slice that adds each variable. Because env validation exits at boot, production env must be set before each slice merges (see `docs/deploy.md`).

Resend setup (manual, before slice B deploys): create the account, verify the sending domain `bytmoor.com` (SPF and DKIM DNS records), and create an API key with sending access.

## Error handling

| Failure | Behavior |
|---|---|
| Invalid email | `400 invalid_email` |
| More than 3 links per email in 15 min | `429 too_many_requests` |
| Mail send fails | `502 email_failed`, token row deleted, error logged |
| Expired, used, or unknown magic token | `400 invalid_or_expired` |
| Concurrent verify of one token | Atomic `UPDATE … WHERE used_at IS NULL`: one wins, the other gets `400` |
| Concurrent first sign-in with one identity | Unique `(method, subject)`; lookup retried once |
| Apple cancel, state mismatch, exchange or id_token failure | `302 /signin?error=apple`, reason logged without secrets |
| Apple JWKS rotation | `jose` refetches on an unknown `kid`; failure handled as above |
| Unsafe `returnTo` | Dropped; defaults to `/` |
| Legacy `tl_guest` | Upgraded to a session, cookie removed |
| Invalid or expired `tl_session` | Cleared; request continues signed out |
| Run finishes after its guest was claimed | Usage attributed to the playlist's current owner |
| Keep by guest / non-owner / wrong status | `401` / `404` / `409` |

## Testing

TDD within each slice. Tests stay next to the code (#29 moves them later).

- **A (sessions):**
  - Unit: token generation and hashing, cookie options, `returnTo` sanitizer.
  - Postgres integration:
    - session create, resolve and expiry; sliding renewal
    - legacy `tl_guest` upgrade
    - `GET /api/me` for each state; sign out
    - `finishSignIn`: new user, existing identity, claim of 0, 1 and 2 guests, a non-guest id is never claimed, session rotation
    - existing runs tests still pass through the new middleware
    - usage recorded after its guest was claimed
- **B (magic link):**
  - Resend adapter with an injected `fetch` (request shape, non-2xx throws).
  - Integration with a capturing mailer:
    - start → link → verify → `/api/me` signed in
    - rate limit; reuse and expiry
    - `returnTo` sanitizing
    - claim through `guest_user_id` from another cookie jar
    - the opening browser's guest is never claimed for a link it didn't request
    - mail failure deletes the token
    - the response is the same for new and existing emails
- **C (Apple):**
  - The client-secret JWT signed with a generated P-256 key verifies with its public key.
  - id_token verification against a local JWKS (generated RSA key): wrong `aud`, `iss`, expired, nonce mismatch, unknown `kid`.
  - Callback integration with fake Apple endpoints: state mismatch, missing cookie, `error=user_cancelled_authorize`, exchange failure, success with guest claim.
- **D (Keep + web):**
  - Shared contract tests.
  - Keep and playlists integration tests (401, 404, 409, idempotent, ordering, `latestRun`).
  - Testing Library:
    - signin, check-email, verify (success, expired, no hash, network)
    - TopBar signed out and signed in
    - run view footer variants, including `?keep=1`
    - landing list and its error state
    - each row of the error display table
- **Done when:** the success criteria hold on production. Before the PR, run an e2e check against the built bundle and a manual browser check.

## Slices

| Slice | PR delivers | Checkpoint |
|---|---|---|
| A | Migration; session middleware + legacy upgrade; `finishSignIn` + claim; usage attribution by run; `/api/me`; sign out | Guest generate unchanged locally; legacy cookie upgraded; integration tests green |
| B | `Mailer` (console, Resend); email start/verify; rate limit; `APP_URL`, `EMAIL_*` env; deploy docs | `curl` start → console link → verify → `/api/me` signed in with guest drafts moved |
| C | Apple start/callback; client secret; id_token verification (`jose`); `APPLE_SIGNIN_*` env; deploy docs incl. portal setup | Fake-Apple integration tests green; real Apple login on production after merge |
| D | Keep, `GET /api/playlists`, `RunResponse.viewer`; sign-in pages, account menu, run view Keep, landing list | Issue #11 done-when on production |
