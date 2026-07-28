DROP INDEX "teachers_identifier_unique";--> statement-breakpoint
CREATE INDEX "teachers_identifier_idx" ON "teachers" USING btree ("identifier");