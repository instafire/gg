-- GG Phase 1 slice 1 — hand-written additions (D-013).
-- Extensions must exist before the posts table (ltree path column).
CREATE EXTENSION IF NOT EXISTS "ltree";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE TYPE "public"."author_type" AS ENUM('human', 'agent');--> statement-breakpoint
CREATE TYPE "public"."community_visibility" AS ENUM('public', 'restricted', 'private');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('reply', 'mention', 'follow', 'vote_digest', 'debate_challenge', 'debate_turn', 'poll_closing', 'mod_action', 'dm_request', 'system');--> statement-breakpoint
CREATE TYPE "public"."post_type" AS ENUM('TEXT', 'IMAGE', 'CAROUSEL', 'VIDEO', 'REEL', 'LINK', 'POLL', 'DEBATE', 'STORY');--> statement-breakpoint
CREATE TYPE "public"."post_visibility" AS ENUM('public', 'followers', 'community', 'close_friends', 'private');--> statement-breakpoint
CREATE TYPE "public"."reaction_kind" AS ENUM('like', 'insightful', 'funny', 'agree', 'disagree');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'triaged', 'actioned', 'dismissed', 'appealed', 'closed');--> statement-breakpoint
CREATE TYPE "public"."trust_tier" AS ENUM('T0', 'T1', 'T2', 'T3');--> statement-breakpoint
CREATE TABLE "blocks" (
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id")
);
--> statement-breakpoint
CREATE TABLE "bookmarks" (
	"user_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"collection_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookmarks_user_id_post_id_pk" PRIMARY KEY("user_id","post_id")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"cover_media_id" uuid,
	"item_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"about_md" text,
	"icon_media_id" uuid,
	"banner_media_id" uuid,
	"creator_id" uuid NOT NULL,
	"visibility" "community_visibility" DEFAULT 'public' NOT NULL,
	"is_nsfw" boolean DEFAULT false NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"post_count" integer DEFAULT 0 NOT NULL,
	"topics" text[] DEFAULT '{}' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"lockdown_at" timestamp with time zone,
	"lockdown_by" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "community_members" (
	"community_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"muted_until" timestamp with time zone,
	"banned_reason" text,
	"flair_id" uuid,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_members_community_id_user_id_pk" PRIMARY KEY("community_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "community_moderators" (
	"community_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_moderators_community_id_user_id_pk" PRIMARY KEY("community_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"follower_id" uuid NOT NULL,
	"followee_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_follower_id_followee_id_pk" PRIMARY KEY("follower_id","followee_id")
);
--> statement-breakpoint
CREATE TABLE "mutes" (
	"muter_id" uuid NOT NULL,
	"muted_id" uuid NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mutes_muter_id_muted_id_pk" PRIMARY KEY("muter_id","muted_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recipient_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"actor_id" uuid,
	"subject_type" text,
	"subject_id" uuid,
	"group_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"short_code" text NOT NULL,
	"author_id" uuid NOT NULL,
	"author_type" "author_type" NOT NULL,
	"type" "post_type" NOT NULL,
	"parent_id" uuid,
	"quoted_post_id" uuid,
	"repost_of_id" uuid,
	"root_id" uuid NOT NULL,
	"path" "ltree" NOT NULL,
	"path_label" text NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"community_id" uuid,
	"title" text,
	"body_md" text,
	"body_html" text,
	"link_url" text,
	"link_card" jsonb,
	"flair_id" uuid,
	"language" text,
	"visibility" "post_visibility" DEFAULT 'public' NOT NULL,
	"is_nsfw" boolean DEFAULT false NOT NULL,
	"is_spoiler" boolean DEFAULT false NOT NULL,
	"is_long_form" boolean DEFAULT false NOT NULL,
	"contains_ai_media" boolean DEFAULT false NOT NULL,
	"reply_policy" text DEFAULT 'everyone' NOT NULL,
	"up_count" integer DEFAULT 0 NOT NULL,
	"down_count" integer DEFAULT 0 NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"repost_count" integer DEFAULT 0 NOT NULL,
	"quote_count" integer DEFAULT 0 NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"save_count" integer DEFAULT 0 NOT NULL,
	"reaction_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hot_rank" double precision,
	"hot_rank_at" timestamp with time zone,
	"controversy_rank" double precision,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"pinned_by" uuid,
	"is_locked" boolean DEFAULT false NOT NULL,
	"removed_by" uuid,
	"removal_reason" text,
	"delete_reason" jsonb,
	"edited_at" timestamp with time zone,
	"edit_count" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"bio" text,
	"bio_long" text,
	"avatar_media_id" uuid,
	"banner_media_id" uuid,
	"website_url" text,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pronouns" text,
	"location_text" text,
	"is_private" boolean DEFAULT false NOT NULL,
	"pinned_post_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"kind" "reaction_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"rotated_at" timestamp with time zone,
	"replaced_by_id" uuid,
	"revoked_at" timestamp with time zone,
	"device_label" text,
	"ip" text,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reporter_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"details" text,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"severity" integer DEFAULT 2 NOT NULL,
	"assigned_to" uuid,
	"sla_due_at" timestamp with time zone,
	"resolution" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"hide_ai_accounts" boolean DEFAULT false NOT NULL,
	"hide_nsfw" boolean DEFAULT true NOT NULL,
	"dm_policy" text DEFAULT 'everyone' NOT NULL,
	"mention_policy" text DEFAULT 'everyone' NOT NULL,
	"read_receipts" boolean DEFAULT true NOT NULL,
	"presence_visible" boolean DEFAULT false NOT NULL,
	"captions_default_on" boolean DEFAULT false NOT NULL,
	"demographic_breakdowns_opt_in" boolean DEFAULT false NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"notification_prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quiet_hours" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"email" text,
	"email_verified_at" timestamp with time zone,
	"author_type" "author_type" DEFAULT 'human' NOT NULL,
	"trust_tier" "trust_tier" DEFAULT 'T0' NOT NULL,
	"date_of_birth" date,
	"is_minor_restricted" boolean DEFAULT false NOT NULL,
	"age_bracket" text DEFAULT 'unknown' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"owner_id" uuid,
	"locale" text DEFAULT 'en' NOT NULL,
	"timezone" text,
	"follower_count" integer DEFAULT 0 NOT NULL,
	"following_count" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vote_audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vote_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"vote_id" uuid,
	"voter_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"old_value" smallint,
	"new_value" smallint,
	"change_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"voter_id" uuid NOT NULL,
	"author_type" "author_type" NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"value" smallint NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communities" ADD CONSTRAINT "communities_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communities" ADD CONSTRAINT "communities_lockdown_by_users_id_fk" FOREIGN KEY ("lockdown_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_members" ADD CONSTRAINT "community_members_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_members" ADD CONSTRAINT "community_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_moderators" ADD CONSTRAINT "community_moderators_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_moderators" ADD CONSTRAINT "community_moderators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_moderators" ADD CONSTRAINT "community_moderators_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_followee_id_users_id_fk" FOREIGN KEY ("followee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutes" ADD CONSTRAINT "mutes_muter_id_users_id_fk" FOREIGN KEY ("muter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutes" ADD CONSTRAINT "mutes_muted_id_users_id_fk" FOREIGN KEY ("muted_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_pinned_by_users_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_voter_id_users_id_fk" FOREIGN KEY ("voter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocks_blocked_idx" ON "blocks" USING btree ("blocked_id");--> statement-breakpoint
CREATE INDEX "bookmarks_user_created_idx" ON "bookmarks" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "communities_slug_unique" ON "communities" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "communities_member_count_idx" ON "communities" USING btree ("member_count");--> statement-breakpoint
CREATE INDEX "community_members_user_idx" ON "community_members" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "community_members_role_idx" ON "community_members" USING btree ("community_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "community_members_one_owner" ON "community_members" USING btree ("community_id") WHERE "community_members"."role" = 'owner';--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_user_unique" ON "credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "follows_followee_idx" ON "follows" USING btree ("followee_id","created_at");--> statement-breakpoint
CREATE INDEX "follows_follower_idx" ON "follows" USING btree ("follower_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("recipient_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_recipient_unread_idx" ON "notifications" USING btree ("recipient_id","created_at") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "posts_short_code_unique" ON "posts" USING btree ("short_code");--> statement-breakpoint
CREATE INDEX "posts_community_hot_idx" ON "posts" USING btree ("community_id","hot_rank") WHERE "posts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "posts_community_created_idx" ON "posts" USING btree ("community_id","created_at");--> statement-breakpoint
CREATE INDEX "posts_author_created_idx" ON "posts" USING btree ("author_id","created_at");--> statement-breakpoint
CREATE INDEX "posts_parent_idx" ON "posts" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "posts_root_idx" ON "posts" USING btree ("root_id");--> statement-breakpoint
CREATE INDEX "posts_path_gist_idx" ON "posts" USING gist ("path");--> statement-breakpoint
CREATE INDEX "posts_explore_idx" ON "posts" USING btree ("created_at") WHERE "posts"."visibility" = 'public' and "posts"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "reactions_unique" ON "reactions" USING btree ("user_id","target_type","target_id","kind");--> statement-breakpoint
CREATE INDEX "reactions_target_idx" ON "reactions" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_hash_unique" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "reports_queue_idx" ON "reports" USING btree ("status","severity","created_at");--> statement-breakpoint
CREATE INDEX "reports_target_idx" ON "reports" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_handle_unique" ON "users" USING btree ("handle");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email") WHERE "users"."email" is not null;--> statement-breakpoint
CREATE INDEX "users_owner_idx" ON "users" USING btree ("owner_id") WHERE "users"."author_type" = 'agent';--> statement-breakpoint
CREATE INDEX "users_trust_created_idx" ON "users" USING btree ("trust_tier","created_at");--> statement-breakpoint
CREATE INDEX "vote_audit_target_idx" ON "vote_audit" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "vote_audit_voter_idx" ON "vote_audit" USING btree ("voter_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "votes_voter_target_unique" ON "votes" USING btree ("voter_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "votes_target_idx" ON "votes" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "votes_voter_created_idx" ON "votes" USING btree ("voter_id","created_at");
-- ─── Hand-written: posts self-referencing FKs (D-013) ───────────────────
-- Drizzle cannot declare a self-FK on the table being defined for root_id
-- (a top-level post's root is itself; Postgres checks the FK at statement
-- end, so self-referencing inserts are legal).
ALTER TABLE "posts" ADD CONSTRAINT "posts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_root_fk" FOREIGN KEY ("root_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_quoted_fk" FOREIGN KEY ("quoted_post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_repost_fk" FOREIGN KEY ("repost_of_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Agent accounts must have an accountable owner; humans must not (DATA_MODEL §2.1).
ALTER TABLE "users" ADD CONSTRAINT "users_owner_matches_type" CHECK (("author_type" = 'agent') = ("owner_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_value_check" CHECK ("value" IN (1, -1));--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_no_self" CHECK ("follower_id" <> "followee_id");--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_no_self" CHECK ("blocker_id" <> "blocked_id");--> statement-breakpoint
ALTER TABLE "mutes" ADD CONSTRAINT "mutes_no_self" CHECK ("muter_id" <> "muted_id");--> statement-breakpoint
-- ─── updated_at maintenance (DATA_MODEL §0.2) ────────────────────────────
CREATE OR REPLACE FUNCTION gg_set_updated_at() RETURNS trigger AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON "users" FOR EACH ROW EXECUTE FUNCTION gg_set_updated_at();--> statement-breakpoint
CREATE TRIGGER profiles_set_updated_at BEFORE UPDATE ON "profiles" FOR EACH ROW EXECUTE FUNCTION gg_set_updated_at();--> statement-breakpoint
CREATE TRIGGER credentials_set_updated_at BEFORE UPDATE ON "credentials" FOR EACH ROW EXECUTE FUNCTION gg_set_updated_at();--> statement-breakpoint
CREATE TRIGGER communities_set_updated_at BEFORE UPDATE ON "communities" FOR EACH ROW EXECUTE FUNCTION gg_set_updated_at();--> statement-breakpoint
CREATE TRIGGER posts_set_updated_at BEFORE UPDATE ON "posts" FOR EACH ROW EXECUTE FUNCTION gg_set_updated_at();--> statement-breakpoint
CREATE TRIGGER votes_set_updated_at BEFORE UPDATE ON "votes" FOR EACH ROW EXECUTE FUNCTION gg_set_updated_at();--> statement-breakpoint
CREATE TRIGGER user_settings_set_updated_at BEFORE UPDATE ON "user_settings" FOR EACH ROW EXECUTE FUNCTION gg_set_updated_at();--> statement-breakpoint
CREATE TRIGGER collections_set_updated_at BEFORE UPDATE ON "collections" FOR EACH ROW EXECUTE FUNCTION gg_set_updated_at();--> statement-breakpoint
CREATE TRIGGER reports_set_updated_at BEFORE UPDATE ON "reports" FOR EACH ROW EXECUTE FUNCTION gg_set_updated_at();--> statement-breakpoint
-- ─── author_type is immutable (DATA_MODEL §0.6 hard invariant) ────────────
CREATE OR REPLACE FUNCTION gg_users_author_type_immutable() RETURNS trigger AS $fn$
BEGIN
  IF NEW.author_type <> OLD.author_type THEN
    RAISE EXCEPTION 'users.author_type is immutable';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER users_author_type_immutable BEFORE UPDATE ON "users" FOR EACH ROW EXECUTE FUNCTION gg_users_author_type_immutable();--> statement-breakpoint
-- ─── No self-votes on posts (DATA_MODEL §5.5; CHECKs cannot subquery) ─────
CREATE OR REPLACE FUNCTION gg_votes_no_self() RETURNS trigger AS $fn$
DECLARE
  target_author uuid;
BEGIN
  IF NEW.target_type = 'post' THEN
    SELECT author_id INTO target_author FROM posts WHERE id = NEW.target_id;
    IF target_author IS NOT NULL AND target_author = NEW.voter_id THEN
      RAISE EXCEPTION 'users cannot vote on their own posts';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER votes_no_self BEFORE INSERT OR UPDATE ON "votes" FOR EACH ROW EXECUTE FUNCTION gg_votes_no_self();
