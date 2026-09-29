# Tunelynk

Playlist creation, generation, and cross-platform transfer app.

## Domain check (2026-09-29)
- tunelynk.com — available (unregistered)
- App Store / Play Store — no exact name collision. Closest neighbor: "TuneLink" (iOS, music-link converter) — different name/spelling, low confusion risk but worth a glance at launch.

## Core features

### 1. Create
- Manual playlist builder: search tracks across connected services, add/reorder/remove.
- Collaborative playlists (multi-user add/edit).

### 2. Generate
- Prompt-based generation ("upbeat 90s road trip") → AI-curated tracklist.
- Seed-based generation: from an artist, existing playlist, or listening history → similar-vibe playlist.
- Mood/activity presets (workout, focus, sleep, party).

### 3. Transfer
- Cross-platform sync: Spotify ↔ Apple Music ↔ YouTube Music ↔ Deezer ↔ Amazon Music (start with Spotify + Apple Music + YouTube Music).
- Import via link/CSV (Exportify-style) for one-off transfers.
- Track matching: fuzzy match by title/artist/ISRC, flag unmatched tracks for manual resolution.
- One-way (copy) vs two-way (ongoing sync) modes.

## Tech stack (proposed)
- Backend: Node/TypeScript or Python (FastAPI) — needs OAuth against multiple streaming APIs.
- Track matching: ISRC-first, fallback fuzzy string match (title+artist+duration).
- Frontend: React/React Native (mobile-first, web companion).
- Auth: OAuth2 per-platform (Spotify Web API, Apple MusicKit, YouTube Data API, etc.).
- Storage: Postgres for user/playlist/mapping data.

## Platform API constraints to check early
- Apple MusicKit requires paid Apple Developer account + user must have Apple Music subscription.
- Spotify API playlist write scopes require app review for >25 users (extended quota mode).
- YouTube Music has no official public API — likely needs unofficial client (ytmusicapi) or scraping, which carries ToS risk.

## Open questions
- Monetization: free tier limits (transfers/month) vs subscription?
- Real-time two-way sync vs on-demand transfer — scope for v1?
- Which platforms are must-have for launch vs later?

## Next steps
- [ ] Register tunelynk.com
- [ ] Reserve app store listing names (Apple/Google dev accounts)
- [ ] Spike: YouTube Music unofficial API viability + ToS risk
- [ ] Spike: Spotify + Apple Music OAuth flow end-to-end
- [ ] Wireframe create/generate/transfer flows
