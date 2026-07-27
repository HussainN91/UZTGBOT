CREATE TYPE "public"."announcement_status" AS ENUM('Draft', 'Queued', 'Sending', 'Sent', 'Failed', 'Cancelled');--> statement-breakpoint
CREATE TYPE "public"."case_status" AS ENUM('New', 'Received', 'Under review', 'Action required', 'Escalated', 'Completed', 'Closed', 'Duplicate');--> statement-breakpoint
CREATE TYPE "public"."delivery_state" AS ENUM('Pending', 'Sent', 'Failed', 'Skipped');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('Support', 'Regional', 'Program', 'System');--> statement-breakpoint
CREATE TYPE "public"."verification_state" AS ENUM('Unverified', 'AwaitingIdentifier', 'Verified', 'Revoked');--> statement-breakpoint
CREATE TABLE "announcement_recipients" (
	"announcement_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"state" "delivery_state" DEFAULT 'Pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	CONSTRAINT "announcement_recipients_announcement_id_chat_id_pk" PRIMARY KEY("announcement_id","chat_id")
);
--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" text NOT NULL,
	"audience" text DEFAULT 'all' NOT NULL,
	"status" "announcement_status" DEFAULT 'Draft' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"subject" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_sequences" (
	"prefix" text NOT NULL,
	"year" integer NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "case_sequences_prefix_year_pk" PRIMARY KEY("prefix","year")
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"reference" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"teacher_chat_id" text NOT NULL,
	"status" "case_status" DEFAULT 'New' NOT NULL,
	"owner" text,
	"detail" text DEFAULT '' NOT NULL,
	"public_update" text DEFAULT '' NOT NULL,
	"last_actor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "cases_teacher_chat_id_digits" CHECK (teacher_chat_id ~ '^[0-9]+$')
);
--> statement-breakpoint
CREATE TABLE "conversation_states" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "conversation_states_chat_id_digits" CHECK (chat_id ~ '^[0-9]+$')
);
--> statement-breakpoint
CREATE TABLE "faq_entries" (
	"code" text PRIMARY KEY NOT NULL,
	"topic_code" text NOT NULL,
	"button_text" text NOT NULL,
	"keywords" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"official_answer" text NOT NULL,
	"language" text DEFAULT 'EN' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_approved_by" text,
	"last_approved_date" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"job_name" text PRIMARY KEY NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"expected_interval_seconds" integer NOT NULL,
	"alerted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"chat_id" text NOT NULL,
	"action" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roster_entries" (
	"identifier" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"region" text,
	"active" boolean DEFAULT true NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"telegram_id" text PRIMARY KEY NOT NULL,
	"name" text,
	"role" "staff_role" DEFAULT 'Support' NOT NULL,
	"queue" text DEFAULT 'All' NOT NULL,
	"regions" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"added_by" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_telegram_id_digits" CHECK (telegram_id ~ '^[0-9]+$')
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text NOT NULL,
	"rows_seen" integer DEFAULT 0 NOT NULL,
	"rows_upserted" integer DEFAULT 0 NOT NULL,
	"rows_deactivated" integer DEFAULT 0 NOT NULL,
	"rows_rejected" integer DEFAULT 0 NOT NULL,
	"rejections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message" text
);
--> statement-breakpoint
CREATE TABLE "teachers" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"verification_state" "verification_state" DEFAULT 'Unverified' NOT NULL,
	"identifier" text,
	"name" text,
	"region" text,
	"language" text DEFAULT 'EN' NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"privacy_notice_accepted_at" timestamp with time zone,
	CONSTRAINT "teachers_chat_id_digits" CHECK (chat_id ~ '^[0-9]+$')
);
--> statement-breakpoint
CREATE TABLE "urgent_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"issued_by" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by" text
);
--> statement-breakpoint
ALTER TABLE "announcement_recipients" ADD CONSTRAINT "announcement_recipients_announcement_id_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_teacher_chat_id_teachers_chat_id_fk" FOREIGN KEY ("teacher_chat_id") REFERENCES "public"."teachers"("chat_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_owner_staff_telegram_id_fk" FOREIGN KEY ("owner") REFERENCES "public"."staff"("telegram_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teachers" ADD CONSTRAINT "teachers_identifier_roster_entries_identifier_fk" FOREIGN KEY ("identifier") REFERENCES "public"."roster_entries"("identifier") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcement_recipients_pending_idx" ON "announcement_recipients" USING btree ("announcement_id","state");--> statement-breakpoint
CREATE INDEX "announcements_status_idx" ON "announcements" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action","at");--> statement-breakpoint
CREATE INDEX "cases_dedup_idx" ON "cases" USING btree ("teacher_chat_id","category","status","created_at");--> statement-breakpoint
CREATE INDEX "cases_status_idx" ON "cases" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "cases_owner_idx" ON "cases" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "conversation_states_expiry_idx" ON "conversation_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "faq_entries_topic_idx" ON "faq_entries" USING btree ("topic_code","active");--> statement-breakpoint
CREATE INDEX "faq_entries_active_idx" ON "faq_entries" USING btree ("active");--> statement-breakpoint
CREATE INDEX "job_runs_success_idx" ON "job_runs" USING btree ("last_success_at");--> statement-breakpoint
CREATE INDEX "messages_at_idx" ON "messages" USING btree ("at");--> statement-breakpoint
CREATE INDEX "messages_chat_idx" ON "messages" USING btree ("chat_id","at");--> statement-breakpoint
CREATE INDEX "messages_action_idx" ON "messages" USING btree ("action","at");--> statement-breakpoint
CREATE INDEX "roster_entries_active_idx" ON "roster_entries" USING btree ("active");--> statement-breakpoint
CREATE INDEX "staff_active_idx" ON "staff" USING btree ("active","role");--> statement-breakpoint
CREATE INDEX "sync_runs_source_idx" ON "sync_runs" USING btree ("source","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "teachers_identifier_unique" ON "teachers" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "teachers_state_idx" ON "teachers" USING btree ("verification_state");--> statement-breakpoint
CREATE INDEX "urgent_codes_expiry_idx" ON "urgent_codes" USING btree ("expires_at","used_at");