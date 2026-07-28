DROP INDEX "faq_entries_topic_idx";--> statement-breakpoint
ALTER TABLE "faq_entries" ADD COLUMN "sheet_row" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "faq_entries_topic_idx" ON "faq_entries" USING btree ("topic_code","active","sheet_row");