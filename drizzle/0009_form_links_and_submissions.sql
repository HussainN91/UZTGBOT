CREATE TABLE "form_links" (
	"type" text PRIMARY KEY NOT NULL,
	"sheet_row" integer DEFAULT 0 NOT NULL,
	"button_text" text NOT NULL,
	"url" text NOT NULL,
	"responses_tab" text,
	"active" boolean DEFAULT true NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_submissions" (
	"form_type" text NOT NULL,
	"sheet_row" integer NOT NULL,
	"outcome" text NOT NULL,
	"case_reference" text,
	"submitter_email" text,
	"submitted_at" timestamp with time zone,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_submissions_form_type_sheet_row_pk" PRIMARY KEY("form_type","sheet_row")
);
--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_case_reference_cases_reference_fk" FOREIGN KEY ("case_reference") REFERENCES "public"."cases"("reference") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_links_active_idx" ON "form_links" USING btree ("active","sheet_row");--> statement-breakpoint
CREATE INDEX "form_submissions_case_idx" ON "form_submissions" USING btree ("case_reference");