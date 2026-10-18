ALTER TYPE "public"."publication_status" ADD VALUE 'scheduled' BEFORE 'publishing';--> statement-breakpoint
ALTER TYPE "public"."story_status" ADD VALUE 'scheduled' BEFORE 'publishing';--> statement-breakpoint
CREATE TABLE "user_writing_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"preferred_name" text,
	"bio" text,
	"occupation" text,
	"industry" text,
	"current_activities" text,
	"interests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"goals" text,
	"target_audience" text,
	"preferred_language" text DEFAULT 'id_casual' NOT NULL,
	"tone" text,
	"writing_style" text,
	"formality_level" text,
	"sentence_length" text,
	"slang_preference" text,
	"humor_preference" text,
	"emoji_preference" text,
	"storytelling_perspective" text,
	"cta_style" text,
	"favorite_expressions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"avoid_expressions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"writing_examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"factual_boundaries" text,
	"forbidden_topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"personalization_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "publications_active_unique";--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "onboarding_completed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_writing_profiles" ADD CONSTRAINT "user_writing_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;