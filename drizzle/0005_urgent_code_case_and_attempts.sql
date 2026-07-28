CREATE TABLE "urgent_code_attempts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "urgent_code_attempts_chat_id_digits" CHECK (chat_id ~ '^[0-9]+$')
);
--> statement-breakpoint
ALTER TABLE "urgent_codes" ADD COLUMN "case_reference" text;--> statement-breakpoint
CREATE INDEX "urgent_code_attempts_chat_idx" ON "urgent_code_attempts" USING btree ("chat_id","at");--> statement-breakpoint
CREATE INDEX "urgent_codes_stranded_idx" ON "urgent_codes" USING btree ("used_at","case_reference");