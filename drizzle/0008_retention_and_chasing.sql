ALTER TYPE "public"."delivery_state" ADD VALUE 'Sending' BEFORE 'Sent';--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "teacher_chased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "teacher_chase_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "telegram_username" text;--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN "privacy_accepted_case_days" integer;--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN "privacy_accepted_urgent_case_days" integer;--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN "privacy_accepted_message_days" integer;--> statement-breakpoint
CREATE INDEX "cases_retention_idx" ON "cases" USING btree ("closed_at","importance");--> statement-breakpoint
CREATE INDEX "cases_teacher_chase_idx" ON "cases" USING btree ("status","teacher_chased_at");