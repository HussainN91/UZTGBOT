CREATE TYPE "public"."identity_dispute_claim" AS ENUM('Mine', 'NotMine');--> statement-breakpoint
CREATE TYPE "public"."identity_dispute_state" AS ENUM('Open', 'Claimed', 'WithSystem', 'Resolved');--> statement-breakpoint
CREATE TABLE "identity_dispute_parties" (
	"dispute_id" bigint NOT NULL,
	"chat_id" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim" "identity_dispute_claim",
	"claimed_at" timestamp with time zone,
	CONSTRAINT "identity_dispute_parties_dispute_id_chat_id_pk" PRIMARY KEY("dispute_id","chat_id"),
	CONSTRAINT "identity_dispute_parties_chat_id_digits" CHECK (chat_id ~ '^[0-9]+$')
);
--> statement-breakpoint
CREATE TABLE "identity_disputes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"state" "identity_dispute_state" DEFAULT 'Open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"system_notified_at" timestamp with time zone,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"kept_chat_id" text,
	"outcome" text
);
--> statement-breakpoint
ALTER TABLE "identity_dispute_parties" ADD CONSTRAINT "identity_dispute_parties_dispute_id_identity_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."identity_disputes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_disputes_one_open_idx" ON "identity_disputes" USING btree ("identifier") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX "identity_disputes_state_idx" ON "identity_disputes" USING btree ("state");