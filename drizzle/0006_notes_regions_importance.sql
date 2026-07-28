CREATE TYPE "public"."case_importance" AS ENUM('Normal', 'Urgent', 'Critical');--> statement-breakpoint
CREATE TABLE "case_notes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_reference" text NOT NULL,
	"author_chat_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_notes_author_chat_id_digits" CHECK (author_chat_id ~ '^[0-9]+$')
);
--> statement-breakpoint
/*
 * The two role-enum changes, hand-written.
 *
 * drizzle-kit generated a DROP TYPE and a recreate for these. That is rejected
 * for two reasons. It is destructive, and every migration in this rebuild is
 * additive so that a rollback is a code deploy rather than a data recovery. And
 * it only appears to work because `staff` is empty: the recreate casts the
 * column with `USING role::staff_role`, and any existing 'Regional' row would
 * fail that cast, so the generated form is a migration that passes here and
 * breaks on a server with data.
 *
 * ADD VALUE and RENAME VALUE are both permitted inside a transaction on
 * PostgreSQL 12 and later, which matters because `src/db/migrate.ts` wraps each
 * migration in one. The restriction is that a value added this way cannot be
 * *used* in the same transaction — nothing here inserts a staff row, so it does
 * not apply. Do not add a seed row to this migration.
 *
 * BEFORE 'Support' so that `ORDER BY role` in an ad-hoc query sorts the way the
 * ladder reads. Ranking in the program is by index in STAFF_ROLE_ORDER, not by
 * the enum's internal order, so this is tidiness rather than correctness.
 */
ALTER TYPE "public"."staff_role" ADD VALUE 'Observer' BEFORE 'Support';--> statement-breakpoint
ALTER TYPE "public"."staff_role" RENAME VALUE 'Regional' TO 'Lead';--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "importance" "case_importance" DEFAULT 'Normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "snoozed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN "region_override" text;--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN "region_set_by" text;--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN "region_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN "region_flagged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "case_notes" ADD CONSTRAINT "case_notes_case_reference_cases_reference_fk" FOREIGN KEY ("case_reference") REFERENCES "public"."cases"("reference") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_notes_case_idx" ON "case_notes" USING btree ("case_reference","created_at");--> statement-breakpoint
CREATE INDEX "cases_chasing_idx" ON "cases" USING btree ("status","due_at","snoozed_until");