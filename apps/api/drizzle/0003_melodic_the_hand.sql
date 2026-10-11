CREATE TYPE "public"."context_note_rating" AS ENUM('helpful', 'somewhat', 'not_helpful');--> statement-breakpoint
CREATE TYPE "public"."context_note_status" AS ENUM('pending', 'helpful', 'not_helpful', 'needs_more_ratings');--> statement-breakpoint
CREATE TYPE "public"."debate_challenge_status" AS ENUM('pending', 'accepted', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."debate_format" AS ENUM('open', 'structured_1v1', 'team');--> statement-breakpoint
CREATE TYPE "public"."debate_round_kind" AS ENUM('opening', 'rebuttal', 'cross', 'closing', 'freeform');--> statement-breakpoint
CREATE TYPE "public"."debate_round_status" AS ENUM('pending', 'active', 'submitted', 'missed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."debate_status" AS ENUM('draft', 'open', 'live', 'awaiting_turn', 'closed', 'archived', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."evidence_kind" AS ENUM('study', 'news', 'data', 'personal_experience', 'other');--> statement-breakpoint
CREATE TYPE "public"."poll_flag_status" AS ENUM('open', 'reviewed', 'actioned');--> statement-breakpoint
CREATE TYPE "public"."poll_result_mode" AS ENUM('live', 'after_vote', 'after_close');--> statement-breakpoint
CREATE TYPE "public"."poll_type" AS ENUM('single', 'multiple', 'ranked', 'stance_slider', 'image', 'hot_take');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_note_ratings" (
	"note_id" uuid NOT NULL,
	"rater_id" uuid NOT NULL,
	"rating" "context_note_rating" NOT NULL,
	"rater_viewpoint_cluster" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_note_ratings_note_id_rater_id_pk" PRIMARY KEY("note_id","rater_id")
);
--> statement-breakpoint
CREATE TABLE "context_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"post_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"author_type" "author_type" NOT NULL,
	"body" text NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "context_note_status" DEFAULT 'pending' NOT NULL,
	"helpful_from_pos" integer DEFAULT 0 NOT NULL,
	"helpful_from_neg" integer DEFAULT 0 NOT NULL,
	"rating_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_pulse_questions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"type" "poll_type" DEFAULT 'single' NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scheduled_date" date,
	"used_date" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "arguments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"debate_id" uuid NOT NULL,
	"side_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"author_type" "author_type" NOT NULL,
	"round_id" uuid,
	"parent_argument_id" uuid,
	"body_md" text NOT NULL,
	"body_html" text NOT NULL,
	"claim" text,
	"is_opening" boolean DEFAULT false NOT NULL,
	"is_steelman" boolean DEFAULT false NOT NULL,
	"steelman_confirmed_by" uuid,
	"up_count" integer DEFAULT 0 NOT NULL,
	"down_count" integer DEFAULT 0 NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"human_up_count" integer DEFAULT 0 NOT NULL,
	"human_down_count" integer DEFAULT 0 NOT NULL,
	"agent_up_count" integer DEFAULT 0 NOT NULL,
	"agent_down_count" integer DEFAULT 0 NOT NULL,
	"evidence_quality" double precision DEFAULT 0 NOT NULL,
	"fallacy_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"removed_by" uuid,
	"removal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "debate_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"debate_id" uuid NOT NULL,
	"challenger_id" uuid NOT NULL,
	"challenged_id" uuid NOT NULL,
	"side_key" text NOT NULL,
	"message" text,
	"status" "debate_challenge_status" DEFAULT 'pending' NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debate_participants" (
	"debate_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"side_id" uuid NOT NULL,
	"role" text DEFAULT 'debater' NOT NULL,
	"elo_at_start" integer,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "debate_participants_debate_id_user_id_pk" PRIMARY KEY("debate_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "debate_rating_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"debate_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"rating_after" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debate_ratings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"rating" integer DEFAULT 1200 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"draws" integer DEFAULT 0 NOT NULL,
	"debates_count" integer DEFAULT 0 NOT NULL,
	"peak_rating" integer DEFAULT 1200 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debate_rounds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"debate_id" uuid NOT NULL,
	"round_no" integer NOT NULL,
	"kind" "debate_round_kind" DEFAULT 'freeform' NOT NULL,
	"side_id" uuid,
	"turn_user_id" uuid,
	"starts_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"status" "debate_round_status" DEFAULT 'pending' NOT NULL,
	"argument_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debate_sides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"debate_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"short_code" text NOT NULL,
	"post_id" uuid NOT NULL,
	"proposition" text NOT NULL,
	"format" "debate_format" NOT NULL,
	"status" "debate_status" DEFAULT 'open' NOT NULL,
	"community_id" uuid,
	"source_article_url" text,
	"host_id" uuid NOT NULL,
	"judge_id" uuid,
	"turn_deadline_hours" integer DEFAULT 24 NOT NULL,
	"live_turn_seconds" integer,
	"per_turn_char_limit" integer DEFAULT 2000 NOT NULL,
	"scheduled_start_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"winner_side_id" uuid,
	"is_draw" boolean DEFAULT false NOT NULL,
	"winner_formula" jsonb DEFAULT '{"argument_votes":0.5,"mind_change":0.35,"evidence_quality":0.15}'::jsonb NOT NULL,
	"winner_details" jsonb,
	"mind_changed_count" integer DEFAULT 0 NOT NULL,
	"mind_change_rate" double precision DEFAULT 0 NOT NULL,
	"audience_pre_count" integer DEFAULT 0 NOT NULL,
	"audience_post_count" integer DEFAULT 0 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"argument_id" uuid NOT NULL,
	"url" text NOT NULL,
	"kind" "evidence_kind" DEFAULT 'other' NOT NULL,
	"quote" text,
	"preview" jsonb,
	"domain" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poll_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"poll_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "poll_flag_status" DEFAULT 'open' NOT NULL,
	"reviewed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poll_options" (
	"id" uuid PRIMARY KEY NOT NULL,
	"poll_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"media_id" uuid,
	"vote_count" integer DEFAULT 0 NOT NULL,
	"agent_vote_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poll_vote_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"poll_id" uuid NOT NULL,
	"voter_id" uuid NOT NULL,
	"change_kind" text NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb,
	"actor_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poll_vote_choices" (
	"poll_vote_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	CONSTRAINT "poll_vote_choices_poll_vote_id_option_id_pk" PRIMARY KEY("poll_vote_id","option_id")
);
--> statement-breakpoint
CREATE TABLE "poll_votes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"poll_id" uuid NOT NULL,
	"voter_id" uuid NOT NULL,
	"author_type" "author_type" NOT NULL,
	"option_id" uuid,
	"ranking" uuid[],
	"slider_value" smallint,
	"voter_age_bracket" text,
	"voter_trust_tier" "trust_tier" NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "polls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"post_id" uuid NOT NULL,
	"type" "poll_type" NOT NULL,
	"question" text NOT NULL,
	"result_mode" "poll_result_mode" DEFAULT 'live' NOT NULL,
	"is_anonymous" boolean DEFAULT false NOT NULL,
	"closes_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"max_choices" integer,
	"min_trust_tier" "trust_tier" DEFAULT 'T1' NOT NULL,
	"min_account_age_days" integer DEFAULT 0 NOT NULL,
	"total_votes" integer DEFAULT 0 NOT NULL,
	"agent_total_votes" integer DEFAULT 0 NOT NULL,
	"is_daily_pulse" boolean DEFAULT false NOT NULL,
	"pulse_date" date,
	"voided" boolean DEFAULT false NOT NULL,
	"voided_by" uuid,
	"voided_reason" text,
	"ranking_cache" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stance_votes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"debate_id" uuid NOT NULL,
	"voter_id" uuid NOT NULL,
	"author_type" "author_type" NOT NULL,
	"phase" text NOT NULL,
	"stance_value" smallint NOT NULL,
	"side_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "poll_id" uuid;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "debate_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "platform_role" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_note_ratings" ADD CONSTRAINT "context_note_ratings_note_id_context_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."context_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_note_ratings" ADD CONSTRAINT "context_note_ratings_rater_id_users_id_fk" FOREIGN KEY ("rater_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_notes" ADD CONSTRAINT "context_notes_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_notes" ADD CONSTRAINT "context_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_pulse_questions" ADD CONSTRAINT "daily_pulse_questions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arguments" ADD CONSTRAINT "arguments_debate_id_debates_id_fk" FOREIGN KEY ("debate_id") REFERENCES "public"."debates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arguments" ADD CONSTRAINT "arguments_side_id_debate_sides_id_fk" FOREIGN KEY ("side_id") REFERENCES "public"."debate_sides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arguments" ADD CONSTRAINT "arguments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arguments" ADD CONSTRAINT "arguments_round_id_debate_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."debate_rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arguments" ADD CONSTRAINT "arguments_steelman_confirmed_by_users_id_fk" FOREIGN KEY ("steelman_confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arguments" ADD CONSTRAINT "arguments_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_challenges" ADD CONSTRAINT "debate_challenges_debate_id_debates_id_fk" FOREIGN KEY ("debate_id") REFERENCES "public"."debates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_challenges" ADD CONSTRAINT "debate_challenges_challenger_id_users_id_fk" FOREIGN KEY ("challenger_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_challenges" ADD CONSTRAINT "debate_challenges_challenged_id_users_id_fk" FOREIGN KEY ("challenged_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_participants" ADD CONSTRAINT "debate_participants_debate_id_debates_id_fk" FOREIGN KEY ("debate_id") REFERENCES "public"."debates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_participants" ADD CONSTRAINT "debate_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_participants" ADD CONSTRAINT "debate_participants_side_id_debate_sides_id_fk" FOREIGN KEY ("side_id") REFERENCES "public"."debate_sides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_rating_events" ADD CONSTRAINT "debate_rating_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_rating_events" ADD CONSTRAINT "debate_rating_events_debate_id_debates_id_fk" FOREIGN KEY ("debate_id") REFERENCES "public"."debates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_ratings" ADD CONSTRAINT "debate_ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_rounds" ADD CONSTRAINT "debate_rounds_debate_id_debates_id_fk" FOREIGN KEY ("debate_id") REFERENCES "public"."debates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_rounds" ADD CONSTRAINT "debate_rounds_side_id_debate_sides_id_fk" FOREIGN KEY ("side_id") REFERENCES "public"."debate_sides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_rounds" ADD CONSTRAINT "debate_rounds_turn_user_id_users_id_fk" FOREIGN KEY ("turn_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_sides" ADD CONSTRAINT "debate_sides_debate_id_debates_id_fk" FOREIGN KEY ("debate_id") REFERENCES "public"."debates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_judge_id_users_id_fk" FOREIGN KEY ("judge_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_links" ADD CONSTRAINT "evidence_links_argument_id_arguments_id_fk" FOREIGN KEY ("argument_id") REFERENCES "public"."arguments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_flags" ADD CONSTRAINT "poll_flags_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_flags" ADD CONSTRAINT "poll_flags_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_vote_choices" ADD CONSTRAINT "poll_vote_choices_poll_vote_id_poll_votes_id_fk" FOREIGN KEY ("poll_vote_id") REFERENCES "public"."poll_votes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_vote_choices" ADD CONSTRAINT "poll_vote_choices_option_id_poll_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."poll_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_voter_id_users_id_fk" FOREIGN KEY ("voter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_option_id_poll_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."poll_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stance_votes" ADD CONSTRAINT "stance_votes_debate_id_debates_id_fk" FOREIGN KEY ("debate_id") REFERENCES "public"."debates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stance_votes" ADD CONSTRAINT "stance_votes_voter_id_users_id_fk" FOREIGN KEY ("voter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stance_votes" ADD CONSTRAINT "stance_votes_side_id_debate_sides_id_fk" FOREIGN KEY ("side_id") REFERENCES "public"."debate_sides"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_target_idx" ON "audit_logs" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "context_notes_post_status_idx" ON "context_notes" USING btree ("post_id","status");--> statement-breakpoint
CREATE INDEX "context_notes_author_idx" ON "context_notes" USING btree ("author_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_pulse_questions_scheduled_unique" ON "daily_pulse_questions" USING btree ("scheduled_date") WHERE "daily_pulse_questions"."scheduled_date" is not null;--> statement-breakpoint
CREATE INDEX "daily_pulse_questions_unused_idx" ON "daily_pulse_questions" USING btree ("used_date","created_at");--> statement-breakpoint
CREATE INDEX "arguments_debate_side_idx" ON "arguments" USING btree ("debate_id","side_id","created_at");--> statement-breakpoint
CREATE INDEX "arguments_debate_score_idx" ON "arguments" USING btree ("debate_id","score");--> statement-breakpoint
CREATE INDEX "arguments_author_idx" ON "arguments" USING btree ("author_id","created_at");--> statement-breakpoint
CREATE INDEX "arguments_parent_idx" ON "arguments" USING btree ("parent_argument_id");--> statement-breakpoint
CREATE INDEX "debate_challenges_challenged_idx" ON "debate_challenges" USING btree ("challenged_id","status","created_at");--> statement-breakpoint
CREATE INDEX "debate_challenges_debate_idx" ON "debate_challenges" USING btree ("debate_id","created_at");--> statement-breakpoint
CREATE INDEX "debate_participants_user_idx" ON "debate_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "debate_rating_events_user_idx" ON "debate_rating_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "debate_rounds_debate_no_unique" ON "debate_rounds" USING btree ("debate_id","round_no");--> statement-breakpoint
CREATE INDEX "debate_rounds_deadline_idx" ON "debate_rounds" USING btree ("deadline_at") WHERE "debate_rounds"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "debate_sides_debate_key_unique" ON "debate_sides" USING btree ("debate_id","key");--> statement-breakpoint
CREATE INDEX "debate_sides_debate_idx" ON "debate_sides" USING btree ("debate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "debates_short_code_unique" ON "debates" USING btree ("short_code");--> statement-breakpoint
CREATE UNIQUE INDEX "debates_post_unique" ON "debates" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "debates_status_created_idx" ON "debates" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "debates_community_idx" ON "debates" USING btree ("community_id","created_at");--> statement-breakpoint
CREATE INDEX "debates_host_idx" ON "debates" USING btree ("host_id","created_at");--> statement-breakpoint
CREATE INDEX "evidence_links_argument_idx" ON "evidence_links" USING btree ("argument_id");--> statement-breakpoint
CREATE INDEX "poll_flags_status_idx" ON "poll_flags" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "poll_flags_poll_idx" ON "poll_flags" USING btree ("poll_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "poll_options_poll_position_unique" ON "poll_options" USING btree ("poll_id","position");--> statement-breakpoint
CREATE INDEX "poll_options_poll_idx" ON "poll_options" USING btree ("poll_id");--> statement-breakpoint
CREATE INDEX "poll_vote_audit_poll_idx" ON "poll_vote_audit" USING btree ("poll_id","created_at");--> statement-breakpoint
CREATE INDEX "poll_vote_audit_voter_idx" ON "poll_vote_audit" USING btree ("voter_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "poll_votes_poll_voter_unique" ON "poll_votes" USING btree ("poll_id","voter_id");--> statement-breakpoint
CREATE INDEX "poll_votes_poll_created_idx" ON "poll_votes" USING btree ("poll_id","created_at");--> statement-breakpoint
CREATE INDEX "poll_votes_voter_idx" ON "poll_votes" USING btree ("voter_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "polls_post_unique" ON "polls" USING btree ("post_id");--> statement-breakpoint
CREATE UNIQUE INDEX "polls_pulse_date_unique" ON "polls" USING btree ("pulse_date") WHERE "polls"."is_daily_pulse";--> statement-breakpoint
CREATE INDEX "polls_closes_idx" ON "polls" USING btree ("closes_at") WHERE "polls"."closed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "stance_votes_debate_voter_phase_unique" ON "stance_votes" USING btree ("debate_id","voter_id","phase");--> statement-breakpoint
CREATE INDEX "stance_votes_debate_phase_idx" ON "stance_votes" USING btree ("debate_id","phase");--> statement-breakpoint
CREATE INDEX "stance_votes_voter_idx" ON "stance_votes" USING btree ("voter_id");--> statement-breakpoint
-- Phase 3 hand-written additions (D-030): circular host FKs + integrity CHECKs
-- that drizzle-kit does not model from the schema file.
ALTER TABLE "posts" ADD CONSTRAINT "posts_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_debate_id_debates_id_fk" FOREIGN KEY ("debate_id") REFERENCES "public"."debates"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_winner_side_fk" FOREIGN KEY ("winner_side_id") REFERENCES "public"."debate_sides"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "debate_rounds" ADD CONSTRAINT "debate_rounds_argument_fk" FOREIGN KEY ("argument_id") REFERENCES "public"."arguments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "arguments" ADD CONSTRAINT "arguments_parent_fk" FOREIGN KEY ("parent_argument_id") REFERENCES "public"."arguments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;--> statement-breakpoint
-- At most one ballot shape per row; `multiple` ballots carry none of the
-- three (their picks live in poll_vote_choices) — service enforces presence.
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_ballot_shape_chk" CHECK (
  (option_id IS NOT NULL)::int + (ranking IS NOT NULL)::int + (slider_value IS NOT NULL)::int <= 1
);--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_slider_range_chk" CHECK (slider_value IS NULL OR slider_value BETWEEN -2 AND 2);--> statement-breakpoint
ALTER TABLE "stance_votes" ADD CONSTRAINT "stance_votes_phase_chk" CHECK (phase IN ('pre','post'));--> statement-breakpoint
ALTER TABLE "stance_votes" ADD CONSTRAINT "stance_votes_value_range_chk" CHECK (stance_value BETWEEN -2 AND 2);--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_question_len_chk" CHECK (char_length(question) BETWEEN 1 AND 200);--> statement-breakpoint
ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_text_len_chk" CHECK (char_length(text) BETWEEN 1 AND 80);--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_proposition_len_chk" CHECK (char_length(proposition) BETWEEN 1 AND 280);--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_char_limit_range_chk" CHECK (per_turn_char_limit BETWEEN 280 AND 10000);--> statement-breakpoint
ALTER TABLE "context_notes" ADD CONSTRAINT "context_notes_body_len_chk" CHECK (char_length(body) BETWEEN 1 AND 500);--> statement-breakpoint
CREATE INDEX "poll_votes_live_poll_idx" ON "poll_votes" USING btree ("poll_id") WHERE voided_at IS NULL;--> statement-breakpoint
CREATE INDEX "debates_source_article_idx" ON "debates" USING btree ("source_article_url") WHERE source_article_url IS NOT NULL;
