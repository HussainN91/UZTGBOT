ALTER TABLE "cases" ADD COLUMN "form_type" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "awaiting_form" boolean DEFAULT false NOT NULL;