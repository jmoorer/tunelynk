import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const playlistKind = pgEnum("playlist_kind", [
  "one_off",
  "recurring",
  "triggered",
]);
export const playlistStatus = pgEnum("playlist_status", [
  "draft",
  "active",
  "paused",
  "deleted",
]);
export const runTrigger = pgEnum("run_trigger", [
  "manual",
  "schedule",
  "event",
]);
export const runStatus = pgEnum("run_status", [
  "queued",
  "running",
  "draft",
  "published",
  "failed",
  "expired",
]);
export const runStage = pgEnum("run_stage", ["taste", "llm", "matching"]);
export const trackSource = pgEnum("track_source", ["llm", "backfill"]);
export const usageKind = pgEnum("usage_kind", ["guest", "user", "scheduled"]);
export const authMethod = pgEnum("auth_method", ["email", "apple"]);

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name"),
  isGuest: boolean("is_guest").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: createdAt(),
});

export const playlists = pgTable(
  "playlists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    length: integer("length").notNull(),
    discovery: integer("discovery").notNull().default(50),
    kind: playlistKind("kind").notNull().default("one_off"),
    status: playlistStatus("status").notNull().default("draft"),
    // No FK: playlists ↔ runs would be circular. The run executor sets it.
    currentRunId: uuid("current_run_id"),
    createdAt: createdAt(),
  },
  (t) => [index("playlists_user_id_idx").on(t.userId)],
);

export type RunCandidate = {
  title: string;
  artist: string;
  status: "matched" | "unmatched" | "duplicate" | "error";
  appleSongId?: string;
};

export const generationRuns = pgTable(
  "generation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playlistId: uuid("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    trigger: runTrigger("trigger").notNull().default("manual"),
    status: runStatus("status").notNull().default("queued"),
    stage: runStage("stage"),
    error: text("error"),
    llmModel: text("llm_model").notNull(),
    candidates: jsonb("candidates")
      .$type<RunCandidate[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("generation_runs_playlist_id_idx").on(t.playlistId),
    index("generation_runs_status_idx").on(t.status),
  ],
);

export const tracks = pgTable("tracks", {
  id: uuid("id").primaryKey().defaultRandom(),
  appleSongId: text("apple_song_id").notNull().unique(),
  isrc: text("isrc"),
  title: text("title").notNull(),
  artistName: text("artist_name").notNull(),
  album: text("album").notNull(),
  durationMs: integer("duration_ms").notNull(),
  explicit: boolean("explicit").notNull(),
  artworkUrl: text("artwork_url"),
  previewUrl: text("preview_url"),
});

export const runTracks = pgTable(
  "run_tracks",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => generationRuns.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id),
    source: trackSource("source").notNull(),
    removed: boolean("removed").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.runId, t.position] })],
);

export const llmUsage = pgTable(
  "llm_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull(),
    kind: usageKind("kind").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("llm_usage_created_at_idx").on(t.createdAt)],
);

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
