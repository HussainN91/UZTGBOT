ALTER TABLE "cases" ADD COLUMN "urgent_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "urgent_confirmed_by" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "urgent_confirmed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "cases_urgent_pending_idx" ON "cases" USING btree ("urgent_requested_at","urgent_confirmed_at");