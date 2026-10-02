CREATE TYPE "public"."playlist_kind" AS ENUM('one_off', 'recurring', 'triggered');--> statement-breakpoint
CREATE TYPE "public"."playlist_status" AS ENUM('draft', 'active', 'paused', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."run_stage" AS ENUM('taste', 'llm', 'matching');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'draft', 'published', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('manual', 'schedule', 'event');--> statement-breakpoint
CREATE TYPE "public"."track_source" AS ENUM('llm', 'backfill');--> statement-breakpoint
CREATE TYPE "public"."usage_kind" AS ENUM('guest', 'user', 'scheduled');--> statement-breakpoint
CREATE TABLE "generation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playlist_id" uuid NOT NULL,
	"trigger" "run_trigger" DEFAULT 'manual' NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"stage" "run_stage",
	"error" text,
	"llm_model" text NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_micros" bigint NOT NULL,
	"kind" "usage_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"length" integer NOT NULL,
	"discovery" integer DEFAULT 50 NOT NULL,
	"kind" "playlist_kind" DEFAULT 'one_off' NOT NULL,
	"status" "playlist_status" DEFAULT 'draft' NOT NULL,
	"current_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_tracks" (
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"track_id" uuid NOT NULL,
	"source" "track_source" NOT NULL,
	"removed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "run_tracks_run_id_position_pk" PRIMARY KEY("run_id","position")
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"apple_song_id" text NOT NULL,
	"isrc" text,
	"title" text NOT NULL,
	"artist_name" text NOT NULL,
	"album" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"explicit" boolean NOT NULL,
	"artwork_url" text,
	"preview_url" text,
	CONSTRAINT "tracks_apple_song_id_unique" UNIQUE("apple_song_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text,
	"is_guest" boolean NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tracks" ADD CONSTRAINT "run_tracks_run_id_generation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."generation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tracks" ADD CONSTRAINT "run_tracks_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generation_runs_playlist_id_idx" ON "generation_runs" USING btree ("playlist_id");--> statement-breakpoint
CREATE INDEX "generation_runs_status_idx" ON "generation_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "llm_usage_created_at_idx" ON "llm_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "playlists_user_id_idx" ON "playlists" USING btree ("user_id");