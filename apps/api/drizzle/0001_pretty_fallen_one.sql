CREATE TABLE "email_change_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"new_email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_mentions" (
	"post_id" uuid NOT NULL,
	"mentioned_user_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_mentions_post_id_mentioned_user_id_position_pk" PRIMARY KEY("post_id","mentioned_user_id","position")
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "group_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "preferences" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "font_scale" double precision DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "high_contrast" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "reduced_motion" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "onboarding_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_change_requests" ADD CONSTRAINT "email_change_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_mentions" ADD CONSTRAINT "post_mentions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_mentions" ADD CONSTRAINT "post_mentions_mentioned_user_id_users_id_fk" FOREIGN KEY ("mentioned_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_change_requests_token_unique" ON "email_change_requests" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "email_change_requests_user_idx" ON "email_change_requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "post_mentions_user_idx" ON "post_mentions" USING btree ("mentioned_user_id","created_at");--> statement-breakpoint
-- ─── Hand-written (Phase 1 round 2, search): pg_trgm + post FTS ───────────
-- drizzle-kit does not model extensions, generated columns or expression
-- indexes; these live outside schema.ts on purpose (queries use raw SQL).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "search_vector" tsvector
	GENERATED ALWAYS AS (
		setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
		setweight(to_tsvector('english', coalesce("body_md", '')), 'B')
	) STORED;--> statement-breakpoint
CREATE INDEX "posts_search_vector_gin" ON "posts" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "users_handle_trgm" ON "users" USING gin ("handle" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "profiles_display_name_trgm" ON "profiles" USING gin ("display_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "communities_slug_trgm" ON "communities" USING gin ("slug" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "communities_name_trgm" ON "communities" USING gin ("name" gin_trgm_ops);
