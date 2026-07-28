CREATE TABLE "processed_updates" (
	"update_id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "processed_updates_at_idx" ON "processed_updates" USING btree ("at");